# Live-Vault Adoption & Continuous Sync — Implementation Plan (Atlas #60, sub-projects 60-A + 60-B)

> **For agentic workers:** REQUIRED SUB-SKILL: use `superpowers:subagent-driven-development` (recommended) or `superpowers:executing-plans` to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. Read the **spec** (`docs/specs/2026-07-19-live-vault-adoption-sync-spec.md`) alongside this plan — the spec is the normative SSOT; this plan is how it gets built.

**Goal:** Adopt the live `Vaults/main-vault` under a broker-owned protected ref `refs/atlas/main` (leaving `refs/heads/main` free for its three uncoordinated writers), and add a fail-closed, O(delta) continuous `brain sync` that absorbs upstream commits, re-indexes only the changed notes, and runs on a launchd timer.

**Architecture:** One-way absorb. `refs/heads/main` is upstream (never written by Atlas); `refs/atlas/main` is Atlas's broker-owned canonical mirror. A durable `sync_cursors` row holds the last fully-processed upstream OID. Each cycle diffs `cursor..refs/heads/main` over the note globs, feeds each changed path through the **unmodified** `captureSource` scan-before-persist pipeline, accumulates one ChangePlan, does **one** broker integrate of `refs/atlas/main`, folds the `notes` projection for exactly the changed notes, and enqueues **one** `index:reconcile` job that re-embeds only those notes. A launchd wrapper runs `brain sync --json` then `brain jobs run --workflow index:reconcile --json`.

**Tech Stack:** pnpm/TypeScript monorepo (strict/ESM/NodeNext), Node ≥ 24, pnpm 11.15.0, vitest, better-sqlite3 (SQLite), LanceDB, git plumbing via `@atlas/git`, privilege-separated brokers (`atlas-broker`/`atlas-egress`), launchd (macOS).

---

## Global Constraints

Every task's requirements implicitly include this section. Values copied verbatim from the spec / repo constitution.

- **Security is production-grade, non-negotiable.** Scan-before-persist on every absorbed byte (unmodified `captureSource` preflight); `refs/atlas/main` broker-owned + protected; `refs/heads/main` **never written by any Atlas identity** (asserted E2E — the amended #60 gate); `@atlas/git`'s `runGit` stays unexported; `atlas-egress` stays excluded from the `atlas-git` group (D18); CLI runs unprivileged `atlas-agent`, network-denied at the UID (D17).
- **Playground on the user-count dimension:** one adopted vault, no HA, no multi-tenant, no canary/soak/gradual rollout. Merge to main when the PR is green. `version 0.0.0`, `private: true`.
- **Exit codes cap at 6** (7 only from the `jobs run` batch aggregate). `sync` may emit `0/2/3/4/6`; `sync status` emits `0/2`; `sync reset` emits `0/2/6`. Single-error envelope: `{ "error": { "code", "message", "retryable"?, "retryAfterMs"? } }`.
- **Privileged mutations are broker-authorized**, never `--yes`: `--export-challenge` → sign → `--authorization <path>`. `sync`/`sync status` are non-privileged (`shared`); `sync reset` is `privileged`.
- **Deletions map to `ProposeArchive`** (non-destructive), never `ProposeDelete`/`erase`.
- **Trust:** adopted content is absorbed `untrusted` (fail-closed floor). Adoption confers no elevated trust.
- **CLI-contract workflow is drift-proof:** command membership lives only in `docs/specs/cli-contract/commands.json`; add row + `cli-surface.fixture.txt` line + `<name>.schema.json` (with its `x-atlas-contract` block) + `pnpm contract:write`; the lint/registration gates enforce the rest.
- **Commits authored `Aryeh Stark <aryeh@21stark.com>`.** Branch + PR per phase; every review finding posted on the PR. Update the relevant `CLAUDE.md`/`README`/`docs` in the **same** change as any behavior/env/command change.
- **TypeScript strict / ESM / NodeNext** (`noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`, `verbatimModuleSyntax`, `isolatedModules`). Compile with `tsc`. Bash: `set -euo pipefail`.
- **Build/test gates:** `pnpm -r build`, `pnpm -r test`, `pnpm contract:check` (== `node tools/gen-cli-contract.ts --check`), `pnpm failpoints:check`. CI matrix ubuntu + macos-15, Node 26, `ATLAS_PROVISIONED=1`.

---

## §0 — SETTLED DECISION (the gate): Upstream-divergence policy — OQ#5

**This is the first thing settled and it gates every sync phase.** The spec's delta model assumes `refs/heads/main` stays a **descendant** of `last_absorbed_oid`. main-vault has three uncoordinated writers (brain-hub sync, Obsidian, direct GitHub pushes) that can rebase/force-push, and an upstream `git gc` can make the cursor OID unresolvable. `git diff cursor..head`, `behindBy`, and continuation are all **undefined** on divergence. A policy must be chosen before any sync code is written.

### Decision: **REJECT** (fail-closed halt) as the automatic policy, with an operator-authorized **RESET-via-tree-reconcile** recovery command (`sync reset`).

On detecting a non-ancestral or unresolvable cursor, `sync` **halts before computing any diff**, advances nothing, exits **`2`** with error code `diverged:non-ancestral` or `diverged:cursor-unreachable`, and `sync status` surfaces the condition in a `divergence` field. Re-convergence is never automatic — it requires an operator-triggered, broker-authorized `sync reset` (detailed below).

### Why REJECT over RESET-automatic and RECONCILE-automatic

| Policy (automatic) | Correctness story for `refs/atlas/main` | Verdict |
|---|---|---|
| **RECONCILE** (auto merge-base symmetric diff) | **Undefined in the `git gc` case** — no merge-base exists when the cursor OID is unreachable, so it cannot be the universal answer. Its symmetric half requires *un-absorbing* rewritten-away history, which collides with the spec's hard boundary that **sync never drives `erase`/`ProposeDelete`**. High machinery for a single-user playground. | Rejected as *automatic* default |
| **RESET** (auto re-baseline cursor to head, accept gap) | Simple, but **silently** leaves `refs/atlas/main` diverged from the upstream it claims to mirror: content rewritten away upstream stays retrievable in Atlas, the commits between old cursor and new head are **never absorbed**, and the operator gets **no signal**. Silent divergence of an auditable mirror is the single worst outcome for a security-first system. | Rejected as *automatic* default |
| **REJECT** (halt, exit non-zero, require operator action) | Fail-closed, no silent divergence, operator-gated ambiguity — **exactly Atlas's ethos**. Structural precedent is `backup-unhealthy`: a durable-state precondition failure that halts the cycle, is non-retryable, and clears only on operator action. Needs an authorized escape hatch so the operator is never wedged. | **Chosen** |

REJECT with no recovery would wedge the operator forever, so it ships **with** `sync reset`. The recovery is deliberately **RESET-via-tree-reconcile, not history-reconcile**: it diffs `refs/atlas/main`'s tree against the current `refs/heads/main` tree and absorbs the net difference (archive vanished, capture present) — which re-converges content correctly, reuses the existing integrate/fold machinery (no commit surgery), and needs no merge-base (so it works even when the cursor is gc'd-unreachable). It is `privileged` because it re-baselines a protected-ref cursor and accepts a history gap — precisely a "privileged mutation, never `--yes`" per the security model — and it emits a broker-signed `run.*` audit event recording *that* a history gap was accepted and *when*.

### Detection design (the pre-diff guard)

Runs at **cycle step 2**, after reading the `sync_cursors` row and snapshotting `upstreamHead = readRef("refs/heads/main")`, **before** computing `behindBy` or any `git diff` — because both are undefined on divergence. Uses existing `@atlas/git` `Repo` helpers (verified): `readRef(name)` shells `git rev-parse --verify --quiet <name>^{commit}` (resolves-or-`null`); `isAncestor(ancestor, descendant)` shells `git merge-base --is-ancestor`.

```
last = row.last_absorbed_oid
if (last === null) → zero-state, NOT divergence (first absorb against empty tree)   // normal
else:
  resolved = await repo.readRef(last)          // OID-as-commitish; null ⇒ unreachable (gc)
  if (resolved === null)             → HALT diverged:cursor-unreachable  (exit 2)
  else if (!(await repo.isAncestor(last, upstreamHead)))
                                     → HALT diverged:non-ancestral       (exit 2)
  // else: ancestral ⇒ proceed to behindBy / diff as normal
```

- Both halts: **cursor unadvanced, no run opened, no ledger write, no audit append**. Emits the **error envelope** (not the success envelope — this is not a quarantine outcome).
- Exit **`2`** (not `6`): `6` is already the success-envelope "≥1 attributable path quarantined, cursor advanced" outcome; overloading `6` with an error-envelope hard-halt muddies the contract. Exit `2` is the existing "vault-state blocks this run, fix it" bucket (`config`/`vault`/`backup-unhealthy`), and `backup-unhealthy` is the exact structural precedent (non-retryable exit-2 precondition halt). `retryable: false` — retrying an unattended cycle cannot fix divergence; it needs `sync reset`.

### Contract surfaces this decision adds

- **Error codes** (added to the `sync` error catalog + its `x-atlas-contract.errorCodes`): `diverged:non-ancestral` (exit 2, non-retryable), `diverged:cursor-unreachable` (exit 2, non-retryable).
- **`sync status` gains a `divergence` field** (required object, derived live at read time — no new column):

  | field | type | notes |
  |---|---|---|
  | `divergence.state` | `enum` | `"ok" \| "non-ancestral" \| "cursor-unreachable"` |
  | `divergence.cursorOid` | `string \| null` | the stuck cursor OID (null at zero-state / when `ok` with null cursor) |
  | `divergence.upstreamHead` | `string` | current `refs/heads/main` OID |

  And **`behindBy` becomes `integer | null`** — `null` whenever `divergence.state != "ok"` (the count is undefined across a divergence). At zero-state (`last_absorbed_oid == null`) `divergence.state = "ok"` and `behindBy` = full commit count to the empty tree, exactly as the spec pins it.
- **New command `sync reset`** (privileged; details in Phase 5).

### The force-push / gc tests (added to the test plan)

- *Force-push makes upstream non-ancestral → REJECT.* Fixture: absorb a cycle (cursor at C). Force-push `refs/heads/main` to a rewritten history H' that does **not** contain C. Run `sync`; assert exit `2`, error `diverged:non-ancestral`, cursor **unchanged**, `refs/atlas/main` **unmoved**, no `run.*` events. `sync status` reports `divergence.state: "non-ancestral"`, `behindBy: null`. Break: sync computes `git diff C..H'` and absorbs garbage / advances the cursor across a history it never saw.
- *gc'd cursor is unreachable → REJECT.* Absorb a cycle (cursor at C); delete C from upstream reachability and `git gc --prune=now` so C no longer resolves. Run `sync`; assert exit `2`, error `diverged:cursor-unreachable`, cursor unchanged, `sync status.divergence.state: "cursor-unreachable"`, `behindBy: null`. Break: `readRef` returns non-null / sync throws an unhandled error instead of the typed halt.
- *`sync reset` re-converges after divergence.* After either halt above, run `sync reset --export-challenge` → sign → `sync reset --authorization <path>`; assert `refs/atlas/main`'s tree now equals the current upstream tree over the note globs, notes present only in the old `refs/atlas/main` are `archived` (chunks dropped), the cursor is re-baselined to head, `divergence.state` returns to `ok`, and a broker-signed `run.*` audit event records the reset. Then a following `sync` is a `behindBy == 0` no-op. Break: reset leaves stale notes active, or advances the cursor without re-converging the tree, or runs without authorization.

---

## §0.1 — Resolution of the other open questions

- **OQ#1 (`ATLAS_EGRESS_CAPABILITY_KEY` custody under launchd).** **Resolved to the spec's default, implemented in Phase 6:** Keychain-fetch-at-job-start under the `atlas-agent` identity (`security find-generic-password`), never in the plist `EnvironmentVariables`, fail-closed if absent/locked, operator-triggered rotation across the two custody points, keychain-unlock provisioning prerequisite that **gates enabling** `com.atlas.sync.plist`. **Residual explicitly deferred with owner:** (a) upgrade to a broker-mediated per-run capability handoff (no standing agent-side secret) and (b) the fully-headless (logged-out) keychain-unlock story — **owner: operator; deferred to a follow-on hardening issue; the daemon stays disabled for unattended/logged-out sessions until (b) is settled.** Phase 6 ships the interactive-session posture only.
- **OQ#4 (trust read-surface defect, `source.ts:40` hardcodes `untrusted`/`history:[]`).** **Split out, not fixed here.** It does not weaken adoption (adopted content is `untrusted` regardless), and bundling a trust-projection fix would blow the 2-round review cap. **Tracked as atlas #218; owner: operator.** This plan touches no trust read path. (If #218 lands before Phase 6, no conflict — the surfaces are disjoint.)
- **OQ#2 (where `refs/atlas/main` lives).** **Decided for the plan: in the main-vault repo itself** (one `.git`, a broker-owned ref alongside the live writers' `refs/heads/main`). Simplest, and the broker's protected-ref machinery already operates per-repo. The bare-mirror variant (stronger isolation, extra fetch + second object store) is not built; the design does not preclude it later.
- **OQ#3 (cadence).** **300 s `StartInterval`** (spec default). Operator-tunable in the plist; no code depends on the number.
- **OQ#6 (60-C/D/E deferral).** Sequenced at the end of this plan.

---

## §0.2 — Spec ↔ code reconciliation (read before Phase 1 — three material deltas)

A seam audit of **this worktree** found three places where reality differs from the spec's optimistic framing. Implementers must not be blindsided.

1. **PR #216 is NOT in this worktree.** There is no `apps/cli/src/commands/job-handlers.ts`; `JOB_HANDLERS` is a plain empty map (`apps/cli/src/commands/jobs.ts:48-53`), the only registration is the env-gated test handler (`jobs.ts:425`), and there is **no job-kind completeness gate** (the existing `apps/cli/test/command-registration.test.ts` gates *CLI commands*, not job kinds). **#216 is a hard prerequisite for Phase 3.** Before Phase 3, rebase this work onto a `main` that includes #216 (registry population + completeness gate). Phase 3's tasks are written against the #216 shape; a fallback for the current shape is noted inline.
2. **The canonical ref is NOT config-driven.** `DEFAULT_PROTECTED_REFS.canonical = "refs/heads/main"` (`packages/broker/src/keys.ts:79-82`) and `DEFAULT_CANONICAL_REF = "refs/heads/main"` is duplicated across `apps/cli/src/ingest/capture.ts:76`, `workflows/refresh.ts:46`, `workflows/synthesis.ts:203`, `workflows/approve-run.ts:21`. Adoption is therefore **not pure "config + provisioning"** — Phase 1 includes a **contained refactor** to make the canonical ref configurable and thread `refs/atlas/main` through the broker's `ProtectedRefs` and those call sites. The spec's "enabling fact" (`foldProvenanceFromCanonical` already takes the ref as a param) holds and is leveraged, but it is only one of the sites.
3. **Type/name drift** (use the real names): the index reconcile deps type is **`IndexDeps`** (not `ReconcileDeps`); `noteFences(store)` is **private** in `apps/cli/src/commands/index-ops.ts:71` (must be exported / a filtered helper added); `foldProvenanceFromCanonical`'s third param is **`ref`**; there is **no `JobKind` enum** (`workflow` is a free `string`); there is **no name-status diff helper on the agent-side `Repo`** (Phase 4 adds one, mirroring `BrokerGit.changedPathsInRange`); there is **no note-glob config** (globs today = a hardcoded `.md` filter; Phase 1 adds a `vault.note_globs` config defaulting to `["**/*.md"]`). Also: the machine-checked `PRIVILEGE` enum is exactly `["shared","privileged"]` (`tools/cli-contract.ts:23`) — the spec's informal "standard"/"readonly" both map to **`shared`**.

---

## Phase 1 — 60-A: Adoption (config-driven canonical ref, `refs/atlas/main`, `sync_cursors` migration + seed)

**Deployable slice:** main-vault is adopted — `vault.path` repointed, the canonical ref is config-driven and set to `refs/atlas/main` for this vault, the broker protects `refs/atlas/main`, the `sync_cursors` table exists (excluded from `db rebuild`), and its row is seeded at adoption. No `sync` command yet; existing capture/workflow behavior is byte-unchanged for the default `refs/heads/main` config.

**Files:**
- Modify: `apps/cli/src/config/schema.ts` (add `git.canonical_ref`, `vault.note_globs`)
- Modify: `packages/broker/src/keys.ts` (make `ProtectedRefs.canonical` come from config; keep `DEFAULT_PROTECTED_REFS` as the default)
- Modify: `apps/cli/src/ingest/capture.ts:76`, `apps/cli/src/workflows/refresh.ts:46`, `apps/cli/src/workflows/synthesis.ts:203`, `apps/cli/src/workflows/approve-run.ts:21` (consume the config canonical ref instead of the hardcoded constant)
- Create: `packages/sqlite-store/migrations/0012_sync_cursors.ts`
- Modify: `packages/sqlite-store/src/index.ts` (re-export the migration)
- Modify: `apps/cli/src/commands/store-open.ts` (register `0012` in `registerFeatureMigrations` before `store.migrate()`)
- Create: `apps/cli/src/sync/seed.ts` (seed the `sync_cursors` row at adoption)
- Create: `provisioning/adopt-vault.sh` (executable bootstrap: broker-create `refs/atlas/main` at an empty-tree baseline, seed the cursor, validate both refs, fail closed)
- Modify: `provisioning/` docs + `apps/cli/CLAUDE.md` + `packages/sqlite-store/CLAUDE.md` + `docs/install.md`
- Test: `apps/cli/test/config-canonical-ref.test.ts`, `packages/sqlite-store/test/migrate-0012-sync-cursors.test.ts`, `packages/sqlite-store/test/rebuild-preserves-sync-cursors.test.ts`, `apps/cli/test/sync-seed.test.ts`

**Interfaces:**
- Produces: `git.canonical_ref: string` (default `"refs/heads/main"`) and `vault.note_globs: string[]` (default `["**/*.md"]`) in `AtlasConfig`; the `sync_cursors` table (schema below); `seedSyncCursor(store, { sourceId, upstreamRef, now }): void`.
- Consumes: `VaultConfig` (`schema.ts:18`), `AtlasConfigSchema` (`schema.ts:216-231`), `DEFAULT_PROTECTED_REFS` (`keys.ts:79`), `runMigrations`/`Migration`/`migrationChecksum` (`packages/sqlite-store/src/migrate.ts:28,98,50`), `registerFeatureMigrations` (`apps/cli/src/commands/store-open.ts`).

`sync_cursors` DDL (verbatim, `STRICT`):

```sql
CREATE TABLE sync_cursors (
  source_id           TEXT PRIMARY KEY,
  upstream_ref        TEXT NOT NULL,
  last_absorbed_oid   TEXT,
  last_synced_at      TEXT NOT NULL,
  cycle_seq           INTEGER NOT NULL DEFAULT 0,
  pending_quarantine  TEXT NOT NULL DEFAULT '[]'
) STRICT;
```

### Task 1.1 — Config: configurable canonical ref + note globs

- [ ] **Step 1: Write the failing test** — `apps/cli/test/config-canonical-ref.test.ts`

```ts
import { describe, it, expect } from "vitest";
import { AtlasConfigSchema } from "../src/config/schema.js";

describe("config: canonical ref + note globs", () => {
  it("defaults canonical_ref to refs/heads/main and note_globs to **/*.md", () => {
    const cfg = AtlasConfigSchema.parse(minimalConfigFixture());
    expect(cfg.git.canonical_ref).toBe("refs/heads/main");
    expect(cfg.vault.note_globs).toEqual(["**/*.md"]);
  });

  it("accepts an adopted-vault canonical ref refs/atlas/main", () => {
    const raw = minimalConfigFixture();
    raw.git.canonical_ref = "refs/atlas/main";
    const cfg = AtlasConfigSchema.parse(raw);
    expect(cfg.git.canonical_ref).toBe("refs/atlas/main");
  });

  it("rejects an empty canonical_ref", () => {
    const raw = minimalConfigFixture();
    raw.git.canonical_ref = "";
    expect(() => AtlasConfigSchema.parse(raw)).toThrow();
  });

  it("rejects a non-fully-qualified or audit/trust-colliding canonical_ref", () => {
    for (const bad of ["main", "refs/audit/runs", "refs/trust/ledger"]) {
      const raw = minimalConfigFixture();
      raw.git.canonical_ref = bad;
      expect(() => AtlasConfigSchema.parse(raw)).toThrow();
    }
  });
});
```
(`minimalConfigFixture()` — reuse the existing config test fixture helper in `apps/cli/test/`; if none, build the 12-section object inline from `schema.ts:216-231`.)

- [ ] **Step 2: Run — expect FAIL** (`git.canonical_ref` undefined). `pnpm --filter @atlas/cli test config-canonical-ref`
- [ ] **Step 3: Implement** — in `apps/cli/src/config/schema.ts`, add to `GitConfig` (`:94-100`): `canonical_ref: z.string().min(1).refine((r) => r.startsWith("refs/") && r !== "refs/audit/runs" && r !== "refs/trust/ledger", "canonical_ref must be a fully-qualified ref that does not collide with the audit/trust refs").default("refs/heads/main")`. Add to `VaultConfig` (`:18-22`): `note_globs: z.array(z.string().min(1)).min(1).default(["**/*.md"])`.
- [ ] **Step 4: Run — expect PASS.**
- [ ] **Step 5: Commit** — `feat(config): configurable canonical ref + note globs for vault adoption`

### Task 1.2 — Thread the config canonical ref through the broker + call sites

- [ ] **Step 1: Write the failing test** — `apps/cli/test/config-canonical-ref.test.ts` (append)

```ts
import { protectedRefsFor } from "../src/config/canonical-ref.js";

it("protectedRefsFor overrides only the canonical ref, preserving audit/trust", () => {
  const refs = protectedRefsFor("refs/atlas/main");
  expect(refs.canonical).toBe("refs/atlas/main");
  expect(refs.audit).toBe("refs/audit/runs");
  expect(refs.trust).toBe("refs/trust/ledger");
});
```

- [ ] **Step 2: Run — expect FAIL** (module missing).
- [ ] **Step 3: Implement** — create `apps/cli/src/config/canonical-ref.ts`:

```ts
import { DEFAULT_PROTECTED_REFS, type ProtectedRefs } from "@atlas/broker";

/** Build the broker's protected-ref set for a given canonical ref, preserving audit/trust. */
export function protectedRefsFor(canonicalRef: string): ProtectedRefs {
  return { ...DEFAULT_PROTECTED_REFS, canonical: canonicalRef };
}
```
Export `ProtectedRefs` from `@atlas/broker`'s barrel if not already. Then replace each hardcoded `DEFAULT_CANONICAL_REF` read in `capture.ts:76`, `refresh.ts:46`, `synthesis.ts:203`, `approve-run.ts:21` with the resolved `config.git.canonical_ref` (thread it in via the existing deps/config object each site already receives — do **not** re-import the constant). Where the broker `BrokerService` is constructed, pass `refs: protectedRefsFor(config.git.canonical_ref)` instead of the default. Keep `DEFAULT_CANONICAL_REF` as the *fallback default* only.

- [ ] **Step 4: Run the full CLI + broker suites — expect PASS, no regressions** (default config still yields `refs/heads/main`). `pnpm --filter @atlas/cli --filter @atlas/broker test`
- [ ] **Step 5: Commit** — `refactor(broker,ingest): drive canonical ref from config (adoption prep)`

### Task 1.3 — `0012_sync_cursors` forward migration

- [ ] **Step 1: Write the failing test** — `packages/sqlite-store/test/migrate-0012-sync-cursors.test.ts`

```ts
import { describe, it, expect } from "vitest";
import { openStore } from "../src/index.js";
import { registerFeatureMigrationsForTest } from "./helpers.js"; // or the store-open path used elsewhere

describe("0012_sync_cursors", () => {
  it("creates a STRICT sync_cursors table with the pinned columns", () => {
    const store = openTestStoreWithSyncCursors(); // migrate through 0012
    const cols = store.db.prepare(`PRAGMA table_info(sync_cursors)`).all() as Array<{ name: string; notnull: number; pk: number }>;
    const byName = Object.fromEntries(cols.map((c) => [c.name, c]));
    expect(Object.keys(byName).sort()).toEqual(
      ["cycle_seq", "last_absorbed_oid", "last_synced_at", "pending_quarantine", "source_id", "upstream_ref"].sort(),
    );
    expect(byName.source_id.pk).toBe(1);
    expect(byName.upstream_ref.notnull).toBe(1);
    expect(byName.last_synced_at.notnull).toBe(1);
    expect(byName.last_absorbed_oid.notnull).toBe(0); // nullable
    // STRICT enforced:
    const isStrict = store.db.prepare(`SELECT 1 FROM pragma_table_list WHERE name='sync_cursors' AND strict=1`).get();
    expect(isStrict).toBeTruthy();
  });
});
```

- [ ] **Step 2: Run — expect FAIL** (no such table).
- [ ] **Step 3: Implement** — `packages/sqlite-store/migrations/0012_sync_cursors.ts`:

```ts
import { migrationChecksum, type Migration } from "../src/migrate.js";

export const SYNC_CURSORS_DDL = `
CREATE TABLE sync_cursors (
  source_id           TEXT PRIMARY KEY,
  upstream_ref        TEXT NOT NULL,
  last_absorbed_oid   TEXT,
  last_synced_at      TEXT NOT NULL,
  cycle_seq           INTEGER NOT NULL DEFAULT 0,
  pending_quarantine  TEXT NOT NULL DEFAULT '[]'
) STRICT;
`;

export const migration0012SyncCursors: Migration = {
  id: "0012_sync_cursors",
  checksum: migrationChecksum(SYNC_CURSORS_DDL),
  up(db) {
    db.exec(SYNC_CURSORS_DDL);
  },
};
```
Re-export from `packages/sqlite-store/src/index.ts`. Register in `apps/cli/src/commands/store-open.ts` `registerFeatureMigrations` (before `store.migrate()`), alongside how `0006/0009/0010/0011` are registered via `registerWorkflowMigrations`. Do **not** renumber — numbering interleaves across packages.

- [ ] **Step 4: Run — expect PASS.**
- [ ] **Step 5: Commit** — `feat(sqlite-store): 0012_sync_cursors forward migration`

### Task 1.4 — `sync_cursors` survives `db rebuild` (exclusion by omission)

- [ ] **Step 1: Write the failing test** — `packages/sqlite-store/test/rebuild-preserves-sync-cursors.test.ts`

```ts
import { describe, it, expect } from "vitest";

describe("db rebuild preserves sync_cursors", () => {
  it("leaves a non-trivial sync_cursors row byte-identical across rebuildProjections", () => {
    const store = openTestStoreWithSyncCursors();
    store.db.prepare(
      `INSERT INTO sync_cursors (source_id, upstream_ref, last_absorbed_oid, last_synced_at, cycle_seq, pending_quarantine)
       VALUES (?,?,?,?,?,?)`,
    ).run("main-vault", "refs/heads/main", "a".repeat(40), "2026-07-19T00:00:00Z", 3,
          JSON.stringify([{ path: "n.md", quarantineId: "q1", firstSeenOid: "b".repeat(40) }]));
    const before = store.db.prepare(`SELECT * FROM sync_cursors WHERE source_id='main-vault'`).get();

    rebuildProjections(store.db, emptyVaultSnapshot()); // must not touch sync_cursors

    const after = store.db.prepare(`SELECT * FROM sync_cursors WHERE source_id='main-vault'`).get();
    expect(after).toEqual(before);
  });
});
```

- [ ] **Step 2: Run — expect PASS immediately** if exclusion-by-omission holds (rebuild's `clearAll` only clears projection tables, no fold references `sync_cursors`). **This test's job is to lock that in as a regression** (the spec calls this the one silent corpus-scale regression). If it FAILS, the fix is to ensure `sync_cursors` is referenced by no pre-clear/fold and is not in `ProjectionRepo.clearAll` (`packages/sqlite-store/src/repos/projections.ts`).
- [ ] **Step 3: (only if red) remove any accidental coupling.** Add a code comment in `rebuild.ts` header listing `sync_cursors` among the authoritative non-derived tables it must never touch (like `jobs`).
- [ ] **Step 4: Run — expect PASS.**
- [ ] **Step 5: Commit** — `test(sqlite-store): lock sync_cursors exclusion from rebuild (corpus-scale regression guard)`

### Task 1.5 — Seed the `sync_cursors` row at adoption

- [ ] **Step 1: Write the failing test** — `apps/cli/test/sync-seed.test.ts`

```ts
import { describe, it, expect } from "vitest";
import { seedSyncCursor } from "../src/sync/seed.js";

describe("seedSyncCursor", () => {
  it("inserts a zero-state row: null cursor, cycle_seq 0, empty pending, non-null last_synced_at", () => {
    const store = openTestStoreWithSyncCursors();
    seedSyncCursor(store, { sourceId: "main-vault", upstreamRef: "refs/heads/main", now: "2026-07-19T12:00:00Z" });
    const row = store.db.prepare(`SELECT * FROM sync_cursors WHERE source_id='main-vault'`).get() as any;
    expect(row.last_absorbed_oid).toBeNull();
    expect(row.cycle_seq).toBe(0);
    expect(row.pending_quarantine).toBe("[]");
    expect(row.last_synced_at).toBe("2026-07-19T12:00:00Z");
    expect(row.upstream_ref).toBe("refs/heads/main");
  });

  it("is idempotent — re-seeding does not overwrite an advanced cursor", () => {
    const store = openTestStoreWithSyncCursors();
    seedSyncCursor(store, { sourceId: "main-vault", upstreamRef: "refs/heads/main", now: "2026-07-19T12:00:00Z" });
    store.db.prepare(`UPDATE sync_cursors SET last_absorbed_oid=?, cycle_seq=2 WHERE source_id='main-vault'`).run("c".repeat(40));
    seedSyncCursor(store, { sourceId: "main-vault", upstreamRef: "refs/heads/main", now: "2026-07-20T00:00:00Z" });
    const row = store.db.prepare(`SELECT * FROM sync_cursors WHERE source_id='main-vault'`).get() as any;
    expect(row.last_absorbed_oid).toBe("c".repeat(40)); // unchanged
    expect(row.cycle_seq).toBe(2);
  });
});
```

- [ ] **Step 2: Run — expect FAIL.**
- [ ] **Step 3: Implement** — `apps/cli/src/sync/seed.ts`:

```ts
import type { Store } from "@atlas/sqlite-store";

export interface SeedSyncCursorArgs {
  sourceId: string;
  upstreamRef: string;
  now: string; // RFC3339 UTC
}

/** Seed the sync_cursors row at adoption (60-A). Idempotent: INSERT OR IGNORE, never clobbers an advanced cursor. */
export function seedSyncCursor(store: Store, args: SeedSyncCursorArgs): void {
  store.db.prepare(
    `INSERT OR IGNORE INTO sync_cursors
       (source_id, upstream_ref, last_absorbed_oid, last_synced_at, cycle_seq, pending_quarantine)
     VALUES (@source_id, @upstream_ref, NULL, @now, 0, '[]')`,
  ).run({ source_id: args.sourceId, upstream_ref: args.upstreamRef, now: args.now });
}
```

- [ ] **Step 4: Run — expect PASS.**
- [ ] **Step 5: Commit** — `feat(cli): seed sync_cursors row at vault adoption`

### Task 1.6 — Provisioning + docs for adoption

- [ ] **Step 1: Write + test the executable bootstrap** — `provisioning/adopt-vault.sh` (`set -euo pipefail`), the one command that adopts a vault. It (a) has the broker create `refs/atlas/main` at a **broker-minted empty-tree baseline commit** — never at `refs/heads/main`, so the canonical protected ref never starts on unscanned upstream bytes; the first `sync` fast-forwards the real notes in through the scan pipeline; (b) runs `db migrate`; (c) calls `seedSyncCursor` to write the zero-state row; (d) validates `refs/atlas/main` resolves, the cursor row exists at zero-state, `refs/heads/main` is byte-identical to before, and the resolved runtime `git.canonical_ref` equals `refs/atlas/main` — failing closed if it is still the upstream default, since an adopted vault whose canonical ref points at `refs/heads/main` would drive Atlas writes onto the live upstream; and (e) **fails closed** — any incomplete step leaves no half-adopted state (never a ref without a cursor, nor a cursor without a ref). Cover the happy path + a fault-injected partial bootstrap in `provisioning/test/adopt-vault.test.ts`. Then document the exact invocation in `docs/install.md` (a new "Adopting a live vault" subsection): set `vault.path = /Users/aryeh/Code/Vaults/main-vault`, set `git.canonical_ref = "refs/atlas/main"`, run `provisioning/adopt-vault.sh` (OQ#2 decision: in-repo, not a bare mirror), and confirm `refs/heads/main` remains untouched.
- [ ] **Step 2:** Update `apps/cli/CLAUDE.md` (canonical ref is now config-driven; `sync/` dir introduced), `packages/sqlite-store/CLAUDE.md` (add `sync_cursors` to the authoritative-non-derived table inventory alongside `jobs`), and `packages/broker/CLAUDE.md` (protected canonical ref is config-supplied).
- [ ] **Step 3:** Run `pnpm -r build && pnpm -r test && pnpm contract:check` — expect green.
- [ ] **Step 4: Commit** — `docs(adoption): live-vault adoption runbook + CLAUDE.md updates`

**Verification (Phase 1):** `pnpm -r build && pnpm -r test`; adopt a fixture vault, assert `sync_cursors` seeded at zero-state, `db rebuild` preserves it, and default-config repos still integrate into `refs/heads/main` (no regression). Manually confirm on a throwaway clone that setting `git.canonical_ref=refs/atlas/main` makes capture write `refs/atlas/main` and leaves `refs/heads/main` byte-identical.

**Rollback (Phase 1):** The `0012` migration is forward-only but inert if unused (empty table); no data migration to undo. **Before `provisioning/adopt-vault.sh` has run**, reverting the branch is safe. **After the bootstrap has run, adoption is roll-forward-only** — a bare config revert would drop `git.canonical_ref` back to the `refs/heads/main` default and the next Atlas mutation would write the live upstream ref, violating the never-write-`refs/heads/main` invariant. To back out an adopted vault: disable all Atlas writers (stop the sync timer + any workflow), restore the complete pre-adoption vault/config from backup, verify the effective canonical ref, and only then re-enable commands.

---

## Phase 2 — 60-B core libraries: scoped index reconcile + incremental projection fold

**Deployable slice:** two pure library additions with unit tests, no command wiring. `indexNotes(deps, noteIds)` re-embeds only the given notes (O(delta)); `foldNotesForPaths(...)` reconciles the `notes` projection for only the given notes (active-upsert or archive).

**Files:**
- Create: `packages/lancedb-index/src/reconcile-notes.ts` (exports `indexNotes`, `ReconcileReport`)
- Modify: `packages/lancedb-index/src/index.ts` (barrel export)
- Modify: `apps/cli/src/commands/index-ops.ts` (export `noteFences`; add `noteFencesForNotes(store, noteIds)`)
- Create: `packages/sqlite-store/src/fold-notes-for-paths.ts` (exports `foldNotesForPaths`)
- Modify: `packages/sqlite-store/src/index.ts` (barrel export)
- Test: `packages/lancedb-index/test/index-notes.test.ts`, `packages/sqlite-store/test/fold-notes-for-paths.test.ts`

**Interfaces:**
- Produces:
  - `indexNotes(deps: IndexDeps, noteIds: NoteId[]): Promise<ReconcileReport>` where `ReconcileReport = { scanned: number; reembedded: number; unchanged: number; removed: number; results: Array<{ noteId: string; kind: "reembedded" | "unchanged" | "removed" }> }` and `scanned === reembedded + unchanged + removed`.
  - `foldNotesForPaths(store: Store, repo: Repo, ref: string, noteIds: NoteId[]): void`.
  - `noteFences(store: Store): NoteFenceInput[]` (now exported); `noteFencesForNotes(store: Store, noteIds: NoteId[]): NoteFenceInput[]`.
- Consumes: `reconcileIndex`/`indexNote` fast path + `IndexDeps` (`packages/lancedb-index/src/activate.ts:126,282,331-358,435`); `rebuildProjections` note-derivation (`packages/sqlite-store/src/rebuild.ts:189-203`); `NoteFenceInput` (`index-ops.ts:71`); `foldProvenanceFromCanonical` pattern (`manifests.ts:265`).

### Task 2.1 — Export note fences + a filtered helper

- [ ] **Step 1: Write the failing test** — `apps/cli/test/note-fences.test.ts`

```ts
import { describe, it, expect } from "vitest";
import { noteFences, noteFencesForNotes } from "../src/commands/index-ops.js";

describe("noteFencesForNotes", () => {
  it("returns fences for only the requested noteIds, preserving fence fields", () => {
    const store = storeWithNotes([
      { noteId: "n1", contentHash: "h1", activeGenerationId: "g1" },
      { noteId: "n2", contentHash: "h2", activeGenerationId: "g2" },
      { noteId: "n3", contentHash: "h3", activeGenerationId: "g3" },
    ]);
    const out = noteFencesForNotes(store, ["n1", "n3"]);
    expect(out.map((f) => f.noteId).sort()).toEqual(["n1", "n3"]);
    expect(out.find((f) => f.noteId === "n1")).toMatchObject({ contentHash: "h1", activeGenerationId: "g1" });
  });

  it("scopes the DB scan to the requested ids (O(delta), not O(corpus))", () => {
    const store = storeWithManyNotes(5000);
    const spy = spyOnPrepare(store);
    noteFencesForNotes(store, ["n42"]);
    expect(spy.lastSql).toMatch(/WHERE note_id IN/); // bounded query, no full-table fence scan
  });
});
```

- [ ] **Step 2: Run — expect FAIL** (`noteFences` not exported).
- [ ] **Step 3: Implement** — in `apps/cli/src/commands/index-ops.ts`: change `function noteFences` → `export function noteFences`, and refactor its body onto a shared `NOTE_FENCE_SELECT` + `fenceRowsToInputs` (its unscoped form omits the `WHERE`). Add a **bounded** scoped helper — never materialize the full corpus:

```ts
export function noteFencesForNotes(store: Store, noteIds: NoteId[]): NoteFenceInput[] {
  const ids = [...new Set(noteIds.map(String))];
  if (ids.length === 0) return [];
  const placeholders = ids.map(() => "?").join(",");   // indexed IN, O(delta) not O(corpus)
  return fenceRowsToInputs(
    store.db.prepare(`${NOTE_FENCE_SELECT} WHERE note_id IN (${placeholders})`).all(...ids),
  );
}
```

- [ ] **Step 4: Run — expect PASS.**
- [ ] **Step 5: Commit** — `refactor(cli): export note fences + add noteFencesForNotes helper`

### Task 2.2 — `foldNotesForPaths` (incremental projection fold)

- [ ] **Step 1: Write the failing tests** — `packages/sqlite-store/test/fold-notes-for-paths.test.ts`

```ts
import { describe, it, expect } from "vitest";
import { foldNotesForPaths } from "../src/fold-notes-for-paths.js";

describe("foldNotesForPaths", () => {
  it("upserts an active row for a note that resolves at the ref", async () => {
    const { store, repo, ref } = await fixtureWithNoteAtRef("n1", "refs/atlas/main");
    foldNotesForPaths(store, repo, ref, ["n1"]);
    const row = store.db.prepare(`SELECT note_id, lifecycle, content_hash, active_generation_id FROM notes WHERE note_id='n1'`).get() as any;
    expect(row.lifecycle).toBe("active");
    expect(row.content_hash).toBeTruthy();
  });

  it("archives a note that no longer resolves at the ref (delete case)", async () => {
    const { store, repo, ref } = await fixtureWithNoteThenDeleted("n1", "refs/atlas/main");
    foldNotesForPaths(store, repo, ref, ["n1"]);
    const row = store.db.prepare(`SELECT lifecycle FROM notes WHERE note_id='n1'`).get() as any;
    expect(row.lifecycle).toBe("archived"); // non-destructive; row + history retained
  });

  it("is idempotent — re-running yields byte-identical rows (active and archived)", async () => {
    const { store, repo, ref } = await fixtureWithNoteAtRef("n1", "refs/atlas/main");
    foldNotesForPaths(store, repo, ref, ["n1"]);
    const first = store.db.prepare(`SELECT * FROM notes WHERE note_id='n1'`).get();
    foldNotesForPaths(store, repo, ref, ["n1"]);
    const second = store.db.prepare(`SELECT * FROM notes WHERE note_id='n1'`).get();
    expect(second).toEqual(first);
  });
});
```

- [ ] **Step 2: Run — expect FAIL** (module missing).
- [ ] **Step 3: Implement** — `packages/sqlite-store/src/fold-notes-for-paths.ts`. Reuse the exact per-note derivation `rebuildProjections` uses (`rebuild.ts:189-203`), scoped to `noteIds`, deriving each note's presence from `ref` (read the ref tree, resolve each `noteId`'s path/blob). Two outcomes per `noteId`:
  - resolves at `ref` → `repo.upsertNote({ note_id, content_hash, active_generation_id, lifecycle: "active", ... })` (idempotent, keyed by `note_id`);
  - does not resolve → set `lifecycle = "archived"`, leave `content_hash`/`active_generation_id` as-is (a re-add re-derives them). Row + history retained (reversible, nothing erased).
  Runs agent-side (projection write; `notes` is not a protected ref). Returns `void`; throws on a derivation error (surfaced later as the cycle's `internal` abort).

- [ ] **Step 4: Run — expect PASS.**
- [ ] **Step 5: Commit** — `feat(sqlite-store): foldNotesForPaths incremental projection fold`

### Task 2.3 — `indexNotes` (scoped reconcile, O(delta))

- [ ] **Step 1: Write the failing tests** — `packages/lancedb-index/test/index-notes.test.ts`

```ts
import { describe, it, expect } from "vitest";
import { indexNotes } from "../src/reconcile-notes.js";

describe("indexNotes", () => {
  it("re-embeds only the supplied notes and reports the tally", async () => {
    const deps = await depsWithIndexedCorpus(["n1", "n2", "n3"]); // all already indexed & current
    await mutateNoteContent(deps, "n2");                          // n2 now stale
    const report = await indexNotes({ ...deps, notes: fencesFor(deps, ["n2"]) }, ["n2"]);
    expect(report.scanned).toBe(1);
    expect(report.reembedded).toBe(1);
    expect(report.unchanged).toBe(0);
    expect(report.results).toEqual([{ noteId: "n2", kind: "reembedded" }]);
    expect(report.scanned).toBe(report.reembedded + report.unchanged + report.removed);
  });

  it("hits the fast path (unchanged) without re-embedding a current note", async () => {
    const deps = await depsWithIndexedCorpus(["n1"]);
    const report = await indexNotes({ ...deps, notes: fencesFor(deps, ["n1"]) }, ["n1"]);
    expect(report.unchanged).toBe(1);
    expect(report.reembedded).toBe(0);
  });

  it("reports removed for an archived note and drops its chunks", async () => {
    const deps = await depsWithIndexedCorpus(["n1"]);
    await archiveNote(deps, "n1"); // lifecycle archived ⇒ no fence
    const report = await indexNotes({ ...deps, notes: fencesFor(deps, ["n1"]) }, ["n1"]);
    expect(report.results).toEqual([{ noteId: "n1", kind: "removed" }]);
    expect(report.removed).toBe(1);
    expect(await chunkCount(deps, "n1")).toBe(0);
  });

  it("de-duplicates noteIds and never re-embeds notes it was not handed", async () => {
    const deps = await depsWithIndexedCorpus(["n1", "n2"]);
    const before = await chunkSnapshot(deps, "n2");
    await mutateNoteContent(deps, "n1");
    await indexNotes({ ...deps, notes: fencesFor(deps, ["n1"]) }, ["n1", "n1"]); // duplicate
    expect(await chunkSnapshot(deps, "n2")).toEqual(before); // n2 untouched
  });

  it("throws on an empty noteIds array (caller error)", async () => {
    const deps = await depsWithIndexedCorpus(["n1"]);
    await expect(indexNotes({ ...deps, notes: [] }, [])).rejects.toThrow();
  });
});
```

- [ ] **Step 2: Run — expect FAIL.**
- [ ] **Step 3: Implement** — `packages/lancedb-index/src/reconcile-notes.ts`:

```ts
import { indexNote, type IndexDeps } from "./activate.js";
import type { NoteId } from "@atlas/contracts";

export interface ReconcileReport {
  scanned: number;
  reembedded: number;
  unchanged: number;
  removed: number;
  results: Array<{ noteId: string; kind: "reembedded" | "unchanged" | "removed" }>;
}

/**
 * Note-scoped analog of reconcileIndex: iterates only `noteIds`, reusing indexNote's
 * fast path (activeGenerationId match + verifyComplete ⇒ unchanged, no re-embed).
 * Does NOT drop the table. Fences are supplied via deps.notes (caller filters to noteIds).
 */
export async function indexNotes(deps: IndexDeps, noteIds: NoteId[]): Promise<ReconcileReport> {
  const ids = [...new Set(noteIds)];
  if (ids.length === 0) throw new Error("indexNotes: noteIds must be non-empty");
  if (!deps.notes) throw new Error("indexNotes: deps.notes (fences) required");

  const fenceById = new Map(deps.notes.map((f) => [String(f.noteId), f]));
  const report: ReconcileReport = { scanned: 0, reembedded: 0, unchanged: 0, removed: 0, results: [] };

  // one shared lock across all indexNote calls (mirror reconcileIndex threading)
  await withReconcileLock(deps, async (lock) => {
    for (const id of ids) {
      report.scanned++;
      const fence = fenceById.get(String(id));
      if (!fence) {
        // no active fence ⇒ archived/deleted: drop its chunks
        await removeNoteChunks(deps, id, lock);
        report.removed++;
        report.results.push({ noteId: String(id), kind: "removed" });
        continue;
      }
      const r = await indexNote(deps, fence, lock); // returns "unchanged" | "indexed"
      if (r.kind === "unchanged") {
        report.unchanged++;
        report.results.push({ noteId: String(id), kind: "unchanged" });
      } else {
        report.reembedded++;
        report.results.push({ noteId: String(id), kind: "reembedded" });
      }
    }
  });
  return report;
}
```
Reuse `reconcileIndex`'s lock-threading (`activate.ts:444-465`) and `indexNote`'s signature (`activate.ts:282`) exactly — extract `withReconcileLock`/`removeNoteChunks` from the existing reconcile body if not already factored, so this shares one code path with `reconcileIndex` (DRY). Barrel-export `indexNotes` + `ReconcileReport` from `packages/lancedb-index/src/index.ts`.

- [ ] **Step 4: Run — expect PASS.**
- [ ] **Step 5: Commit** — `feat(lancedb-index): indexNotes scoped reconcile (O(delta))`

**Verification (Phase 2):** `pnpm --filter @atlas/lancedb-index --filter @atlas/sqlite-store --filter @atlas/cli test`. Assert `indexNotes` never touches notes outside its payload (the O(delta) proof at the library layer) and `foldNotesForPaths` is idempotent for both active and archived notes.

**Rollback (Phase 2):** Revert. Both are additive; no caller yet depends on them.

---

## Phase 3 — 60-B: `index:reconcile` job kind + production handler registry

> **PREREQUISITE — PR #216.** This phase assumes #216 (job-handler registry population + job-kind completeness gate) has landed. This worktree's base predates it (verified: no `job-handlers.ts`, `JOB_HANDLERS = {}`, no job-kind completeness gate). **Before starting Phase 3, rebase this work onto a `main` that includes #216.** If #216 is unavailable, the fallback is to register directly via the existing `registerJobHandler("index:reconcile", handler)` at barrel import (`apps/cli/src/commands/jobs.ts:48-53`) and add the completeness gate here — but do not duplicate #216; coordinate.

**Deployable slice:** `index:reconcile` is a real production job kind whose handler calls `indexNotes`, registered and covered by the completeness gate; idempotent enqueue keyed by the run's `refs/atlas/main` OID; lock deferral on `jobs-runner`.

**Files:**
- Create/Modify: `apps/cli/src/commands/job-handlers.ts` (#216) or `apps/cli/src/commands/jobs.ts` (fallback) — register `index:reconcile`
- Create: `apps/cli/src/sync/reconcile-handler.ts` (the handler body)
- Test: `apps/cli/test/index-reconcile-handler.test.ts`, `apps/cli/test/index-reconcile-enqueue.test.ts`

**Interfaces:**
- Produces: a registered `index:reconcile` `JobHandler`; the handler consumes `payload: { noteIds: NoteId[] }`.
- Consumes: `registerJobHandler` (`jobs.ts:48-53`), `JobHandler`/`JobHandlerContext`/`JobHandlerResult` (`packages/jobs/src/runner.ts:240,192-200,226-237`), `enqueue`/`JobSpec` (`packages/jobs/src/repo.ts:213,39-45`), `indexNotes` + `noteFencesForNotes` (Phase 2).

### Task 3.1 — `index:reconcile` handler body

- [ ] **Step 1: Write the failing test** — `apps/cli/test/index-reconcile-handler.test.ts`

```ts
import { describe, it, expect } from "vitest";
import { makeIndexReconcileHandler } from "../src/sync/reconcile-handler.js";

describe("index:reconcile handler", () => {
  it("validates payload.noteIds and calls indexNotes with the fences for those ids", async () => {
    const { handler, store, spy } = harness(["n1", "n2"]);
    const res = await handler({
      jobId: "j1", workflow: "index:reconcile", attempt: 1,
      payload: { noteIds: ["n1"] }, signal: new AbortController().signal, now: "2026-07-19T00:00:00Z",
    });
    expect(spy.indexNotesCalledWith).toEqual(["n1"]);
    expect(res.kind).toBeDefined(); // content-addressed result arm
  });

  it("rejects an empty or malformed payload", async () => {
    const { handler } = harness([]);
    await expect(handler({ jobId: "j", workflow: "index:reconcile", attempt: 1,
      payload: { noteIds: [] }, signal: new AbortController().signal, now: "t" })).rejects.toThrow();
    await expect(handler({ jobId: "j", workflow: "index:reconcile", attempt: 1,
      payload: {}, signal: new AbortController().signal, now: "t" })).rejects.toThrow();
  });
});
```

- [ ] **Step 2: Run — expect FAIL.**
- [ ] **Step 3: Implement** — `apps/cli/src/sync/reconcile-handler.ts`:

```ts
import { z } from "zod";
import { indexNotes } from "@atlas/lancedb-index";
import { noteFencesForNotes } from "../commands/index-ops.js";
import type { JobHandler, JobHandlerResult } from "@atlas/jobs";

const PayloadSchema = z.object({ noteIds: z.array(z.string().min(1)).min(1) });

export function makeIndexReconcileHandler(buildDeps: (payloadNoteIds: string[]) => IndexReconcileDeps): JobHandler {
  return async (ctx): Promise<JobHandlerResult> => {
    const { noteIds } = PayloadSchema.parse(ctx.payload); // throws ⇒ classified non-retryable by the runner
    const { store, indexDepsBase } = buildDeps(noteIds);
    const notes = noteFencesForNotes(store, noteIds as NoteId[]);
    const report = await indexNotes({ ...indexDepsBase, notes }, noteIds as NoteId[]);
    // content-addressed result (no protected-ref mutation): reindex is derived state
    return { kind: "content-addressed", sideEffectId: undefined, summary: report };
  };
}
```
Match the exact `JobHandlerResult` discriminated union (`runner.ts:226-237`) — reindex is derived/disposable state, so use the content-addressed arm (no `commit(tx)`). `buildDeps` assembles `IndexDeps` (config/table/store/embed/lock) the same way `jobs run`'s drain builds `JobsDeps` (`jobs.ts:301-328`) — the egress capability mint for embedding rides the existing model-call path.

- [ ] **Step 4: Run — expect PASS.**
- [ ] **Step 5: Commit** — `feat(sync): index:reconcile job handler calling indexNotes`

### Task 3.2 — Register the handler + completeness gate

- [ ] **Step 1: Write the failing test** — `apps/cli/test/index-reconcile-handler.test.ts` (append)

```ts
it("index:reconcile is registered in the production handler map (no test env gate)", async () => {
  delete process.env.ATLAS_TEST_JOB_HANDLER;
  const { handlers } = loadProductionJobHandlers(); // whatever #216 exposes
  expect(handlers["index:reconcile"]).toBeTypeOf("function");
});
```
Plus, if #216's completeness gate exists, add `index:reconcile` to its expected-kinds set so the gate covers it.

- [ ] **Step 2: Run — expect FAIL** (unregistered).
- [ ] **Step 3: Implement** — register `index:reconcile` at barrel import via the #216 registry (or `registerJobHandler("index:reconcile", makeIndexReconcileHandler(...))` at `jobs.ts` import in the fallback). Add it to the completeness gate's known-kinds list. **Note in the commit body:** this is the first real production job handler — before it, `JOB_HANDLERS` was effectively empty and every enqueued job failed `internal` when drained (the pre-existing breakage the spec calls out).
- [ ] **Step 4: Run — expect PASS.** Also run the completeness gate: `pnpm --filter @atlas/cli test` (the registration/completeness suite).
- [ ] **Step 5: Commit** — `feat(sync): register index:reconcile production handler (first real job kind)`

### Task 3.3 — Idempotent enqueue + lock deferral

- [ ] **Step 1: Write the failing tests** — `apps/cli/test/index-reconcile-enqueue.test.ts`

```ts
describe("index:reconcile enqueue", () => {
  it("is idempotent on (workflow, idempotencyKey=run OID) — double-enqueue yields one row", () => {
    const tx = openLedgerTxWithEnqueueContext();
    const oid = "d".repeat(40);
    const id1 = enqueue(tx, { workflow: "index:reconcile", idempotencyKey: oid, payload: { noteIds: ["n1"] } });
    const id2 = enqueue(tx, { workflow: "index:reconcile", idempotencyKey: oid, payload: { noteIds: ["n1"] } });
    expect(id1).toBe(id2);
    const rows = tx.prepare(`SELECT COUNT(*) c FROM jobs WHERE workflow='index:reconcile' AND idempotency_key=?`).get(oid) as any;
    expect(rows.c).toBe(1);
  });

  it("defers when jobs-runner lock is held (drain does not run, job persists)", async () => {
    // hold jobs-runner, run the drain, assert exit locked:jobs-runner and the pending job still present
  });
});
```

- [ ] **Step 2: Run — expect first test PASS** (ON CONFLICT DO NOTHING already gives this — `repo.ts:227-243`); it locks the behavior in as a regression. Lock-deferral test drives the existing `jobs run` lock path.
- [ ] **Step 3: (only if red) wire the enqueue** so the sync cycle passes `idempotencyKey = <run's refs/atlas/main OID>`. (This is consumed in Phase 4; here we just prove the primitive.)
- [ ] **Step 4: Run — expect PASS.**
- [ ] **Step 5: Commit** — `test(sync): idempotent index:reconcile enqueue + lock deferral`

**Verification (Phase 3):** Enqueue and drain `index:reconcile` with `ATLAS_TEST_JOB_HANDLER` unset; assert it completes (not `internal`) — the regression on the empty-registry breakage. Idempotent enqueue yields one row; holding `jobs-runner` defers the drain.

**Rollback (Phase 3):** Revert. If #216 landed independently, only the `index:reconcile` registration + handler revert; the registry infra stays.

---

## Phase 4 — 60-B: `sync` + `sync status` commands (contract) + the cycle engine

**Deployable slice:** `brain sync` runs one absorb cycle (clean / mixed / all-quarantined, single-run invariant, `--dry-run`, `--max-paths`, all exit codes/envelopes, **including the OQ#5 divergence detection halt**), and `brain sync status` reads cursor + pending + divergence state. This is the largest phase; it is the whole cycle engine.

**Files:**
- Modify: `docs/specs/cli-contract/commands.json` (+2 rows: `sync`, `sync status`)
- Modify: `docs/specs/cli-contract/cli-surface.fixture.txt` (+2 lines under a Phase-5 heading)
- Create: `docs/specs/cli-contract/sync.schema.json`, `docs/specs/cli-contract/sync-status.schema.json`
- Modify: `docs/specs/security-broker-contract.md` (add the `diverged:*` error codes to the authz `errorCatalog`)
- Create: `apps/cli/src/sync/cursor.ts` (read/advance/reconcile `sync_cursors`), `apps/cli/src/sync/diff.ts` (name-status diff + commit grouping), `apps/cli/src/sync/cycle.ts` (the engine), `apps/cli/src/sync/pending.ts` (pending-quarantine set reconcile), `apps/cli/src/commands/sync.ts` (handler + status handler)
- Modify: `packages/git/src/repo.ts` (+`changedPaths(from,to,pathspec)` net tree diff, `commitsInRange(from,to,pathspec)` per-commit name-status walk, and `readBlobAt(commitOid,path)` snapshot-bound blob read on the agent `Repo`, mirroring `BrokerGit.changedPathsInRange`)
- Modify: `apps/cli/src/ingest/capture.ts` (extract a side-effect-free `planCaptureSource`; `captureSource` becomes a wrapper that plans then integrates)
- Modify: `apps/cli/src/commands/index.ts` barrel (register handlers)
- Test: `apps/cli/test/sync-cycle.test.ts`, `apps/cli/test/sync-status.test.ts`, `apps/cli/test/sync-divergence.test.ts`, `apps/cli/test/sync-dry-run.test.ts`, `apps/cli/test/sync-max-paths.test.ts`, `apps/cli/test/sync-crash.failpoint.test.ts`

**Interfaces:**
- Produces: `runSyncCycle(deps, opts): Promise<SyncResult>` and `readSyncStatus(deps): Promise<SyncStatus>` (envelope shapes = the spec's `interfaces` tables, with `divergence` added to status and `behindBy: number | null`).
- Consumes: Phase 1 (`sync_cursors`, `config.git.canonical_ref`, `config.vault.note_globs`, `protectedRefsFor`), Phase 2 (`foldNotesForPaths`), Phase 3 (`index:reconcile` enqueue), `planCaptureSource` (extracted from `captureSource`, `capture.ts:359`), `foldProvenanceFromCanonical` (`manifests.ts:265`), broker integrate (`handle.integrate`, `capture.ts:464`), `repo.readRef`/`repo.isAncestor` (`@atlas/git`), the §2.8 finalize transaction.

### Task 4.1 — Contract: rows + fixture + schemas + `contract:write`

Row values (name-sorted insertion into `commands.json`; `phase: 5`, per the spec's "graduation phase" placement):

| name | phase | idempotency | privilege | implemented (this task) |
|---|---|---|---|---|
| `sync` | 5 | `intrinsic` | `shared` | `false` → flipped `true` at Task 4.9 |
| `sync status` | 5 | `none` | `shared` | `false` → flipped `true` at Task 4.9 |

(`sync reset` — `phase 5`, `key-accepting`, `privileged` — is added in Phase 5.)

- [ ] **Step 1:** Insert the two name-sorted rows in `docs/specs/cli-contract/commands.json` with `implemented: false`.
- [ ] **Step 2:** Add under a `# Live vault sync (Phase 5)` heading in `cli-surface.fixture.txt`:
  ```
  # Live vault sync (Phase 5)
  `sync` — run one upstream→refs/atlas/main absorb cycle over the adopted vault.
  `sync status` — read the sync cursor, behind-by, pending quarantine, and divergence state.
  ```
- [ ] **Step 3:** Create `docs/specs/cli-contract/sync.schema.json` and `sync-status.schema.json` (JSON-Schema draft 2020-12, `unevaluatedProperties: false`), each with the full success-envelope `properties` from the spec's `interfaces` tables **and** an `x-atlas-contract` block. For `sync`, the `x-atlas-contract` must carry: `command: "sync"`, `phase: 5`, `privilege: "shared"`, `idempotency: "intrinsic"`, `executionClass`, `flags: [--dry-run, --max-paths, --json]`, `locks: ["vault", "vault-maintenance"]`, `exitCodes: [0,2,3,4,6]`, `errorCodes: ["locked:jobs-runner","locked:vault-maintenance","backup-unhealthy","config","vault","secret-scan","internal","diverged:non-ancestral","diverged:cursor-unreachable"]`, `errorEnvelopeRef`, `sideEffects`, `prohibitedEffects: ["writes refs/heads/main"]`. For `sync status`: `privilege: "shared"`, `idempotency: "none"`, `exitCodes: [0,2]`, `errorCodes: ["config","vault"]`, `sideEffects: []`. Add `diverged:non-ancestral` / `diverged:cursor-unreachable` to `security-broker-contract.md`'s authz `errorCatalog` so `contract-lint` (`tools/cli-contract.ts:545`) accepts them.
- [ ] **Step 4:** `pnpm contract:write` then `pnpm contract:check` — expect the generated `commands-overview.md` + per-command refs to regenerate and the check to pass (rows still `implemented:false`, so `command-registration.test.ts` does not yet require handlers).
- [ ] **Step 5: Commit** — `feat(contract): sync + sync status command rows, fixtures, schemas (implemented:false)`

### Task 4.2 — Cursor read/write module

- [ ] **Step 1: Write the failing test** — `apps/cli/test/sync-cycle.test.ts` (cursor section)

```ts
import { readCursor, finalizeCursor } from "../src/sync/cursor.js";

it("readCursor returns the seeded zero-state row", () => {
  const store = seededStore("main-vault");
  const c = readCursor(store, "main-vault");
  expect(c).toMatchObject({ lastAbsorbedOid: null, cycleSeq: 0, pendingQuarantine: [] });
});

it("finalizeCursor advances OID, bumps cycle_seq, reconciles pending, in one tx", () => {
  const store = seededStore("main-vault");
  finalizeCursor(store, {
    sourceId: "main-vault", newOid: "a".repeat(40), now: "t",
    clearPaths: [], upsertPending: [{ path: "s.md", quarantineId: "q1", firstSeenOid: "b".repeat(40) }],
  });
  const c = readCursor(store, "main-vault");
  expect(c.lastAbsorbedOid).toBe("a".repeat(40));
  expect(c.cycleSeq).toBe(1);
  expect(c.pendingQuarantine).toEqual([{ path: "s.md", quarantineId: "q1", firstSeenOid: "b".repeat(40) }]);
});
```

- [ ] **Step 2: Run — expect FAIL.**
- [ ] **Step 3: Implement** — `apps/cli/src/sync/cursor.ts`: `readCursor(store, sourceId)` (parses `pending_quarantine` JSON, validating each element `{path, quarantineId, firstSeenOid(40-hex)}` — malformed ⇒ throw), and `finalizeCursor(store, {...})` performing the single-statement `UPDATE sync_cursors SET last_absorbed_oid=?, last_synced_at=?, cycle_seq=cycle_seq+1, pending_quarantine=? WHERE source_id=?` — this UPDATE runs **inside the caller's §2.8 finalize transaction** (step 3), never on its own connection.
- [ ] **Step 4: Run — expect PASS.**
- [ ] **Step 5: Commit** — `feat(sync): sync_cursors read/finalize module`

### Task 4.3 — Divergence detection (OQ#5 guard) + name-status diff

- [ ] **Step 1: Write the failing tests** — `apps/cli/test/sync-divergence.test.ts` (the force-push + gc tests from §0)

```ts
it("halts diverged:non-ancestral on a force-push, cursor + ref unmoved", async () => {
  const f = await fixtureAdoptedVault();
  await runSyncCycle(f.deps, {});                    // cursor at C
  await forcePushUpstreamToRewrittenHistory(f);      // H' without C
  const res = await runSyncCycle(f.deps, {});
  expect(res.exitCode).toBe(2);
  expect(res.error.code).toBe("diverged:non-ancestral");
  expect(readCursor(f.store, f.sourceId).lastAbsorbedOid).toBe(f.cursorC);
  expect(await f.repo.readRef("refs/atlas/main")).toBe(f.atlasHeadBefore);
});

it("halts diverged:cursor-unreachable after upstream gc prunes the cursor commit", async () => {
  const f = await fixtureAdoptedVault();
  await runSyncCycle(f.deps, {});
  await gcAwayCursorCommit(f);
  const res = await runSyncCycle(f.deps, {});
  expect(res.exitCode).toBe(2);
  expect(res.error.code).toBe("diverged:cursor-unreachable");
});
```

- [ ] **Step 2: Run — expect FAIL.**
- [ ] **Step 3: Implement** — add **two** helpers to `packages/git/src/repo.ts` via the internal `runGit`: `changedPaths(from, to, pathspec)` (net tree-vs-tree name-status, `git diff --name-status <from>..<to> -- <pathspec>`, used only by `sync reset`'s tree diff) **and** `commitsInRange(from, to, pathspec)` where `from: string | null` — walks the **first-parent** chain so the cursor stays a linear, resumable single OID: `git rev-list --first-parent --reverse <to>` when `from === null` (zero-state, walking from the parentless root commit), else `git rev-list --first-parent --reverse <from>..<to>`; then diffs each commit against its **first parent** (`git diff-tree --name-status --no-commit-id -r <commit>^ <commit> -- <pathspec>`, and `git diff-tree --root --name-status --no-commit-id -r <commit> -- <pathspec>` for the parentless root so its additions are not silently dropped), returning `Array<{ oid: string; changes: Array<{ status: "A"|"M"|"D"|"R"; path: string; fromPath?: string }> }>` oldest→newest. First-parent (not `--topo-order`) is required: a topological prefix interleaves incomparable merge-parent commits, so a `--max-paths` cutoff OID would not contain the earlier-processed commits and the next `cutoff..head` range would re-process them — first-parent gives every prefix a valid single-OID continuation cursor and captures merge-introduced changes as the merge commit's first-parent diff. The cycle groups on these real commit OIDs — a net-only `from..to` diff loses commit boundaries, silently drops modify-then-revert, and leaves `--max-paths` no valid continuation cursor, so the per-commit walk is required. Then `apps/cli/src/sync/diff.ts` `detectDivergence(repo, lastOid, upstreamHead)`:

```ts
export type Divergence =
  | { state: "ok" }
  | { state: "non-ancestral"; cursorOid: string; upstreamHead: string }
  | { state: "cursor-unreachable"; cursorOid: string; upstreamHead: string };

export async function detectDivergence(repo: Repo, lastOid: string | null, upstreamHead: string): Promise<Divergence> {
  if (lastOid === null) return { state: "ok" };                 // zero-state, not divergence
  const resolved = await repo.readRef(lastOid);                 // rev-parse --verify --quiet <oid>^{commit}
  if (resolved === null) return { state: "cursor-unreachable", cursorOid: lastOid, upstreamHead };
  if (!(await repo.isAncestor(lastOid, upstreamHead)))
    return { state: "non-ancestral", cursorOid: lastOid, upstreamHead };
  return { state: "ok" };
}
```
Wire the guard at cycle step 2 (Task 4.4): on a non-`ok` state, emit the error envelope (`diverged:non-ancestral` / `diverged:cursor-unreachable`, exit 2, `retryable:false`), advance nothing.

- [ ] **Step 4: Run — expect PASS.**
- [ ] **Step 5: Commit** — `feat(sync): OQ#5 divergence detection (REJECT halt) + name-status diff`

### Task 4.4 — Cycle engine: clean happy path + single-run invariant + `behindBy==0` short-circuit

- [ ] **Step 1: Write the failing tests** — `apps/cli/test/sync-cycle.test.ts`

```ts
it("behindBy==0 short-circuits: no run, no writes, exit 0", async () => {
  const f = await fixtureAdoptedVaultCaughtUp();
  const res = await runSyncCycle(f.deps, {});
  expect(res.exitCode).toBe(0);
  expect(res.envelope).toMatchObject({ appliedOps: 0, reconcileJobId: null, truncated: false });
  expect(res.envelope.cursorFrom).toBe(res.envelope.cursorTo);
  expect(res.envelope.cursorTo).toBe(res.envelope.upstreamHead);
  expect(await auditEventCount(f)).toBe(0); // no run opened
});

it("clean cycle: one run, one integrate, one reconcile job, cursor→head", async () => {
  const f = await fixtureWithUpstreamChange(["a.md", "b.md"]); // two clean note edits across commits
  const res = await runSyncCycle(f.deps, {});
  expect(res.exitCode).toBe(0);
  expect(res.envelope.appliedOps).toBe(2);
  expect(await runCount(f)).toBe(1);                  // single-run invariant
  expect(await integrateCount(f)).toBe(1);            // one CAS fast-forward of refs/atlas/main
  expect(await reconcileJobCount(f)).toBe(1);         // one job, payload = union of noteIds
  expect(res.envelope.cursorTo).toBe(res.envelope.upstreamHead);
});

it("identical-content re-observation bumps observation_count, no op, no reconcile", async () => {
  const f = await fixtureReTouchingIdenticalNote();
  const res = await runSyncCycle(f.deps, {});
  expect(res.envelope.absorbed[0].action).toBe("unchanged");
  expect(res.envelope.appliedOps).toBe(0);
  expect(res.envelope.reconcileJobId).toBeNull();
  expect(await observationCount(f, "n1")).toBeGreaterThan(1);
  expect(await blobWriteCount(f)).toBe(0);
});
```

- [ ] **Step 2: Run — expect FAIL.**
- [ ] **Step 3: Implement** — `apps/cli/src/sync/cycle.ts` `runSyncCycle(deps, opts)`. Steps mirror the spec's *Sync cycle (happy path)*:
  1. acquire vault + `vault-maintenance` locks; defer if `jobs-runner` held; exit 2 `backup-unhealthy` if degraded.
  2. `readCursor`; **fail closed (exit 2 `config`) if `config.git.canonical_ref === "refs/heads/main"` — `sync` only runs against an adopted vault, whose canonical ref must be the broker-owned `refs/atlas/main`, never the live upstream;** `upstreamHead = readRef("refs/heads/main")`; **`detectDivergence` (Task 4.3) — halt on non-`ok`**; else compute `behindBy`; **short-circuit exit 0 if `behindBy==0`** (no run).
  3. open **one** run; `repo.commitsInRange(lastOid, upstreamHead, note_globs)` (a `null` cursor walks the first-parent chain from the root commit) → per-commit first-parent name-status, oldest→newest (real commit boundaries, so modify-then-revert nets correctly and `--max-paths` continuation lands on a valid first-parent OID).
  4. dispatch per path (Task 4.5 does A/M/D/R detail); accumulate one ChangePlan; identical bytes ⇒ `unchanged`, no op.
  5. close run: if ChangePlan non-empty → **first persist a durable finalization intent** (§2.8 step 1: target upstream OID + changed note IDs + reconciled pending set + the `index:reconcile` enqueue), **then** `handle.integrate(...)` (one CAS FF of `refs/atlas/main`), `foldProvenanceFromCanonical(store, repo, config.git.canonical_ref)`, `foldNotesForPaths(store, repo, ref, changedNoteIds)`, checkpoint `reindexed`; **finalize tx (§2.8 step 3):** `finalizeCursor(...)` (advance + `cycle_seq++` + reconcile pending) **and** enqueue the single `index:reconcile` (idempotencyKey = run OID) — atomically, consuming the intent. The intent is what makes recovery correct: after the ref FF a retry sees the bytes already present and classifies them `unchanged` (enqueuing nothing), so fold + enqueue + cursor-advance must be replayed from the persisted intent, never re-derived from the diff. Empty ChangePlan ⇒ no integrate, but still append `run.*` + finalize cursor.
  6. return the success envelope.
- [ ] **Step 4: Run — expect PASS.**
- [ ] **Step 5: Commit** — `feat(sync): cycle engine — clean path, single-run invariant, no-delta short-circuit`

### Task 4.5 — Dispatch A/M/D/R + scan-before-persist

- [ ] **Step 1: Write the failing tests** — `apps/cli/test/sync-cycle.test.ts` (dispatch section): delete→`ProposeArchive` (row `archived`, chunks removed, bytes recoverable from git, NOT `ProposeDelete`/`erase`); rename (same `contentId`, blob reused, no re-embed); modify re-indexes only that note (payload cardinality 1; the other N-1 provably untouched — the O(delta) proof); same-note-across-commits sequences (add-then-modify, modify-twice, modify-then-revert, rename-chain) each collapse to one valid final op with every intermediate version scanned; a note introduced only in the upstream **root commit** is absorbed by the first sync; and a merge commit's conflict-resolution edits are captured via its first-parent diff (with `--max-paths` resume landing on a valid first-parent continuation cursor).
- [ ] **Step 2: Run — expect FAIL.**
- [ ] **Step 3: Implement** — **first extract a side-effect-free `planCaptureSource` primitive** in `apps/cli/src/ingest/capture.ts`: it accepts **bytes read from an exact `commit:path`** (via a new `repo.readBlobAt(commitOid, path)` — never the working tree, so a concurrent worktree edit can't leak in) plus source metadata, runs exactly the existing normalization + scan preflight, and **returns proposed ops + observation metadata without opening or integrating a run**. Refactor `captureSource` to call `planCaptureSource` then integrate, so both share one pipeline. Then in `cycle.ts` dispatch, over the bytes at the snapshotted commit — threading a per-note in-memory overlay so that when one note changes across multiple commits in the range, each later snapshot is planned against that note's **already-planned** state (never the stale pre-run canonical), collapsing the sequence into one valid final op per note while every intermediate version is still scanned:
  - `A`/`M`: `planCaptureSource(repo.readBlobAt(commitOid, path), meta)` (scan raw+normalized) → append create/modify op to the single accumulating ChangePlan (identical bytes ⇒ bump `observation_count`, no op); mark any prior pending entry for removal.
  - `D`: append `ProposeArchive` (`packages/contracts/src/ops/archive.ts`); mark prior pending for removal.
  - `R`: append `ProposeRename` (`packages/contracts/src/ops/rename.ts`); rename-with-edit = delete-old + add-new at path level, dedup at content level; from-path pending cleared, to-path scanned.
- [ ] **Step 4: Run — expect PASS.**
- [ ] **Step 5: Commit** — `feat(sync): A/M/D/R dispatch with scan-before-persist; delete→archive`

### Task 4.6 — Quarantine + pending-quarantine lifecycle (mixed / all-quarantined)

- [ ] **Step 1: Write the failing tests** — `apps/cli/test/sync-cycle.test.ts` (quarantine section): secret-in-note does NOT wedge (mixed cycle: clean absorbs, dirty quarantined, cursor→head, exit 6, `pending_quarantine` records `firstSeenOid`); all-quarantined finalizes one empty-ChangePlan run (no integrate, no ref move, `run.*` appended, cursor advanced, `cycle_seq++`, `reconcileJobId:null`, exit 6); corrected path clears its stale pending entry (in the same finalize tx; reported in `clearedPending[]`); still-dirty re-quarantine preserves `firstSeenOid`.
- [ ] **Step 2: Run — expect FAIL.**
- [ ] **Step 3: Implement** — `apps/cli/src/sync/pending.ts` `reconcilePending(existing, { clearedPaths, upsertedDirty })` implementing the spec's *Pending-quarantine lifecycle* (set keyed by path; clear on clean-absorb/archive/rename-away; upsert on dirty preserving `firstSeenOid`; untouched otherwise). Catch the per-path secret-scan verdict in dispatch → record pending, no op, continue. Exit `6` when ≥1 attributable path quarantined (cursor still advances via finalize). The finalize tx writes the reconciled set (Task 4.2's `finalizeCursor`).
- [ ] **Step 4: Run — expect PASS.**
- [ ] **Step 5: Commit** — `feat(sync): quarantine + pending-quarantine lifecycle (mixed/all-quarantined, anti-wedge)`

### Task 4.7 — Exit-3 non-attributable, exit-4 per-path abort, `--dry-run`, `--max-paths`

- [ ] **Step 1: Write the failing tests** — split across `sync-dry-run.test.ts` and `sync-max-paths.test.ts` and `sync-cycle.test.ts`: non-attributable `GeneratedArtifactGuard` verdict → exit 3, cursor unadvanced; non-terminal per-path error → exit 4 `retryable:true`, cursor + pending unchanged; `--dry-run` mutates nothing (cursor/`cycle_seq`/pending unchanged, `quarantineId:""`, `clearedPending` planned-only, `appliedOps:0`, `reconcileJobId:null`, `cursorFrom==cursorTo`); `--max-paths n` advances cursor to the last fully-processed commit boundary (`truncated:true`), atomic oversize commit processed in full, second unbounded cycle resumes to head with every path absorbed once.
- [ ] **Step 2: Run — expect FAIL.**
- [ ] **Step 3: Implement** — the exit-3 branch (abort, cursor unadvanced) for `GeneratedArtifactGuard`; the exit-4 branch (abort on non-terminal per-path error, no partial finalize); `--dry-run` (compute + classify + scan preflight, mutate nothing, open no run); `--max-paths` (per-commit cumulative count check, advance to last fully-processed commit OID, atomic commit).
- [ ] **Step 4: Run — expect PASS.**
- [ ] **Step 5: Commit** — `feat(sync): exit-3/exit-4 aborts, --dry-run, --max-paths bounded continuation`

### Task 4.8 — Crash semantics (failpoints)

- [ ] **Step 1: Write the failing tests** — `apps/cli/test/sync-crash.failpoint.test.ts`: crash between broker integrate and cursor finalize → startup recovery **replays the persisted finalization intent** and idempotently completes fold + `index:reconcile` enqueue + cursor advance (the retry cannot re-derive the delta — the bytes are already present and classify `unchanged`); assert the cursor advanced to the intent's target OID, the `index:reconcile` job row is present, the `notes` projection and LanceDB index are current for the changed notes, and there is no duplicate note/blob; crash between audit append and ledger commit in an all-quarantined cycle → cursor unadvanced, no duplicate pending rows; crash after step 3 before step 4 → recovered by existing `reconcileRunsOnStartup`.
- [ ] **Step 2: Run — expect FAIL.**
- [ ] **Step 3: Implement** — insert failpoints at the two boundaries; ensure the finalize (cursor advance + pending reconcile + enqueue) is one transaction so a crash leaves an all-or-nothing state. **Extend `reconcileRunsOnStartup` to replay the sync finalization intent** (Task 4.4): for a run whose `refs/atlas/main` FF committed but whose cursor never advanced, idempotently finish `foldNotesForPaths` + `index:reconcile` enqueue + `finalizeCursor` from the intent's target OID + changed note IDs (never re-deriving from the now-`unchanged` diff). Register the new failpoints in `docs/specs/recovery-state-machine.md`'s `stateTable` and regen `failpoints.generated.md`.
- [ ] **Step 4: Run — expect PASS** (`pnpm failpoints:check` green).
- [ ] **Step 5: Commit** — `test(sync): crash-recovery failpoints (both directions), no duplicate/lost state`

### Task 4.9 — `sync status` handler + flip `implemented:true` + wire handlers

- [ ] **Step 1: Write the failing tests** — `apps/cli/test/sync-status.test.ts`: zero-state (`lastAbsorbedOid:null`, `cycleSeq:0`, `pendingQuarantine:[]`, `lastSyncedAt`=adoption seed, `upstreamRef:"refs/heads/main"`, `behindBy`=full count, `divergence.state:"ok"`); after a cycle (all fields well-typed, `behindBy:0` caught up, mixed cycle's `pendingQuarantine[]` carries `{path,quarantineId,firstSeenOid}`); **divergence surfaced** (`behindBy:null`, `divergence.state:"non-ancestral"`/`"cursor-unreachable"`).
- [ ] **Step 2: Run — expect FAIL.**
- [ ] **Step 3: Implement** — `readSyncStatus(deps)` in `apps/cli/src/commands/sync.ts`: read cursor, resolve upstream head, `detectDivergence`, compute `behindBy` (`null` when diverged), assemble the envelope. Register both handlers (`sync`, `sync status`) in the CLI barrel; flip both `commands.json` rows to `implemented:true`; `pnpm contract:write && pnpm contract:check`.
- [ ] **Step 4: Run — expect PASS** including `command-registration.test.ts` (implemented ⇒ handler registered) and `contract-lint`.
- [ ] **Step 5: Commit** — `feat(sync): sync status handler; flip sync + sync status implemented:true`

### Task 4.10 — `refs/heads/main` untouched invariant (the amended #60 gate) + docs

- [ ] **Step 1: Write the failing test** — `apps/cli/test/sync-cycle.test.ts`: snapshot `refs/heads/main` OID before/after a full E2E absorb; assert byte-identical; assert `refs/atlas/main` advanced.
- [ ] **Step 2: Run — expect PASS** (the design should already never write upstream); this locks it as the top-level regression gate.
- [ ] **Step 3: Docs** — add a `## brain sync` section to `apps/cli/CLAUDE.md` (cycle model, exit codes, divergence policy, `--dry-run`/`--max-paths`), update `README.md` command list, and add the divergence policy to the doc map.
- [ ] **Step 4: Run** `pnpm -r build && pnpm -r test && pnpm contract:check && pnpm failpoints:check` — green.
- [ ] **Step 5: Commit** — `test(sync): refs/heads/main untouched E2E gate; docs`

**Verification (Phase 4):** the full `sync-*` suites pass; `sync`/`sync status` are live (`implemented:true`); the divergence halt, single-run invariant, anti-wedge, `--dry-run`, `--max-paths`, crash recovery, and the `refs/heads/main` untouched gate all pass; `pnpm contract:check` + `pnpm failpoints:check` green.

**Rollback (Phase 4):** flip both rows back to `implemented:false`, `pnpm contract:write`, revert the `sync/` engine. `sync_cursors` data is inert without the command.

---

## Phase 5 — 60-B: `sync reset` — operator-authorized divergence recovery (OQ#5 escape hatch)

**Deployable slice:** `brain sync reset` — the privileged, broker-authorized recovery that re-converges `refs/atlas/main` to the current upstream tree after a REJECT halt. Without it, a diverged vault is wedged; this is the "operator action" REJECT requires.

**Files:**
- Modify: `docs/specs/cli-contract/commands.json` (+1 row: `sync reset`)
- Modify: `docs/specs/cli-contract/cli-surface.fixture.txt` (+1 line)
- Create: `docs/specs/cli-contract/sync-reset.schema.json`
- Modify: `docs/specs/security-broker-contract.md` (add `sync reset` to `privilegedOps` — challenge fields, mechanism, drift codes)
- Create: `apps/cli/src/sync/reset.ts` (tree-diff reconcile), `apps/cli/src/commands/sync-reset.ts`
- Test: `apps/cli/test/sync-reset.test.ts`, `apps/cli/test/sync-reset-authz.test.ts`

**Interfaces:**
- Produces: `sync reset` command (`phase 5`, `privileged`, `key-accepting`); `runSyncReset(deps, { authorization }): Promise<SyncResetResult>`.
- Consumes: broker authorization flow (`--export-challenge` → sign → `--authorization`), the broker's protected-ref rewrite path, `foldNotesForPaths`, `indexNotes` (full re-index), `repo.changedPaths` (tree-vs-tree), `finalizeCursor`.

### Task 5.1 — Contract row + schema + authz mapping

- [ ] **Step 1:** Insert `{ "name": "sync reset", "schemaRef": ".../sync-reset.schema.json", "phase": 5, "idempotency": "key-accepting", "privilege": "privileged", "implemented": false }` (name-sorted) in `commands.json`; add the fixture line `` `sync reset` — privileged: re-converge refs/atlas/main to upstream after a divergence halt. ``. Create `sync-reset.schema.json` with success envelope (`{ command, reBaselinedTo, archived[], captured[], reconcileJobId, cycleSeq }`, `reconcileJobId: string | null` — `null` on a history-only/empty reset) + `x-atlas-contract` (`privilege:"privileged"`, `idempotency:"key-accepting"`, `authz{op:"sync reset", mechanism, challengeFields, driftCodes, universalCodes}`, `exitCodes:[0,2,6]`, `errorCodes`).
- [ ] **Step 2:** Add `sync reset` to `security-broker-contract.md`'s `privilegedOps` (the bijection `contract-lint` enforces at `tools/cli-contract.ts:586-604`) with challenge fields (request-hash scope = upstream head OID + note globs) and drift codes.
- [ ] **Step 3:** `pnpm contract:write && pnpm contract:check` — expect green (`implemented:false`).
- [ ] **Step 4: Commit** — `feat(contract): sync reset privileged command row + authz mapping (implemented:false)`

### Task 5.2 — Authorization gate (no `--yes`, no auth ⇒ exit 6)

- [ ] **Step 1: Write the failing tests** — `apps/cli/test/sync-reset-authz.test.ts`: no `--authorization` ⇒ exit 6 (action-required); `--yes` never authorizes (still exit 6); test signer hard-rejected outside `ATLAS_TEST_MODE` (D20); a valid signed authorization proceeds.
- [ ] **Step 2: Run — expect FAIL.**
- [ ] **Step 3: Implement** — `apps/cli/src/commands/sync-reset.ts` gating: require `--authorization <path>`; verify via the broker authorizer exactly as `graduation migrate` / `db restore` do; `--yes` is inert.
- [ ] **Step 4: Run — expect PASS.**
- [ ] **Step 5: Commit** — `feat(sync): sync reset authorization gate (broker-authorized, never --yes)`

### Task 5.3 — Tree-diff reconcile + re-baseline + audit

- [ ] **Step 1: Write the failing tests** — `apps/cli/test/sync-reset.test.ts` (the §0 `sync reset` re-converge test): after a `diverged:non-ancestral` halt, an authorized `sync reset` makes `refs/atlas/main`'s tree equal the current upstream tree over the note globs; notes present only in the old `refs/atlas/main` become `archived` and their chunks drop; cursor re-baselined to head; `divergence.state` returns `ok`; a broker-signed `run.*` audit event records the reset; the following `sync` is a `behindBy==0` no-op. Also assert scan-before-persist still applies (a secret in the current upstream tree is quarantined during reset, not absorbed). Also cover **history-only divergence**: a force-push that rewrites history but leaves an **identical final tree** — `sync reset` re-baselines the cursor, integrates nothing, enqueues **no** reconcile job (`reconcileJobId: null`), returns `divergence.state: ok`, and does **not** throw on the empty note-ID union. Add a fault-injection test with multiple changed upstream paths proving no `refs/atlas/main` movement occurs before the single final integration (a crash mid-reconcile leaves the protected ref unmoved).
- [ ] **Step 2: Run — expect FAIL.**
- [ ] **Step 3: Implement** — `apps/cli/src/sync/reset.ts` `runSyncReset(deps, { authorization })`:
  - compute `repo.changedPaths(atlasTree, upstreamHeadTree, note_globs)` where `atlasTree = refs/atlas/main^{tree}`, `upstreamHeadTree = refs/heads/main^{tree}` (tree-vs-tree, not history);
  - **empty-diff (history-only divergence — rewritten history, identical final tree):** if the diff is empty, the trees already match — **skip integration and the reconcile job entirely** (do **not** enqueue `index:reconcile`; Tasks 2.3/3.1 reject an empty `noteIds`), still authorize + audit the accepted history gap, re-baseline the cursor to head, and return `reconcileJobId: null`. This is a common force-push case and must not throw;
  - map: paths only in `refs/atlas/main` → `ProposeArchive`; paths in upstream → `planCaptureSource` over the bytes at the snapshotted `refs/heads/main` commit (A/M, content-addressed, scan-before-persist) — **not** the integrating `captureSource` wrapper, so no path moves `refs/atlas/main` before the full reconciliation is accumulated into **one** ChangePlan;
  - one broker integrate (authorized protected-ref advance) of `refs/atlas/main` to the reconciled tree; `foldProvenanceFromCanonical` + full `foldNotesForPaths` over the union; enqueue a **full** `index rebuild`/`index:reconcile` over the union so retrieval re-converges;
  - `finalizeCursor` re-baseline: `last_absorbed_oid = upstreamHead`, `cycle_seq++`, reconcile pending against the fresh scan;
  - the broker-signed `run.*` event records the accepted history gap (auditable when/what).
- [ ] **Step 4: Flip `implemented:true`** for `sync reset`; register the handler; `pnpm contract:write && pnpm contract:check`.
- [ ] **Step 5: Run — expect PASS** (incl. `command-registration.test.ts`).
- [ ] **Step 6: Commit** — `feat(sync): sync reset tree-diff re-converge + re-baseline + audit; implemented:true`

### Task 5.4 — Docs

- [ ] **Step 1:** Document the full divergence lifecycle in `apps/cli/CLAUDE.md` (detect → REJECT halt → `sync status.divergence` → `sync reset` recovery) and `docs/install.md` (operator runbook for a force-push/gc event). Update the doc map.
- [ ] **Step 2: Commit** — `docs(sync): divergence detection + sync reset recovery runbook`

**Verification (Phase 5):** the force-push and gc halts (from Phase 4) plus the `sync reset` re-converge test all pass; `sync reset` requires authorization, rejects `--yes` and the test signer in prod; `contract:check` green.

**Rollback (Phase 5):** flip the row to `implemented:false`, revert. Phase 4's REJECT halt still protects correctness (a diverged vault safely halts and is observable) — only the automated recovery is lost; the operator falls back to a documented manual re-provision.

---

## Phase 6 — 60-B: launchd sync service, auto-hook closure, egress-key custody, acceptance gates

**Deployable slice:** the ingest→index auto-hook is closed. `com.atlas.sync.plist` runs the two-step wrapper on a 300 s timer under `atlas-agent`, with fail-closed Keychain custody of `ATLAS_EGRESS_CAPABILITY_KEY`. The E2E acceptance gates (`index eval`, D20) pass on the adopted corpus.

**Upstream-fetch prerequisite.** `brain sync` reads the **local** `refs/heads/main`; `atlas-agent` is network-denied (D17), so the wrapper cannot fetch. Advancing local `refs/heads/main` from the GitHub remote is the job of the **existing brain-hub sync** (the network-capable puller already mirroring main-vault) — it updates **only** `refs/heads/main` (never `refs/atlas/main`), and its successful pull is a **provisioning prerequisite** of enabling `com.atlas.sync.plist`. A direct GitHub push is observed only after that puller lands it locally; the timer's cadence is deliberately downstream. Task 6.3's install gate asserts the puller is provisioned before enabling the timer.

**Files:**
- Create: `provisioning/macos/com.atlas.sync.plist`, `provisioning/macos/atlas-sync-wrapper.sh`
- Modify: `provisioning/` install scripts (register/enable the service, gated on keychain-unlock provisioning), `docs/install.md`, `apps/cli/CLAUDE.md`, `provisioning/CLAUDE.md`
- Test: `apps/cli/test/sync-autohook.test.ts` (wrapper sequence, in-process), `provisioning/test/sync-plist.test.ts` (plist shape)

**Interfaces:**
- Consumes: `brain sync --json`, `brain jobs run --workflow index:reconcile --json`, the egress mint path (`ATLAS_EGRESS_CAPABILITY_KEY`), `index eval` gate.

### Task 6.1 — Two-step wrapper reflects a change end-to-end

- [ ] **Step 1: Write the failing test** — `apps/cli/test/sync-autohook.test.ts`: drive the wrapper's exact sequence (`brain sync --json` then `brain jobs run --workflow index:reconcile --json`) over a committed upstream note change; assert the change is retrievable afterward (chunks re-embedded, `active_generation_id` current) within the single wrapper invocation. Break: the chain drops the enqueued job (sync advances, reconcile never drains). Also drive a **mixed** cycle (one clean note + one quarantined) where `brain sync` exits 6: assert `set -e` does not abort the wrapper, the drain still runs, and the clean note becomes retrievable.
- [ ] **Step 2: Run — expect FAIL.**
- [ ] **Step 3: Implement** — `provisioning/macos/atlas-sync-wrapper.sh` (`set -euo pipefail`): fetch `ATLAS_EGRESS_CAPABILITY_KEY` from Keychain (`security find-generic-password -w -s atlas-egress-capability -a atlas-agent`), export it for the two `brain` invocations only, run `brain sync --json` capturing its exit code without tripping `set -e` (`set +e; brain sync --json; rc=$?; set -e`), then run `brain jobs run --workflow index:reconcile --json` when `rc` is **0 or 6** (exit 6 is the success-envelope mixed/all-quarantined outcome that still advanced the cursor and enqueued reconcile, so the clean notes must still be drained), and exit non-zero without draining for any true-abort status (2/3/4). Never write the key to disk/temp/audit.
- [ ] **Step 4: Run — expect PASS.**
- [ ] **Step 5: Commit** — `feat(provisioning): atlas-sync-wrapper two-step auto-hook`

### Task 6.2 — Fail-closed key custody + rotation/revocation

- [ ] **Step 1: Write the failing tests** — `apps/cli/test/sync-autohook.test.ts`: missing key (`ATLAS_EGRESS_CAPABILITY_KEY` absent) ⇒ `index:reconcile` fails to mint, exits 4/6, no partial/unscanned persist, no cursor corruption; rotated key takes effect next cycle; deleted key hard-revokes (fail-closed no-op + retry).
- [ ] **Step 2: Run — expect FAIL.**
- [ ] **Step 3: Implement** — ensure the mint path fails closed on absent/locked key (never falls back to a credential-less egress); document the rotation flow (replace the `atlas-agent` Keychain item + the `atlas-egress` broker copy; in-flight capabilities expire on TTL). **Flag the CI parity gap** (the real Keychain-fetch + two-custody-point rotation is not exercised by CI — verified only by the live-drive runbook).
- [ ] **Step 4: Run — expect PASS** (the unset-env fail-closed path is unit-tested).
- [ ] **Step 5: Commit** — `feat(provisioning): fail-closed egress key custody + rotation/revocation docs`

### Task 6.3 — plist + provisioning gate

- [ ] **Step 1: Write the failing test** — `provisioning/test/sync-plist.test.ts`: `com.atlas.sync.plist` has `StartInterval` 300, runs the wrapper, runs as `atlas-agent`, references **no** secret in `EnvironmentVariables`.
- [ ] **Step 2: Run — expect FAIL.**
- [ ] **Step 3: Implement** — `provisioning/macos/com.atlas.sync.plist` (`StartInterval` 300, `ProgramArguments` → wrapper, `UserName` atlas-agent, stdout/stderr logs per the existing daemon pattern). Install script: **the service stays disabled until both the keychain-unlock prerequisite (OQ#1 gate) and the brain-hub upstream puller (upstream-fetch prerequisite) are provisioned** — never enabled in a state that fail-closes every cycle or silently ignores remote pushes. Interactive-session posture only in this phase (headless/logged-out unlock deferred per OQ#1(b)).
- [ ] **Step 4: Run — expect PASS.**
- [ ] **Step 5: Commit** — `feat(provisioning): com.atlas.sync.plist launchd service (gated on keychain-unlock)`

### Task 6.4 — Acceptance gates on the adopted corpus + docs

- [ ] **Step 1:** Run `index eval` on the adopted corpus; assert **recall@10 ≥ 0.85 AND MRR ≥ 0.70** (consumes `docs/specs/acceptance-thresholds.md`; current live 0.878/0.784 vector-only, 0.911/0.830 hybrid). Assert `broker.rejects-test-signer-in-prod` (D20).
- [ ] **Step 2:** Docs: `docs/install.md` §0 quickstart adds "enable continuous sync"; `provisioning/CLAUDE.md` documents the new service + key custody + the CI parity gap; `apps/cli/CLAUDE.md` notes the auto-hook closes the ingest→index gap #60 left open.
- [ ] **Step 3:** Run the full gate suite: `pnpm -r build && pnpm -r test && pnpm contract:check && pnpm failpoints:check` — green.
- [ ] **Step 4: Commit** — `feat(sync): acceptance gates on adopted corpus + provisioning docs`

**Verification (Phase 6):** the wrapper reflects a committed change end-to-end within one invocation; missing/rotated/deleted key behaves fail-closed; the plist is well-formed and gated on keychain-unlock; `index eval` and D20 gates pass. **Live-drive** (per repo policy — local-only is insufficient for anything touching GCP/git/egress): run the real wrapper on the adopted vault, confirm a committed edit is retrievable within one cadence and `refs/heads/main` is byte-unchanged.

**Rollback (Phase 6):** `launchctl unload` + disable the plist; sync reverts to manual (`brain sync` on demand). No data change.

---

## Follow-on issue sequencing (60-C / 60-D / 60-E) + residuals

Peeled out per spec `open-questions` #6, each only loosely coupled to the sync core and each substantial enough to blow the 2-round review cap if bundled. **Sequence after 60-A + 60-B land:**

1. **60-D — `tools/scale-bench.ts` (synthetic 5k/50k profiles) + CI regression subset.** *Sequence first of the three* — it closes the **at-scale half of the O(delta) success criterion** this plan proves only at single-note granularity (Phase 2/4 assert payload cardinality = 1 and N-1 untouched; 60-D proves the delta path stays O(delta) at 5k/50k). Depends only on the sync engine (Phase 4). Own issue, own plan.
2. **60-C — Purge E2E across every storage class** (depends on **#54**). Contract: `docs/specs/retention-matrix.md`. Independent of sync internals; gated on #54 landing. Own issue.
3. **60-E — Tier-2/Tier-3 workflow runs + rollback on the migrated copy** under the production OS-presence/hardware-backed authorizer (Flow B). The real-copy privileged apply stays **human-gated** (test signer hard-rejected outside `ATLAS_TEST_MODE`, D20). Own issue; largest ceremony (production authorizer).

**Residual hardening issues to file:**
- **OQ#1 residual** — broker-mediated per-run capability handoff (no standing agent-side secret) + headless/logged-out keychain-unlock story. Blocks enabling the sync daemon for a genuinely unattended session. Owner: operator.
- **OQ#4 / atlas #218** — trust read-surface defect (`source.ts:40`). Independent of adoption. Owner: operator.

Recommended order: **#216 (prereq) → 60-A → 60-B → 60-D → 60-C (after #54) → 60-E**, with OQ#1-residual and #218 filed in parallel.

---

## Self-Review

**1. Spec coverage.** Every spec section maps to a task:
- `interfaces` new commands → Phase 4 (`sync`, `sync status`) + Phase 5 (`sync reset`, the OQ#5 recovery the spec's interfaces did *not* cover — added by §0). `sync_cursors` table → Task 1.3. `indexNotes` → Task 2.3. `foldNotesForPaths` → Task 2.2. `index:reconcile` job → Phase 3. launchd service → Phase 6.
- `behavior` cursor semantics / pending lifecycle / single-run invariant / crash / `--max-paths` / `--dry-run` / error+edge → Tasks 4.4–4.8.
- `security` protected ref / scan-before-persist / trust / egress custody / audit → Tasks 1.2, 4.5, 6.2. Trust read-surface (OQ#4) → split (§0.1).
- `test-plan` — every named break scenario maps to a test task (4.3–4.10, 6.1–6.4). The spec's **uncovered** divergence gap (OQ#5) → §0 + Tasks 4.3, 5.3.
- `ssot` — `sync_cursors` excluded from rebuild (Task 1.4); command membership only in `commands.json` (Tasks 4.1, 4.9, 5.1).

**2. Placeholder scan.** No "TBD"/"handle edge cases"/"similar to Task N". Code shown where code changes; exact paths + commands throughout. The few "only if red" steps (1.4, 3.3) are regression-lock tests where the primitive may already hold — the corrective action is spelled out.

**3. Type consistency.** Verified against the real code: `IndexDeps` (not `ReconcileDeps`), `foldProvenanceFromCanonical(store, repo, ref)`, `noteFences(store)` exported + `noteFencesForNotes`, `changedPaths` added to `Repo`, `ReconcileReport` fields (`scanned/reembedded/unchanged/removed/results`) consistent between Task 2.3 and Phase 3, `JobSpec { workflow, idempotencyKey, payload, maxAttempts? }`, `PRIVILEGE = shared|privileged` (spec's standard/readonly → `shared`), idempotency `intrinsic`/`none`/`key-accepting`. Three spec↔code deltas surfaced up front in §0.2 so implementers aren't blindsided.

**Known deviations from the spec's framing (deliberate, documented):** (a) adoption is *not* pure config — the canonical ref must be made config-driven first (§0.2 #2, Task 1.2); (b) #216 is a hard prerequisite, not a landed pattern (§0.2 #1, Phase 3 header); (c) OQ#5 is *resolved* (REJECT + `sync reset`), adding a command and a `sync status` field the spec's interfaces left open (§0).

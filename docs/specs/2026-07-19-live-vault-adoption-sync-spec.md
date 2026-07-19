I'll revise only the four non-satisfied sections (`interfaces`, `behavior`, `security`, `test-plan`), leaving the five satisfied/`n_a` sections untouched, and output the full spec.

# Live-Vault Adoption & Continuous Sync (Atlas issue #60)

## intent — Intent & Soundness

**Problem.** `Vaults/main-vault` is a live git repository (`git@github.com:21StarkCom/stark-2nd-brain.git`, 211 markdown notes) written continuously by three uncoordinated writers: brain-hub sync, Obsidian edits, and direct GitHub pushes — 19 of the last 20 commits are live-writer traffic. Aryeh wants this vault synced into Atlas **continuously**, which is precisely the "ingest→index auto-hook" slice that issue #60 still owes. Two facts collide:

1. Atlas's `atlas-broker` is the **sole** mutator of its canonical ref (design D13). Naive adoption — pointing Atlas at `refs/heads/main` as its canonical ref — would structurally lock brain-hub and Obsidian out of the vault, since only the broker could then fast-forward `main`.
2. Atlas indexing is today **100% manual**. The `reindexed` checkpoint at `apps/cli/src/ingest/capture.ts:471` is a workflow-state label with a hardcoded `indexGeneration: 1`; it touches no LanceDB. Nothing in `@atlas/lancedb-index` is called from any capture path. This was a deliberate deferral (`docs/plans/2026-07-17-search-index-live-build-plan.md:42`: "any ingest→index auto-hook" out of scope; "the index is disposable derived state converged by `index repair`/`rebuild`"). **This spec reverses that deferral.**

**Design (operator-approved, binding).** *Adoption without eviction.*

- Atlas's `vault.path` becomes `/Users/aryeh/Code/Vaults/main-vault`. Atlas takes a **separate, broker-owned, protected canonical ref `refs/atlas/main`**. `refs/heads/main` is left untouched and unaware of Atlas — brain-hub, Obsidian, and GitHub keep writing it freely.
- **Sync is a one-way absorb.** `refs/heads/main` is upstream. A new `sync_cursors` row holds the last fully-absorbed upstream commit OID. Each cycle computes `git diff --name-status <cursor>..refs/heads/main` over the note globs and feeds each changed path through the **existing, unmodified `captureSource` pipeline** (`apps/cli/src/ingest/capture.ts:359`) — scan-before-persist intact, no bypass. The broker CAS-fast-forwards `refs/atlas/main`; the cursor advances only after the broker integrates.
- **Trigger is a launchd timer over a git-rev cursor**, not `fs.watch`. Deterministic, resumable, no filesystem event stream. Fits the existing daemon pattern (`com.atlas.broker.plist` / `com.atlas.egress.plist`, live since 2026-07-19).
- The auto-hook closes three gaps the current code leaves open: an **origin cursor** (GAP 2 — nothing tracks "what changed at a source since last time"), an **incremental projection fold into `notes`** (GAP 3 — `notes` is written only by `db rebuild`, so after a sync the index has no fences), and a **note-scoped index reconcile** (GAP 1 — no `indexNotes`, no delta feed) so indexing stays O(delta), not O(corpus).

**Why this over the alternatives.** *Bidirectional sync* was rejected — Atlas would fight three live writers for `refs/heads/main` and the broker's sole-mutator invariant cannot be shared. *main-vault as an upstream "source" that Atlas copies into its own repo* was rejected — it doubles the note bytes on disk and orphans the git provenance the vault already carries. *`fs.watch`/chokidar* was rejected — non-deterministic, non-resumable, no crash story, and no watcher exists anywhere in the codebase to build on. Adoption-without-eviction is the only model that keeps the broker's invariant intact while leaving the live writers undisturbed.

**Enabling fact.** `foldProvenanceFromCanonical(store, repo, canonicalRef)` (`apps/cli/src/ingest/manifests.ts:265`) already takes `canonicalRef` as a parameter. Adoption under `refs/atlas/main` is **config + provisioning, not surgery** on the ingest engine.

**Success criteria (objective).**
- `refs/heads/main` of main-vault is **never written by any Atlas identity** across the entire phase (asserted; supersedes #60's original "HEAD unchanged" invariant — see `scope`).
- A committed change to a note on `refs/heads/main` is reflected in Atlas retrieval within one sync cadence, with the changed note's chunks re-embedded and its `notes.active_generation_id` current.
- A secret introduced into a changed note is quarantined before persist and **does not wedge** sync for the other notes.
- The sync delta path is **O(delta), not O(corpus)**: a single-note upstream change re-embeds exactly that note (asserted in `test-plan`; at-scale validation is deferred to 60-D — see `scope`).
- `index eval` on the adopted corpus holds **recall@10 ≥ 0.85 AND MRR ≥ 0.70** (`docs/specs/acceptance-thresholds.md`).
- `broker.rejects-test-signer-in-prod` holds (D20).

**Finalized vs. open.** Finalized: the ref model, the one-way-absorb model, the launchd+cursor trigger, and the **60-A + 60-B adoption-and-sync scope** (60-C/D/E deferred to follow-on issues — see `scope` and `open-questions` #5). Open (see `open-questions`): `ATLAS_EGRESS_CAPABILITY_KEY` residual hardening under launchd; whether `refs/atlas/main` lives in main-vault itself or a broker-owned bare mirror; uncommitted-edit cadence; whether the trust read-surface defect is fixed here.

## scope — Scope & Boundaries

**Tier.** This is a **single-user, local, personal-tooling playground with a production-grade security kernel**. The user-count dimension is playground: no HA, no multi-tenant, no multi-vault, no horizontal scale, no rollout ceremony. The **security dimension is non-negotiably production-grade** — privilege-separated brokers, scan-before-persist, WORM audit anchor, fail-closed trust. Every bar below is matched to that split: absence of HA/multi-tenant machinery is correct restraint; absence of any security control is a gap.

**In scope — the adoption-and-sync core (60-A + 60-B).** These two sub-projects are tightly coupled and constitute the whole of this spec:

- **60-A — Adoption.** Repoint `vault.path`; add `refs/atlas/main` to the broker's protected-ref set; provisioning + config for the adopted vault.
- **60-B — Continuous sync.** New `brain sync` / `brain sync status` commands; `sync_cursors` table; incremental projection fold; scoped `indexNotes` + `index:reconcile` job kind and handler; launchd sync service.

**Deferred to follow-on issues (explicitly out of this spec).** These three #60 sub-projects are only loosely coupled to the adoption/sync core, each substantial, and each carries independent risk. This spec's plan **sequences them as follow-on issues after 60-A + 60-B land** (decision recorded in `open-questions` #5):

- **60-C — Purge E2E across every storage class** (depends on #54). Contract: `docs/specs/retention-matrix.md`.
- **60-D — `tools/scale-bench.ts` (synthetic 5k/50k profiles) + a CI regression subset.** Validates the O(delta) claim at scale.
- **60-E — Tier-2/Tier-3 workflow runs + rollback on the migrated copy** under the production OS-presence/hardware-backed authorizer (Flow B).

**Out of scope (declared boundaries, binding):**
- **Bidirectional sync / writing `refs/heads/main`.** Atlas is a strict downstream reader of upstream `main`.
- **`fs.watch`/inotify/FSEvents.** Cursor-diff polling only.
- **Multi-vault / multi-source continuous sync.** One adopted vault (main-vault). The `sync_cursors` schema is keyed by `source_id` to not preclude a second vault later, but no second source is built.
- **Purge/erase driven by sync.** An upstream note deletion maps to non-destructive `ProposeArchive`, never `ProposeDelete`/`erase` (see `behavior`). Destructive purge stays a separately human-gated operation (and its E2E is deferred with 60-C).
- **A generic scheduler/pipeline framework.** The launchd timer + `jobs run` drain is the whole mechanism; no orchestration layer is introduced.

## interfaces — Interfaces & Contracts

### New CLI commands (contract change per the CLI-contract workflow)

Adding each command requires: one name-sorted row in `docs/specs/cli-contract/commands.json` (currently v1, 50 commands), the matching `` `name` — desc `` line in `cli-surface.fixture.txt` under its phase heading, a `docs/specs/cli-contract/<name-with-spaces→hyphens>.schema.json`, then `pnpm contract:write`. `contract-lint.test.ts` binds each schema's `command`/phase/privilege/idempotency to its row; `command-registration.test.ts` guards the not-implemented-at-live-drive class. Both new commands sit in the **graduation phase** (the bucket that holds `graduation *`); the exact phase token is set at contract-write time and must match the sibling graduation rows.

**`sync`** — run one absorb cycle for the adopted vault.

- Privilege: `standard` (unprivileged `atlas-agent`; the broker signs `run.integrated` and fast-forwards `refs/atlas/main` via the existing integrate path — this is **not** a `--export-challenge` privileged mutation, exactly as `ingest --apply` is not).
- Idempotency: **idempotent**. Re-running with an unchanged upstream head is a no-op (cursor already at head); a crash-interrupted cycle re-derives from the unadvanced cursor and content-addressed dedup makes re-capture a no-op fast-forward.

Flags:

| flag | type | required | default | constraints |
|---|---|---|---|---|
| `--dry-run` | boolean | no | `false` | compute + print diff and planned actions; mutate nothing (see `behavior`) |
| `--max-paths <n>` | integer | no | unbounded (flag omitted) | `n ≥ 1`; bounds one cycle at a commit boundary (see `behavior`) |
| `--json` | boolean | no | `false` | required for machine/daemon use, per repo convention |

Success envelope (`--json`, exit `0`/`6`):

| field | type | required | notes |
|---|---|---|---|
| `cursorFrom` | `string \| null` | yes | 40-hex git OID last absorbed; `null` on first absorb |
| `cursorTo` | `string` | yes | 40-hex OID the cursor advanced to (= last fully-processed commit; = `upstreamHead` on an unbounded/fully-drained clean cycle); **equals `cursorFrom`** on a no-run outcome (`--dry-run` or `behindBy == 0`), where the cursor does not move |
| `upstreamHead` | `string` | yes | 40-hex OID of `refs/heads/main` snapshotted at cycle start |
| `absorbed` | `array` | yes | may be empty |
| `absorbed[].path` | `string` | yes | repo-relative note path |
| `absorbed[].noteId` | `string` | yes | `NoteId` |
| `absorbed[].contentId` | `string` | yes | `contentId` |
| `absorbed[].action` | `enum` | yes | `"created" \| "modified" \| "unchanged"` |
| `quarantined` | `array` | yes | may be empty |
| `quarantined[].path` | `string` | yes | |
| `quarantined[].quarantineId` | `string` | yes | opaque quarantine handle; the empty string `""` (sentinel: no record persisted) under `--dry-run` |
| `archived` | `array` | yes | may be empty |
| `archived[].path` | `string` | yes | |
| `archived[].noteId` | `string` | yes | |
| `renamed` | `array` | yes | may be empty |
| `renamed[].fromPath` | `string` | yes | |
| `renamed[].toPath` | `string` | yes | |
| `renamed[].noteId` | `string` | yes | |
| `clearedPending` | `array` | yes | may be empty; paths whose stale `pending_quarantine` entry was removed this cycle because the path scanned clean / was archived / was renamed away (see `behavior`, *Pending-quarantine lifecycle*) |
| `clearedPending[].path` | `string` | yes | repo-relative note path that left the pending set |
| `clearedPending[].quarantineId` | `string` | yes | the quarantine handle of the entry that was removed |
| `appliedOps` | `integer` | yes | `≥ 0`; count of ChangePlan ops the cycle's single run applied — the number of `absorbed[]` entries whose `action` is `"created"` or `"modified"`, **plus** the `archived` and `renamed` counts. **`absorbed[]` entries with `action: "unchanged"` are excluded**: an identical-bytes re-observation bumps `observation_count`/`last_seen_at` only and yields **no** ChangePlan op (see `behavior`), so it must not be counted. Consequently `appliedOps` is `0` not only on an all-quarantined or empty-delta cycle, on `--dry-run`, and on a `behindBy == 0` no-delta cycle, but **also on a cycle whose absorbed paths were all `unchanged` re-observations** (a non-empty delta that touches only byte-identical notes). Clearing a stale pending entry is a `sync_cursors` write, not a ChangePlan op, and is likewise **not** counted in `appliedOps`. |
| `reconcileJobId` | `string \| null` | yes | enqueued `index:reconcile` job id; `null` when `appliedOps == 0` (nothing to re-index — empty delta, every path quarantined, or every absorbed path was an `unchanged` re-observation; no job enqueued) and on `--dry-run` (nothing enqueued) |
| `cycleSeq` | `integer` | yes | `≥ 0`; the value of `sync_cursors.cycle_seq` after the cycle — **post-increment** on a finalized run (clean / mixed / all-quarantined); the **current, unchanged** value on a no-run outcome (`--dry-run` or `behindBy == 0`), which does **not** increment |
| `truncated` | `boolean` | yes | `true` when `--max-paths` stopped the cycle before head (more commits remain); `false` on a no-run outcome (`behindBy == 0`) |

**No-run outcomes (`--dry-run` and `behindBy == 0`).** Two paths open no run and therefore mutate nothing; both still return the full success envelope with the fields pinned as follows:

- **`--dry-run`** (any `behindBy`): `absorbed`/`archived`/`renamed`/`quarantined` carry the *planned* per-path classification (the scan preflight still runs, so a would-be-dirty path appears in `quarantined` with `quarantineId: ""`); `clearedPending` carries the *planned* removals (paths that currently hold a pending entry and would scan clean / archive / rename-away this run) but **nothing is removed**; `appliedOps: 0`; `reconcileJobId: null`; `cursorFrom == cursorTo` = the current (unmoved) cursor; `upstreamHead` = current head; `cycleSeq` = the current, unincremented `sync_cursors.cycle_seq`; `truncated` reflects whether `--max-paths` *would* bound the plan. Exit `0`.
- **`behindBy == 0` (no delta):** the step-2 short-circuit fires before any run opens. `absorbed`/`quarantined`/`archived`/`renamed`/`clearedPending` all empty; `appliedOps: 0`; `reconcileJobId: null`; `cursorFrom == cursorTo == upstreamHead` (all equal); `cycleSeq` = the current, unincremented value; `truncated: false`. Exit `0`.

Exit codes: `0` clean cycle; `6` (action-required) if ≥1 **attributable** path was quarantined (cursor still advanced, pending list in envelope) — this includes the all-quarantined cycle, which finalizes with `appliedOps: 0` (see `behavior`); `2` config/vault/lock (e.g. `locked:jobs-runner` / `locked:vault-maintenance`, or `backup-unhealthy`); `3` (secret-scan) **only** on a **non-attributable** dirty verdict — a `GeneratedArtifactGuard` verdict on bytes Atlas itself generates (manifest/rendition artifacts under `sources/**`), which cannot be charged to a single upstream path and so cannot be skipped past, aborting the cycle with the cursor **unadvanced**. Per-path upstream secret verdicts are **not** exit 3 — they are attributable, quarantined, and skipped at exit `6` (see `behavior`). `4` internal (a non-terminal per-path error aborts the cycle with the cursor unadvanced).

**`sync status`** — read the cursor and pending state.

- Privilege: `readonly`. Idempotency: idempotent (pure read).

Success envelope (`--json`, exit `0`):

| field | type | required | notes |
|---|---|---|---|
| `sourceId` | `string` | yes | adopted-vault source id |
| `upstreamRef` | `string` | yes | `"refs/heads/main"` |
| `lastAbsorbedOid` | `string \| null` | yes | 40-hex OID; `null` before first cycle (seed-row zero-state) |
| `upstreamHead` | `string` | yes | 40-hex OID of `refs/heads/main` now |
| `behindBy` | `integer` | yes | `≥ 0`; count of upstream commits between `lastAbsorbedOid` and `upstreamHead`; before the first cycle (`lastAbsorbedOid == null`) this is the full commit count to the empty-tree base |
| `lastSyncedAt` | `string` | yes | RFC3339 UTC; **never null** — the `sync_cursors` row is seeded at adoption (see the table note below), so before the first cycle this is the **adoption seed timestamp**, and after each cycle it is that cycle's finalize time |
| `cycleSeq` | `integer` | yes | `≥ 0`; `0` at the seed-row zero-state |
| `pendingQuarantine` | `array` | yes | may be empty (`[]` at zero-state) |
| `pendingQuarantine[].path` | `string` | yes | |
| `pendingQuarantine[].quarantineId` | `string` | yes | |
| `pendingQuarantine[].firstSeenOid` | `string` | yes | 40-hex OID where the dirty bytes first appeared |

**Zero-state (before the first cycle).** Because the row is seeded at adoption (never lazily on first cycle), `sync status` on a freshly adopted vault always resolves a row and returns: `lastAbsorbedOid: null`, `cycleSeq: 0`, `pendingQuarantine: []`, `lastSyncedAt` = the adoption seed timestamp (a real RFC3339 value, not null), `upstreamRef: "refs/heads/main"`, `sourceId` = the adopted-vault source id, `upstreamHead` = the current `refs/heads/main` OID, and `behindBy` = the full commit count to the empty tree. It never throws for a missing row and never reports a null/absent `lastSyncedAt`.

Exit codes: `0`; `2` config/vault.

**Error envelope (both commands).** Non-zero single-error exits use the repo's **existing single-error envelope** (the same shape every non-batch `brain` command emits) — sync introduces no new envelope shape:

```
{ "error": { "code": string, "message": string, "retryable"?: boolean, "retryAfterMs"?: integer } }
```

`code` is one of the enumerated values below; `message` is human-readable and actionable; `retryable`/`retryAfterMs` ride the transient cases per the repo convention (`retryAfterMs` is milliseconds, integer, present only when `retryable: true`).

| `code` | exit | retryable | meaning |
|---|---|---|---|
| `locked:jobs-runner` | 2 | yes | the drain lock is held; retry next cadence |
| `locked:vault-maintenance` | 2 | yes | another maintenance op holds the vault-maintenance lock |
| `backup-unhealthy` | 2 | no | degraded backup blocks ledger-writing runs by design |
| `config` / `vault` | 2 | no | vault path / config resolution failure |
| `secret-scan` | 3 | no | non-attributable dirty verdict (`GeneratedArtifactGuard` on Atlas-generated manifest/rendition bytes); cycle aborts, cursor **unadvanced**, bytes quarantined |
| `internal` | 4 | yes | non-terminal per-path error; cursor unadvanced, cycle aborted |

Exit-code coverage (audited exhaustive): every exit `sync` can emit — `0`, `2`, `3`, `4`, `6` — is accounted for by either a **success-envelope** mapping or an error-envelope row. `0` (clean cycle) and `6` (≥1 attributable path quarantined, cursor advanced — including the all-quarantined `appliedOps: 0` case) are success-envelope outcomes (above); `2`, `3`, `4` are the rows here. `sync status` emits only `0`/`2`.

### New durable table — `sync_cursors` (owned by `@atlas/sqlite-store`, new forward migration)

```sql
CREATE TABLE sync_cursors (
  source_id           TEXT PRIMARY KEY,            -- adopted-vault source id; one row for main-vault
  upstream_ref        TEXT NOT NULL,               -- 'refs/heads/main'
  last_absorbed_oid   TEXT,                        -- upstream commit OID last fully PROCESSED (every changed
                                                   --   path absorbed OR quarantined-and-recorded); NULL before first cycle
  last_synced_at      TEXT NOT NULL,               -- RFC3339 UTC
  cycle_seq           INTEGER NOT NULL DEFAULT 0,  -- monotonic cycle counter
  pending_quarantine  TEXT NOT NULL DEFAULT '[]'   -- JSON: [{path, quarantineId, firstSeenOid}]
) STRICT;
```

- **Row seeded at adoption (60-A provisioning), not lazily on first cycle.** Repointing the vault inserts the source's row with `last_absorbed_oid = NULL`, `cycle_seq = 0`, `pending_quarantine = '[]'`, and `last_synced_at =` the adoption timestamp. This is why the `last_synced_at NOT NULL` column always holds a value and why `sync status`'s `lastSyncedAt` is never null even at the pre-first-cycle zero-state.
- `source_id` is the system of record for the adopted vault's identity; `last_absorbed_oid` is the SSOT for "how far Atlas has processed upstream." **Authoritative, non-derived state — must be excluded from `rebuildProjections`** (it cannot be re-derived from git and must survive `db rebuild`, like `jobs`). `content_hash`/`origin` remain content-addressed as today.
- `pending_quarantine` element shape (validated on write): `{ path: string (required), quarantineId: string (required), firstSeenOid: string (required, 40-hex) }`. The column is a validated JSON array; a malformed element is a write-time error, not a silently-tolerated value. The array is a **set keyed by `path`** — at most one pending entry per path — and is reconciled every finalized cycle (entries removed when the path is corrected, upserted when re-quarantined; see `behavior`, *Pending-quarantine lifecycle*), so it can never accumulate a stale entry for a path that has since gone clean.

### New library API — scoped index reconcile (`@atlas/lancedb-index`)

```ts
indexNotes(deps: ReconcileDeps, noteIds: NoteId[]): Promise<ReconcileReport>
```

- `noteIds` — non-empty array of valid `NoteId`; an empty array is a caller error (the enqueue path never emits an empty payload). Duplicates are de-duplicated internally.
- Returns the note-scoped analog of `reconcileIndex(deps)` (`packages/lancedb-index/src/activate.ts:435`). Iterates only the supplied `noteIds`, reusing `indexNote`'s existing fast path (`activate.ts:338-357`: if `activeGenerationId === generationIdFor(...)` and `verifyComplete(...)` ⇒ `{kind:"unchanged"}`, no re-embed). It does **not** drop the table (unlike `index rebuild`), so unchanged notes are never re-embedded. Fences come from `notes` via `noteFences(store)` (`apps/cli/src/commands/index-ops.ts:71`), filtered to `noteIds`.

`ReconcileReport` (return contract):

| field | type | notes |
|---|---|---|
| `scanned` | `integer` | count of `noteIds` examined |
| `reembedded` | `integer` | notes whose chunks were re-embedded |
| `unchanged` | `integer` | notes that hit the fast path |
| `removed` | `integer` | notes whose chunks were dropped (archived/deleted) |
| `results` | `array` | per-note: `{ noteId: string, kind: "reembedded" \| "unchanged" \| "removed" }` |

`scanned == reembedded + unchanged + removed`.

### New library API — incremental projection fold (`@atlas/sqlite-store`)

```ts
foldNotesForPaths(store: Store, repo: GitRepo, canonicalRef: string, noteIds: NoteId[]): void
```

Reconciles the `notes` projection for exactly the supplied `noteIds` against `refs/atlas/main`, deriving each note's state the same way `rebuildProjections` does (`rebuild.ts:139`, `:199`) but scoped to `noteIds`. Two lifecycle outcomes, one per `noteId`:

- **Note still resolves at `canonicalRef` (add/modify).** Upserts the row's `note_id`, `content_hash`, and `active_generation_id` with lifecycle `active`. Idempotent upsert keyed by `note_id`.
- **Note no longer resolves at `canonicalRef` (the `D`/delete case in `behavior`).** Sets the row's lifecycle to **`archived`** — the same non-destructive lifecycle state `rebuildProjections` derives for a note absent from the ref. This is the lifecycle mutation the delete path depends on: an archived note drops out of index activation, so a subsequent `indexNotes` reports it `removed` and drops its LanceDB chunks. The row and its content-addressed history are **retained** (archive is reversible; nothing is erased). `content_hash`/`active_generation_id` are left as-is on the archived row (a re-added note re-derives them on the next fold).

Idempotent, keyed by `note_id` — re-running yields byte-identical rows whether the note is active or archived. Runs agent-side (SQLite projection write; `notes` is projection state, not a protected ref). Returns `void`; throws on a derivation error (surfaced as the cycle's `internal` abort).

### New job kind — `index:reconcile` (`@atlas/jobs` + CLI handler registry)

- Enqueued via `enqueue(tx, {workflow: "index:reconcile", idempotencyKey: <run canonical commit OID>, payload: {noteIds}})` (`packages/jobs/src/repo.ts:213`) in the **same ledger tx as the cycle's single run finalize** (see `behavior`, *Run and transaction boundary — the single-run invariant*). Enqueued **only** when the run's ChangePlan is non-empty (≥1 clean path yielded a `noteId`); an all-quarantined or empty-delta cycle enqueues no reconcile job (`reconcileJobId: null`).
- Payload contract (validated at enqueue): `{ noteIds: NoteId[] }` — non-empty array of valid `NoteId`. `idempotencyKey` = the run's `refs/atlas/main` commit OID (40-hex string). `ON CONFLICT (workflow, idempotency_key) DO NOTHING` makes double-enqueue a no-op.
- **Handler registration.** `registerJobHandler("index:reconcile", handler)` (`apps/cli/src/commands/jobs.ts:51`) at barrel import. **This fixes a pre-existing production breakage:** `JOB_HANDLERS` is `{}` in prod today (`jobs.ts:48`; only `installTestJobHandler` under `ATLAS_TEST_JOB_HANDLER=1`), so **every enqueued job currently fails `internal` when drained.** `index:reconcile` is the first real production handler. The handler loads `payload.noteIds`, calls `indexNotes(deps, noteIds)`, and classifies failures for the runner (`classifyError`, `runner.ts:336`).

### New launchd service — `provisioning/macos/com.atlas.sync.plist`

`StartInterval`-driven (default 300 s), running a wrapper that invokes `brain sync --json` then `brain jobs run --workflow index:reconcile --json`. Runs as the same unprivileged UID as the CLI (`atlas-agent`). Emits no new audit-event kinds — each cycle is an Atlas run and already produces `run.*` audit rows, so `brain watch` observes it (see `behavior`). Credential custody for the wrapper is specified in `security`.

## behavior — Behavior & Correctness

### Cursor semantics (what the cursor tracks)

The cursor (`sync_cursors.last_absorbed_oid`) marks the upstream commit boundary through which **every changed path has reached a terminal disposition** — either **absorbed** (integrated into `refs/atlas/main`) or **quarantined-and-recorded** (a `pending_quarantine` row carrying `{path, quarantineId, firstSeenOid}`). Both are terminal; neither leaves a path unhandled. Intent's shorthand "last fully-absorbed OID" names exactly this boundary: at the cursor level "absorbed" means "accounted for," and under the binding anti-wedge decision that **includes** quarantined-and-recorded paths.

- **Advancing the cursor past a quarantined path is not skipping an unabsorbed path.** The path is durably recorded in `pending_quarantine`; it is revisited only if it changes again upstream (a new diff entry) — and when it is revisited, its pending entry is **reconciled**: cleared if the new bytes scan clean (or the path is archived/renamed away), refreshed if the bytes are still dirty (see *Pending-quarantine lifecycle* below). This is the deliberate anti-wedge property — one dirty note must not wedge sync for the other 210, and a corrected note must not leave a stale pending entry behind.
- **"Advances only after the broker integrates" is, precisely: advances only in the cycle's run finalize transaction (step 3 of §2.8).** For a **non-empty** ChangePlan that finalize *follows* the broker's single CAS integrate of `refs/atlas/main`. For an **all-quarantined** cycle the ChangePlan is **empty**, so **there is no integrate** — the finalize instead follows the run's `run.*` audit append and still commits the cursor advance + pending rows atomically. Integration is therefore not the gate on cursor advance; the finalize commit is.
- **A cycle that opens no run never advances the cursor.** The `behindBy == 0` short-circuit (step 2 below) and `--dry-run` both leave the cursor untouched.
- The cursor advances only to a **commit boundary** — upstream head, or the last fully-processed commit under `--max-paths` — never into the middle of a commit.

### Pending-quarantine lifecycle (clearing stale entries)

`pending_quarantine` is a durable set keyed by `path` (at most one entry per path). Every **finalized** cycle recomputes it so a corrected path can never leave a stale entry. In the cycle's run finalize transaction (step 5 below), the durable set is reconciled against the paths processed this cycle:

- **Clear.** For any path that had an existing `pending_quarantine` entry and **this cycle** either (a) scanned **clean** and was absorbed (`A`/`M` clean), (b) was **deleted** (`D` → archive), or (c) was **renamed away** (`R`, the from-path leaves the set), the entry is **removed**. The path is no longer dirty at that origin, so a durable pending record for it would be stale. Each removed entry is reported in the envelope's `clearedPending[]` with its `{path, quarantineId}`.
- **Upsert.** For any path that scanned **dirty** this cycle (`A`/`M` dirty), the set gains/replaces its entry `{path, quarantineId, firstSeenOid}`. **`firstSeenOid` is preserved** from the existing entry if the path was already pending (it records where the dirty bytes *first* appeared, not the latest sighting); it is set to the current commit OID only when the path was not already pending. `quarantineId` is content-addressed, so a re-quarantine of byte-identical dirty content produces the same handle and no duplicate quarantine record.
- **Untouched.** A path with a pending entry that does **not** appear in this cycle's diff keeps its entry unchanged — the dirty bytes are still the last committed state for that path.

The reconciled set is written in the same finalize transaction as the cursor advance and `cycle_seq` increment (step 5), so the cursor boundary and the pending set are always mutually consistent: every path at or below the cursor is either absorbed or has exactly one live pending entry. Clearing an entry is a `sync_cursors` write, not a ChangePlan op — it does not count toward `appliedOps` and does not by itself require an integrate (a cycle whose only effect is a clear-plus-clean-absorb still integrates the clean op; a cycle that clears an entry via a `D`/archive integrates the archive op).

### Sync cycle (happy path)

1. Acquire the Atlas vault lock and the `vault-maintenance` lock; if the `jobs-runner` lock is held, defer the `jobs run` drain (see locks below). If backup is degraded, exit `2` (`backup-unhealthy`) — ledger-writing runs are blocked by design.
2. Read `sync_cursors` row for the source; resolve upstream head = `refs/heads/main` OID (snapshotted for the cycle). Compute `behindBy`. **If `behindBy == 0` (`last_absorbed_oid == head`), short-circuit *before opening any run*: no ledger write, no audit append, no cursor write, no `cycle_seq` increment, no pending-set reconcile; exit `0`.** This is the only path that opens no run.
3. `behindBy > 0` ⇒ **open exactly one run for the cycle** — opened on the basis of the non-empty delta, never on the basis of any path succeeding. `git diff --name-status <last_absorbed_oid>..<head>` over the configured note globs. `NULL` cursor ⇒ diff against the empty tree (full first-absorb).
4. Group changed paths by upstream commit and process **in commit-topological order (oldest→newest)**. Each clean path contributes exactly one op to the run's **single ChangePlan**; a dirty path is quarantined and recorded as pending, contributing no op. Dispatch by status:
   - **`A`/`M` (add/modify):** run the scan-before-persist front half of the `captureSource` pipeline. Preflight `normalize({path, guard})` scans raw + normalized bytes **before any mutating dep is constructed** (`capture.ts` preflight). On a clean scan, `buildManifest` (`capture.ts:223-303`) produces the note's create/modify op and **appends it to the run's ChangePlan** (identical bytes bump `observation_count`/`last_seen_at` only, adding **no op** — this is the `absorbed[].action: "unchanged"` case that does not count toward `appliedOps`). **If this path carried a `pending_quarantine` entry from an earlier dirty state, that entry is marked for removal in finalize** (see *Pending-quarantine lifecycle*). On a dirty scan the bytes are quarantined and a pending entry recorded/refreshed — no op (see *Error and edge behavior*).
   - **`D` (delete):** append a `ProposeArchive` op for the note at that origin (`packages/contracts/src/ops/archive.ts` — lifecycle → archived, non-destructive). The note is dropped from index activation (`foldNotesForPaths` marks it archived per its interface contract; `indexNotes` then removes its LanceDB chunks). If the deleted path carried a `pending_quarantine` entry, that entry is marked for removal in finalize. **Not** `ProposeDelete` (Tier-3, review-required) and **never** `erase` — destructive removal stays human-gated (deferred with 60-C). Rationale: auto-gating every upstream deletion on Tier-3 review would wedge sync; archive is the fail-closed, reversible choice that preserves history.
   - **`R` (rename):** append a `ProposeRename` op (`packages/contracts/src/ops/rename.ts`) at the path level. Because `contentId = (rawContentHash, canonicalMediaType)` is content-addressed, a pure rename (same bytes) reuses the existing blob; only the origin/path metadata and provenance move. A rename-with-edit is treated as delete-old + add-new at the path level, dedup at content level. If the from-path carried a `pending_quarantine` entry it is marked for removal; if the to-path's bytes scan dirty it is quarantined and recorded pending.
5. **Close the run.** If the ChangePlan is **non-empty**, the broker performs a **single** CAS fast-forward of `refs/atlas/main` with the accumulated plan (`handle.integrate(...)`), then `foldProvenanceFromCanonical(store, repo, "refs/atlas/main")` and `foldNotesForPaths(...)` over the changed notes, then checkpoint `reindexed`. **Finalize** the run: in the finalize ledger transaction (step 3 of the §2.8 four-step cross-store write) set `last_absorbed_oid` (to head, or to the last fully-processed commit boundary under `--max-paths`), `last_synced_at = now`, `cycle_seq += 1`, **reconcile the durable `pending_quarantine` set** (remove entries for paths absorbed-clean / archived / renamed-away this cycle, upsert entries for paths quarantined this cycle — see *Pending-quarantine lifecycle*), and — when the ChangePlan yielded ≥1 `noteId` — enqueue the **single** `index:reconcile` job (payload = the union of changed `noteIds`), all atomically. If the ChangePlan is **empty** (every path quarantined), no CAS fast-forward is attempted and no empty commit is manufactured — but the run still appends its `run.*` audit events (step 2 of §2.8) and still commits the cursor advance + `cycle_seq += 1` + the reconciled `pending_quarantine` set in its finalize transaction (step 3), and step 4 (backup + watermark) proceeds normally. Release locks.
6. The wrapper then runs `jobs run --workflow index:reconcile`, which drains under the exclusive `jobs-runner` lock and calls `indexNotes(deps, noteIds)`.

### Run and transaction boundary — the single-run invariant

A cycle with a non-empty delta opens **exactly one run**, and it opens that run on the basis of the delta being non-empty — never on the basis of any path succeeding. The behavior is stated as a named invariant so it is not read as an edge case:

> **Invariant.** *Cursor advance, `pending_quarantine`-set reconciliation, and pending-quarantine persistence are effects of the cycle's run finalize transaction, and every cycle with a non-empty delta (`behindBy > 0`) finalizes exactly one run — clean, mixed, or all-quarantined. A `behindBy == 0` cycle opens no run (step 2 short-circuit).*

- **One run, one ChangePlan, at most one integrate.** The run accumulates one ChangePlan across all clean paths (`A`/`M` capture ops, `D` archive ops, `R` rename ops). When the ChangePlan is non-empty the broker performs a **single** CAS fast-forward of `refs/atlas/main`, and the run's finalize records the cursor advance, the reconciled pending set, and the single `index:reconcile` enqueue in one ledger transaction. This matches `intent`'s "the broker CAS-fast-forwards `refs/atlas/main`; the cursor advances only after the broker integrates" — **one** integrate per cycle, not K.
- **Clean / mixed / all-quarantined are the same code path**, differing only in how many ops the ChangePlan holds:
  - **clean:** every path yields an op (or an `unchanged` no-op re-observation); ChangePlan full; one integrate (unless every path was an `unchanged` re-observation, in which case the ChangePlan is empty and there is no integrate); cursor → head; `index:reconcile` enqueued when ≥1 op yielded a `noteId`; exit `0`.
  - **mixed:** some paths quarantined; ChangePlan holds the clean ops; one integrate; cursor → head; a `pending_quarantine` row per dirty path (and any corrected path's stale entry cleared); `index:reconcile` enqueued for the clean `noteIds`; exit `6`. The cursor advancing past the dirty paths is correct per *Cursor semantics* — those paths are quarantined-and-recorded, i.e. terminally disposed, not skipped.
  - **all-quarantined:** no path yields an op; **empty ChangePlan**; **no integrate, no ref move, no empty commit**; the run still appends its `run.*` audit events and still commits the cursor advance + `cycle_seq += 1` + reconciled pending set in its finalize transaction; no reconcile enqueued (`reconcileJobId: null`); `appliedOps: 0`; exit `6`. An all-quarantined cycle is a **successfully finalized run with an empty ChangePlan** — not a failed run, and not a special code path. The cursor **has** advanced (every path is quarantined-and-recorded), so the next cadence does not re-attempt those bytes.
- **`behindBy == 0` has no run.** Step 2 short-circuits before opening one: no ledger write, no audit append, no cursor write, no `cycle_seq` increment, no pending reconcile; exit `0`.

### Crash semantics (both directions)

- **Crash before the step-3 finalize commit** (during scan/manifest, or *between the audit append and the ledger commit*): the cursor is **unadvanced** and the durable `pending_quarantine` set is **unchanged** (the reconcile is part of the finalize commit, so a stale entry is never partially cleared). The next cycle re-derives the **identical** delta from the unchanged cursor and re-processes it idempotently — content-addressed dedup makes a re-captured clean path a no-op fast-forward, a corrected path re-clears its (still-present) pending entry, and quarantine is content-addressed, so a re-quarantined dirty path produces **no duplicate rows**. Nothing is lost or double-applied. This holds for the all-quarantined cycle too: the re-run re-quarantines the same bytes to the same content-addressed handles.
- **Crash after step 3 but before step 4** (ledger committed, backup+watermark not yet caught up): recovered by the existing `reconcileRunsOnStartup` path exactly as any other run — **no sync-specific recovery machinery is introduced.**

### Bounded cycle (`--max-paths`) — safe continuation

`--max-paths n` caps the work in one cycle **without ever skipping a path**:

- Changed paths are already grouped by upstream commit and processed oldest→newest (step 4). The cycle checks the cumulative processed-path count **after each whole commit** and stops once that count reaches or exceeds `n`.
- **The cursor then advances to the OID of the last fully-processed commit** — never past an unprocessed commit, and never into the middle of one. The success envelope sets `truncated: true` and `cursorTo` = that boundary OID; `reconcileJobId` covers only the notes changed in the processed commits; the pending-set reconcile covers only the paths in the processed commits.
- **A commit is atomic.** If a single commit's changed-path count alone exceeds `n`, that commit is still processed in full (so the actual paths in a cycle may exceed `n` by the size of the boundary commit) — splitting a commit would leave a partially-absorbed tree with no valid cursor OID to record.
- Remaining commits are absorbed on the next cadence, resuming from the advanced cursor. **Guarantee:** for any `n ≥ 1`, every commit between the entry cursor and head is eventually absorbed exactly once, in order, with no gap and no path left behind head.
- Unbounded (flag omitted) processes to head in one cycle; `truncated: false`.

### `--dry-run`

Computes and prints the diff and the planned per-path actions (the same `absorbed`/`archived`/`renamed`/`quarantined`/`clearedPending` classification), then **mutates nothing** and **opens no run**: no blob is written, `refs/atlas/main` is not moved, `sync_cursors` is not touched (cursor, `cycle_seq`, and the `pending_quarantine` set all unchanged — no entry is added *or* cleared), no `index:reconcile` job is enqueued, and no LanceDB write occurs. It still runs the scan preflight (so a would-be-dirty path is reported in `quarantined` with `quarantineId: ""`, and a would-be-corrected path is reported in `clearedPending` as a *planned* removal) but no quarantine record is persisted and no pending entry is removed. The envelope pins `appliedOps: 0`, `reconcileJobId: null`, and `cursorFrom == cursorTo` per the *No-run outcomes* interface note. Exit `0` (or `2` on a config/vault/lock failure reached before planning).

### Error and edge behavior (fail-fast, not self-wedging)

- **Secret in a changed note (attributable — exit `6`).** Preflight scan quarantines the bytes (ciphertext-only, sealed to the CLI) **before persist**, exactly as today. Sync **catches** the per-path secret-scan verdict, records/refreshes `{path, quarantineId, firstSeenOid}` in the cycle's reconciled `pending_quarantine` set (preserving `firstSeenOid` if the path was already pending), and **continues** with the remaining paths — the dirty path contributes no ChangePlan op. The cursor **still advances** (to head, or to the boundary under `--max-paths`), persisted in the **cycle's run finalize transaction** (step 3); the cycle exits `6` (action-required) with the pending list. The dirty bytes never persist. Rationale (binding operator decision): otherwise one dirty note wedges continuous sync for the other 210 forever. The path is only re-attempted if it changes again upstream (a new diff entry) — and when it is, its pending entry is reconciled per *Pending-quarantine lifecycle* (cleared if the new bytes are clean, refreshed if still dirty), so a corrected note never leaves durable stale pending state.
- **Non-attributable dirty verdict (exit `3`).** A `GeneratedArtifactGuard` dirty verdict on bytes **Atlas itself generates** (a manifest or rendition artifact written under `sources/**`) cannot be charged to a single upstream path, so there is no path to skip. The cycle **aborts** with the cursor **unadvanced** and the bytes quarantined; exit `3`. This is the *only* exit-3 path for `sync`, and it is distinct from the per-path upstream secret above (attributable, quarantined, skipped, exit `6`).
- **Non-terminal per-path error** (I/O, transient broker/integrate failure): **abort the cycle** (the run does not finalize), leave the cursor **and the `pending_quarantine` set** unadvanced/unchanged, exit `4` (`internal`, `retryable: true`). The launchd timer retries next cadence; the `jobs run` retry uses deterministic seeded backoff (`backoffDelayMs`, `runner.ts:316`). No silent fallback, no partial-cursor advance past an unprocessed commit, no partial pending-set reconcile.
- **Empty diff / zero-state.** First cycle with `NULL` cursor absorbs the full tree against the empty tree; a subsequent no-change cycle exits `0` at step 2 (`behindBy == 0`, no run opened).
- **Uncommitted working-tree edits in main-vault.** A git-rev cursor sees **only committed state.** Obsidian edits not yet committed by brain-hub are **invisible** to sync until committed; this is intended (deterministic, no partial reads of a file mid-write). Stated so the operator understands sync latency = commit latency + cadence. (Cadence-vs-commit-latency tuning is `open-questions` #3.)
- **Concurrent upstream writes during a cycle.** The diff is computed against a snapshotted `head` OID at step 2; commits landing on `refs/heads/main` mid-cycle are simply picked up next cadence. No lock is taken on the upstream ref (Atlas must never block the live writers).
- **Duplicate cycle / double-drain.** `index:reconcile` idempotency key = the run's `refs/atlas/main` OID; a re-enqueue is a no-op. A second `jobs run` fails `locked:jobs-runner` (exit 2) and defers.

**Cursor advance ordering.** The cursor advances **only** in the cycle's run finalize transaction (step 3 of §2.8), and only to a commit boundary (head, or the last fully-processed commit under `--max-paths`). Its meaning — "every path through this boundary is absorbed or quarantined-and-recorded" — is defined in *Cursor semantics* above, and the `pending_quarantine` set is reconciled in the same transaction so the two are always mutually consistent. Crash behavior in both directions is specified in *Crash semantics*: a crash before finalize leaves the cursor and the pending set unchanged and the next cycle re-derives idempotently; nothing is lost or double-applied.

### Lock interactions (5-minute cadence)

- `sync` takes the vault lock + `vault-maintenance` lock for the absorb; it does **not** hold `jobs-runner`. The drain (`jobs run`) takes `jobs-runner` exclusively. If a retention job or another drain holds `jobs-runner`, the sync-cycle drain defers to the next cadence — the enqueued `index:reconcile` job persists and is drained then. At 300 s cadence with a 211-note corpus and O(delta) reconcile, contention is expected to be rare; `--max-paths` bounds a pathological catch-up cycle.

### Observability

Each cycle with a non-empty delta emits the run's `run.*` audit events (a non-empty ChangePlan is broker-signed on integrate; an all-quarantined run still appends its `run.*` events with no integrate), so `brain watch` (read-only ledger tail, `apps/cli/src/commands/watch.ts`) surfaces *that* a sync happened and its outcome — `brain watch` holds no durable state and cannot trigger anything; the sync daemon is the genuinely new process. `sync status` is the durable-state read surface (cursor, behind-by, pending quarantine). Logs go to the launchd service's stdout/stderr per the existing daemon pattern.

## ssot — Single Source of Truth

- **Absorbed content** — `refs/atlas/main` (broker-owned, protected) is the sole SSOT for what Atlas has absorbed. `refs/heads/main` is upstream, never written by Atlas.
- **Absorb bookmark** — `sync_cursors.last_absorbed_oid` is the single owner of "how far upstream Atlas has absorbed." No second copy; the launchd service reads it via `sync status`, does not re-derive it. Excluded from projection rebuild.
- **Index activation authority** — `notes.active_generation_id` (`packages/sqlite-store/src/rebuild.ts:139`, `repos/projections.ts:71`). `foldNotesForPaths` is a new *writer* of this projection but does not create a second authority; `db rebuild` remains the full-rebuild writer, and both derive from `refs/atlas/main`.
- **Staleness / generation id** — never stored; derived by `generationIdFor(noteId, contentHash, chunkerVersion, embeddingModel, embeddingDimensions)` and compared in `computeStaleness` (`packages/lancedb-index/src/staleness.ts:61`). `indexNotes` consumes this owner, does not re-derive.
- **Content identity** — `contentId = (rawContentHash, canonicalMediaType)` (`packages/contracts/src/ids.ts`) remains the sole content-addressing authority; the cursor does not duplicate content hashes.
- **Command membership / phase / privilege / idempotency** — `docs/specs/cli-contract/commands.json` is the sole owner; the broker *reads* `privilege`, never re-classifies. The two new commands add rows there and nowhere else.
- **Acceptance thresholds** — `docs/specs/acceptance-thresholds.md` owns recall@10 ≥ 0.85 / MRR ≥ 0.70; the test plan and `index eval` consume it, and this spec does not restate the numbers as an independent constant.
- **Change operations** — `@atlas/contracts` ChangePlan ops (`ProposeArchive`, `ProposeRename`, `CreateNote`, …) are the sole op vocabulary; sync selects among existing ops, introducing none.

## security — Security & Trust

**Trust model unchanged; adoption changes only the ref set.**

- **Protected-ref set gains `refs/atlas/main`.** The `atlas-broker` remains the sole mutator of the protected set (canonical `refs/heads/main` of *Atlas's* repo model → now `refs/atlas/main` for the adopted vault, plus `refs/audit/runs`, trust ledger). `@atlas/git`'s `runGit` stays unexported — the CLI structurally cannot write a protected ref. `atlas-egress` stays excluded from the `atlas-git` group (D18); the CLI runs unprivileged `atlas-agent`, network-denied at the UID (D17).
- **`refs/heads/main` is outside Atlas's protected set entirely** — Atlas has no write path to it, by construction. This is the security property that makes adoption-without-eviction safe for the live writers.
- **Scan-before-persist is intact — adoption buys no scan bypass.** Every absorbed path runs the same `@atlas/scan` engine via the unmodified `captureSource` preflight, before any mutating dep is constructed. A dirty verdict quarantines ciphertext-only bytes sealed to the CLI before it records-and-skips (see `behavior`). No absorbed byte reaches a durable sink before the scan clears it.
- **Trust tier of adopted content.** main-vault content is absorbed as **`untrusted`** (fail-closed default; taint takes the floor). Risk tiering is deterministic + monotonic-up; a synthesis/workflow run over adopted notes that would mutate must clear its own risk gate — adoption confers no elevated trust. This is the correct posture: the vault is written by three uncoordinated writers, so its content is treated as external input, not as authored-in-Atlas.
- **Pre-existing trust read-surface defect (flagged, fix-scope open).** `apps/cli/src/commands/source.ts:40` hardcodes `DEFAULT_TRUST_LEVEL = "untrusted"` and returns `history: []`, so `source list`/`show`/`trust show` report `untrusted` even after a successful `source trust promote` writes `0010_trust_state`. For adopted content the *effective* tier is untrusted regardless, so this defect does not weaken adoption's security — but it means an operator cannot observe a promotion. Whether to fix it here is `open-questions` #4.

**Egress credential custody for the auto-hook (resolved default; residual in `open-questions` #1).** `index:reconcile` mints an egress capability, so the launchd-run process needs `ATLAS_EGRESS_CAPABILITY_KEY`. The custody contract:

- **Storage.** The key is held in the macOS login Keychain under the `atlas-agent` identity — **never** in the plist's `EnvironmentVariables` (plaintext-in-plist is rejected as the weakest option; the plist references no secret material).
- **Access.** The `com.atlas.sync.plist` wrapper fetches the key from the Keychain at job start (`security find-generic-password`, scoped to the atlas-agent user) and injects it into the `brain` process environment for the life of that one invocation only. It is never written to disk, a temp file, or the audit log.
- **Fail-closed.** If the key is absent or the Keychain is locked/unretrievable, the mint fails and the job exits `4`/`6` — it **never** falls back to an unscanned or credential-less egress path, and never persists an un-minted result. An unattended cycle that cannot mint is a no-op that retries next cadence, not a degraded success.
- **Rotation & revocation lifecycle.** `ATLAS_EGRESS_CAPABILITY_KEY` is the shared secret the minting agent side and the verifying `atlas-egress` broker both hold; its blast radius is bounded by the egress capability design (`security-broker-contract.md`, ADR-0001): every *minted capability* is **run-bound with a per-run byte/token/cost budget and a short TTL**, so a leaked capability cannot be replayed past its run — **per-capability revocation is structural, not a separate mechanism**. Revoking or rotating the standing *mint ability* is one operation: replace the key in **both** custody points (the `atlas-agent` Keychain item and the `atlas-egress` broker's copy), then the next cycle mints under the new key while any in-flight capability expires on its own TTL. No coordinated cutover or dual-key window is required at this cadence — a brief key skew simply fails closed and the launchd timer retries next cadence. Deleting the key without replacing it is a hard revocation: no new capability can be minted, and the sync daemon fails closed (no-op + retry) until re-provisioned. Rotation is **operator-triggered, not scheduled** — automatic/periodic rotation is out of scope for this single-user tier (correct restraint on the user-count dimension), but the mechanism and its fail-closed semantics are specified here so a compromised key can be revoked and replaced immediately. Neither rotation nor revocation touches the vault, the ledger, or `refs/atlas/main`; it only governs outbound egress minting.
- **Provisioning prerequisite (unattended unlock).** The unattended launchd session must have the atlas-agent keychain unlocked for the Keychain-fetch to succeed. This provisioning step **gates enabling** `com.atlas.sync.plist`: until it is provisioned the sync daemon stays **disabled** and sync runs only under an interactive shell that already exports the key — the daemon is never enabled in a state where it would fail-closed every cycle. The *default* unlock posture (login keychain kept unlocked while the operator is logged in) is sufficient for the interactive-session cadence; the fully-headless unlock story (a dedicated always-unlocked non-login keychain vs. login-keychain-kept-unlocked) is the residual in `open-questions` #1(b) and must be settled before the daemon is enabled for a genuinely unattended (logged-out) session.

- **No privileged `--export-challenge` command in this spec.** `sync` is `standard`, `sync status` is `readonly`; neither is a privileged mutation. The real-copy privileged operations that would exercise the production authorizer (Flow B) are deferred with 60-E. D20 — the test signer is hard-rejected outside `ATLAS_TEST_MODE` — remains a standing invariant and is asserted (see `test-plan`).
- **Audit.** Every sync cycle's mutations produce broker-signed `run.*` events on `refs/audit/runs` (signed-only, gapless-seq, chained, WORM-anchored); no credentials or raw note bytes appear in audit content.

## test-plan — Test Plan

Each behavior-changing claim maps to a concrete test with a named break scenario.

**Sync cycle (unit + integration, fixture vault via `withFixtureVault`):**
- *Cursor advances only after integrate.* Kill the process between broker integrate and cursor write (failpoint); assert next cycle re-derives with no duplicate note and cursor ends at head. Break scenario: cursor written before integrate ⇒ a crash skips an un-integrated commit permanently.
- *No-delta cycle short-circuits with no write.* Run `sync` when `refs/heads/main` is unchanged since the last cursor (`behindBy == 0`); assert **no run is opened** (no `run.*` audit events, no ledger write), `observation_count` is **unchanged**, the `sync_cursors` row is **byte-identical** (`last_absorbed_oid`, `cycle_seq`, `last_synced_at`, `pending_quarantine` all unchanged), no `index:reconcile` job is enqueued, the envelope reports `appliedOps: 0` / `reconcileJobId: null` / `cursorFrom == cursorTo == upstreamHead`, and exit `0`. Break: the no-delta cycle opens a run, bumps `observation_count`, or increments `cycle_seq` — contradicting the step-2 short-circuit.
- *Identical-content re-observation bumps observation_count, not the corpus, and does not count as an applied op.* Land a **new** upstream commit that re-touches a note whose bytes are **byte-identical** to what Atlas already stores (`behindBy > 0`, non-empty delta). Assert a run **is** opened, the path yields **no** capture op (`absorbed[].action: "unchanged"`), `observation_count`/`last_seen_at` **are** bumped, **zero** new blobs are written, the cursor advances to head, the note is **not** re-embedded, **`appliedOps == 0`**, and — when the cycle's *only* changed paths are such re-observations — `reconcileJobId: null` (no note to re-index). Break: re-observation writes a new blob or re-embeds the whole corpus, **or `appliedOps` counts the unchanged absorbed entry** (over-reporting applied ops for a cycle that applied none). (This is the case where `observation_count` legitimately changes — distinct from the no-delta short-circuit above, which must not touch it.)
- *Modify path re-indexes only that note (the O(delta) proving test).* Change one note, run sync; assert the enqueued `index:reconcile` payload contains **exactly that one `noteId`** — not the full corpus — and that when it drains, `indexNotes` reports `scanned == 1`, `reembedded == 1`, `unchanged == 0` (it only ever examines the noteIds it was handed, so it cannot and must not report the unchanged N-1). **Independently** assert the other N-1 notes are untouched: their `active_generation_id` and their LanceDB chunk rows are byte-identical before/after (they were never in the payload, so `indexNotes` never scanned them). Break: the payload carries all N `noteIds`, or `indexNotes` drops the table — either forces an O(corpus) re-embed. This pair of assertions (payload cardinality = 1, N-1 notes provably untouched) is the O(delta) success criterion's proof.
- *Delete → archive, not erase.* Delete a note upstream; assert `ProposeArchive` emitted, `foldNotesForPaths` sets the row lifecycle to `archived`, `indexNotes` reports it `removed` and its LanceDB chunks are dropped, **no** `ProposeDelete`/`erase`, and bytes are still recoverable from git. Break: a delete triggers Tier-3 gating and wedges the cycle, or triggers destructive erase, or `foldNotesForPaths` leaves the note `active` so its chunks linger.
- *Rename reuses the blob.* Rename a note (same bytes) upstream; assert same `contentId`, provenance/path moved, no re-embed. Break: rename re-ingests as new content.
- *Secret quarantines and does NOT wedge (mixed cycle).* Introduce a secret into one of two changed notes; assert the clean note absorbs + indexes, the dirty note is quarantined (ciphertext-only), `pending_quarantine` records it with `firstSeenOid`, cursor **advances to head**, exit `6`, and next cycle does not re-attempt the unchanged dirty path. Break: one dirty note halts sync for all others forever.
- *Corrected quarantined path clears its stale pending entry.* Cycle 1: introduce a secret into a path; assert it is quarantined and `pending_quarantine` holds `{path, quarantineId, firstSeenOid}`, exit `6`. Cycle 2: land an upstream commit that changes **that same path** to clean bytes; run sync. Assert the path now **absorbs** (contributes a ChangePlan op, is re-indexed) **and its `pending_quarantine` entry is removed** in the finalize transaction — the durable set no longer contains the path, `sync status`'s `pendingQuarantine[]` no longer lists it, and the `sync` envelope reports the removal in `clearedPending[]` with the original `quarantineId`; `firstSeenOid` is not resurrected. Also assert the removal happened in the *same* transaction as the cursor advance (a crash between them leaves both unchanged). Break: the pending entry survives after the path is corrected, so `sync status` reports a stale pending-quarantine indefinitely and an operator can never observe the vault return to clean — the durable pending state has gone stale.
- *Still-dirty re-quarantine preserves `firstSeenOid`.* Quarantine a path in cycle 1; in cycle 2 change the path to *different but still-dirty* bytes. Assert the `pending_quarantine` entry is refreshed (new `quarantineId` for the new content) but **`firstSeenOid` is preserved** from cycle 1, and no duplicate entry for the path exists (set keyed by path). Break: `firstSeenOid` is overwritten with cycle 2's OID (losing when the dirt first appeared), or two entries accumulate for one path.
- *Non-terminal per-path error aborts, cursor unadvanced.* Inject a transient integrate failure; assert cycle exits `4` (`retryable: true`), cursor unchanged, `pending_quarantine` set unchanged, next cadence retries. Break: partial cursor advance skips the failed commit, or a partial pending-set reconcile leaks.
- *Non-attributable dirty verdict aborts with cursor unadvanced (exit 3).* Force a `GeneratedArtifactGuard` dirty verdict on an Atlas-generated manifest/rendition artifact under `sources/**`; assert the cycle exits `3`, the cursor is **unadvanced**, and the bytes are quarantined. Break: the cycle skips past a non-attributable verdict as if it were a per-path upstream secret (exit 6, cursor advanced), silently dropping generated bytes.
- *Uncommitted working-tree edit is invisible.* Stage an uncommitted edit in the fixture; assert `sync` does not absorb it. Break: sync reads dirty working-tree state mid-write.
- *`refs/heads/main` untouched invariant (the amended #60 gate).* Snapshot `refs/heads/main` OID before/after the full E2E; assert byte-identical. Assert `refs/atlas/main` advanced. Break: any Atlas write to upstream `main`.

**Durable-state survival (projection rebuild):**
- *`sync_cursors` survives `db rebuild`.* Drive a real absorb cycle so the row is non-trivial — `last_absorbed_oid` is a non-null 40-hex OID, `cycle_seq > 0`, `last_synced_at` set, and at least one `pending_quarantine` entry present (from a quarantined path). Snapshot the full row. Run `db rebuild`, then read `sync_cursors` (and cross-check via `sync status --json`). Assert the row is **byte-identical** to the snapshot — `last_absorbed_oid`, `cycle_seq`, `last_synced_at`, and `pending_quarantine` all unchanged — proving `sync_cursors` is excluded from `rebuildProjections` exactly like `jobs`. Then run one more `sync` and assert it does **not** re-absorb from the empty tree (`behindBy` reflects only commits since the preserved cursor). Break: `db rebuild` wipes or re-derives `sync_cursors`, resetting `last_absorbed_oid` to `NULL` so the next cycle re-absorbs the entire corpus against the empty tree (O(corpus), not O(delta)) and loses every pending-quarantine record — a silent, corpus-scale regression that no other test would catch.

**`sync status` (zero-state + response contract):**
- *Zero-state before first cycle.* On a freshly adopted vault (row seeded at adoption, no cycle yet) run `sync status --json`; assert `lastAbsorbedOid: null`, `cycleSeq: 0`, `pendingQuarantine: []`, `lastSyncedAt` present, non-null, RFC3339 UTC, and equal to the adoption seed timestamp; `upstreamRef: "refs/heads/main"`; `sourceId` = the adopted-vault source id; `upstreamHead` = the current `refs/heads/main` OID; and `behindBy` = the full commit count to the empty-tree base. Break: `sync status` throws for a missing row, or reports a null/absent `lastSyncedAt` at the zero-state.
- *Response contract after a cycle.* Run one absorb cycle, then `sync status --json`; assert every required field is present and well-typed, `lastAbsorbedOid` = the cursor OID (40-hex), `behindBy: 0` when upstream is caught up, `cycleSeq` = the post-cycle value, and (for a mixed cycle) `pendingQuarantine[]` carries `{path, quarantineId, firstSeenOid}` per dirty path. Break: a required field is missing/mistyped, or `behindBy` disagrees with the cursor-vs-head distance.

**Run/transaction boundary (single run per cycle):**
- *One run, one reconcile job per cycle.* Absorb a cycle touching K clean paths across multiple commits; assert exactly **one** run finalizes (one `refs/atlas/main` fast-forward, one set of `run.*` audit events), exactly **one** `index:reconcile` job is enqueued (not K), its payload is the union of all changed `noteIds`, and its `idempotencyKey` equals the run's `refs/atlas/main` OID. Break: a run/integrate per path (K runs), or a job enqueued per path (K jobs), or the cursor advance splits from the enqueue across separate transactions.
- *All-quarantined cycle finalizes one empty-ChangePlan run.* Upstream commit changes **N ≥ 2 paths and every one of them carries a planted secret** (no clean path in the cycle). Assert: exactly **one** run is opened and reaches `finalized`; its ChangePlan is **empty** (`appliedOps: 0`); `refs/atlas/main` is **unmoved**; `refs/audit/runs` **did** receive the run's events; `sync_cursors.last_absorbed_oid` **advanced** to the upstream head and `cycle_seq` incremented; **one** `pending_quarantine` row exists per dirty path; `reconcileJobId: null`; exit is `6`; and the **next** cycle over an unchanged upstream is a `behindBy == 0` no-op that opens no run. Break: the cursor does not advance (proving the persistence transaction is missing), or no run is finalized, or the cycle exits `3` instead of `6`, or the dirty bytes reached any durable sink.
- *Crash before step-3 commit in an all-quarantined cycle.* In the all-quarantined cycle above, kill the process **between the audit append and the ledger commit** (failpoint); assert the cursor is **unadvanced**, the `pending_quarantine` set is **unchanged**, and the re-run re-derives the **identical** delta and produces **no duplicate** quarantine rows (quarantine is content-addressed). Break: the cursor advanced without the ledger commit, or the re-run creates duplicate pending rows.
- *Crash mid-cycle re-processes as no-ops.* Kill mid-cycle after some clean paths' ops are in the run's ChangePlan but **before** the run's finalize; assert the cursor is unadvanced, the next cycle re-diffs from the same upstream OID, replays those paths as content-addressed no-op fast-forwards (no new blobs, no duplicate note), and completes to head. Break: the cursor advanced before finalize, so the replay double-applies or skips.

**`--dry-run` (mutation-free proof):**
- Set up a fixture with add/modify/delete/rename changes, one secret-bearing path, **and one previously-quarantined path that is now clean** (so a pending entry exists to be *planned* for clearing); run `sync --dry-run --json`. Assert the envelope classifies every path (`absorbed`/`archived`/`renamed`/`quarantined`, the dirty one with `quarantineId: ""`, the corrected one in `clearedPending[]` as a planned removal), reports `appliedOps: 0` / `reconcileJobId: null` / `cursorFrom == cursorTo`, **and** that no mutation occurred: `refs/atlas/main` OID unchanged, `sync_cursors` row byte-identical (cursor + `cycle_seq` + `pending_quarantine` unchanged — the corrected path's entry is **still present**, not removed), no new git blobs, no `index:reconcile` job row enqueued, no LanceDB write, no persisted/removed quarantine record. Break: dry-run advances the cursor, increments `cycle_seq`, persists a quarantine row, **clears a pending entry**, or writes chunks.

**`--max-paths` bounded continuation:**
- Build M upstream commits whose changed paths sum to more than `n`; run `sync --max-paths n --json`. Assert `cursorTo` equals the **last fully-processed commit OID** (not head), `truncated: true`, and that no commit past `cursorTo` was absorbed. Then run a second (unbounded) cycle and assert it resumes from `cursorTo` and reaches head with **every** path absorbed exactly once, in order. Break: cursor advances to head leaving later commits unprocessed, or a commit is split mid-way leaving a tree with no valid cursor.
- *Oversize boundary commit.* Make one commit's path count alone exceed `n`; assert that commit is processed **in full** (atomic) and the cursor advances to it. Break: the cycle refuses to progress, wedging on a single large commit.

**Jobs / handler registry:**
- *`index:reconcile` handler exists in prod (regression on the empty-registry breakage).* Enqueue and drain with `ATLAS_TEST_JOB_HANDLER` unset; assert the job completes, not `internal`. Break: `JOB_HANDLERS` stays `{}` and every job fails when drained.
- *Idempotent enqueue.* Enqueue twice with the same canonical OID key; assert one row. *Lock deferral.* Hold `jobs-runner`; assert the drain defers and the job persists.

**Incremental fold:**
- *Fold is idempotent + crash-safe.* Run `foldNotesForPaths` twice; assert identical `notes` rows for both active and archived notes. Crash mid-fold; assert re-run converges. Break: partial fold leaves the index with no fence for a changed note, or an archived note reverts to `active`.

**Launchd auto-hook (the ingest→index closure):**
- *Two-step wrapper reflects a change end-to-end.* Drive the wrapper's exact sequence — `brain sync --json` then `brain jobs run --workflow index:reconcile --json` — over a committed upstream note change; assert the change is retrievable afterward (its chunks re-embedded, `active_generation_id` current) within the single wrapper invocation. Break: the two-step chain drops the enqueued job (sync advances but the reconcile never drains), leaving the index stale of a committed change.
- *Missing capability key fails closed.* Run the wrapper with `ATLAS_EGRESS_CAPABILITY_KEY` absent; assert `index:reconcile` fails to mint and exits `4`/`6` with no partial/unscanned persist and no cursor corruption — never a degraded success. Break: the job silently indexes without a scanned egress path, or persists an un-minted result.
- *Rotated key takes effect next cycle; deleted key hard-revokes.* Rotate the key (replace the Keychain item and the broker's copy) between two cycles; assert the second cycle mints under the new key and completes. Then delete the key without replacing it; assert the next cycle fails closed (no mint, no partial persist) and retries. Break: a rotated key leaves in-flight state that double-mints, or a deleted key falls back to a credential-less egress path instead of failing closed.

**Acceptance gates (E2E on the adopted corpus):**
- `index eval` asserts **recall@10 ≥ 0.85 AND MRR ≥ 0.70** (consumes `acceptance-thresholds.md`; current live 0.878/0.784 vector-only, 0.911/0.830 hybrid).
- `broker.rejects-test-signer-in-prod` asserts the test signer is refused outside `ATLAS_TEST_MODE` (D20).

**Test environment:** local runs the in-process subset (in-process `BrokerService`, fixture vault); CI runs with `ATLAS_PROVISIONED=1` (real two-UID/key-custody/WORM) on the ubuntu + macos-15 matrix. **Parity gap called out:** the launchd Keychain custody of `ATLAS_EGRESS_CAPABILITY_KEY` — including the rotation/revocation flow — is **not** exercised by CI (no unattended keychain-unlock in the matrix). The missing-key fail-closed path is unit-tested via an unset env var, but the real Keychain-fetch-at-job-start step and the two-custody-point rotation are verified only by the live-drive runbook, not CI. Flag, do not silently assume.

## accessibility — Accessibility

n_a — headless CLI (`brain sync` / `brain sync status`, `--json`) plus a launchd background service; no user-facing graphical or web surface, no rendered UI. Terminal output follows the repo's existing `--json`/render conventions, which are the accessibility contract for the whole `brain` binary and are unchanged by this spec.

## open-questions — Open Questions

1. **`ATLAS_EGRESS_CAPABILITY_KEY` custody — residual hardening** (owner: operator/plan). The default is resolved in `security`: Keychain-fetch-at-job-start under the `atlas-agent` identity, plaintext-in-plist rejected, fail-closed if absent, operator-triggered rotation/revocation across the two custody points (agent Keychain + egress broker), and a keychain-unlock provisioning prerequisite that gates enabling `com.atlas.sync.plist`. Residual open: (a) whether to upgrade from the Keychain-fetch default to a **broker-mediated per-run capability handoff** (strongest — no standing agent-side secret, which also removes the two-custody-point rotation dance), and (b) the precise headless keychain-unlock story for a genuinely unattended (logged-out) session (login-keychain-kept-unlocked vs. a dedicated always-unlocked non-login keychain). Must be settled before the sync daemon is enabled unattended.
2. **Where `refs/atlas/main` lives** — in the main-vault repo itself (simplest; one `.git`, adds a broker-owned ref alongside the live writers' `refs/heads/main`) vs. a broker-owned bare mirror alongside it (stronger isolation; the live writers' repo carries no Atlas ref, but sync must fetch upstream into the mirror each cycle). Trade-off: isolation vs. an extra fetch + a second on-disk object store. Owner: plan.
3. **Cadence vs. commit latency for uncommitted Obsidian edits.** Sync sees only committed state, so effective latency = brain-hub/Obsidian commit interval + sync cadence (default 300 s). Open: is 300 s the right cadence, and should anything nudge a commit (out of scope to *implement*, but the number is a decision). Owner: operator.
4. **Trust read-surface defect fix scope.** `apps/cli/src/commands/source.ts:40` hardcodes `untrusted` / `history: []`, so promotions are invisible in `source list`/`show`/`trust show`. It does not weaken adoption (adopted content is untrusted regardless), but it is a real defect. Open: fix in this spec's PR set, or split to a separate issue. Owner: operator.
5. **Deferral of 60-C / 60-D / 60-E (decision recorded).** This spec bounds itself to the adoption-and-sync core (60-A + 60-B); 60-C (purge E2E, depends on #54), 60-D (`scale-bench` + CI regression subset — the at-scale O(delta) validation), and 60-E (Tier-2/3 workflow runs + rollback under the production authorizer) are **peeled into follow-on issues**, each only loosely coupled to the sync core and each substantial enough to blow the 2-round review cap if bundled. Open: this spec's plan must **sequence** those follow-on issues after 60-A + 60-B land (60-D in particular closes the at-scale half of the O(delta) success criterion, which this spec proves only at single-note granularity). Owner: operator (deferral decided; sequencing to be fixed at plan time).
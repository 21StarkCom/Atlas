# Atlas v2 — Single-Process Simplification (Retire the Security Architecture)

*Spec — 2026-07-21 · `docs/specs/2026-07-21-atlas-v2-single-process-simplification-spec.md` · **playground tier** · in-place demolition, phased PRs, merge-when-green.*

## intent — Intent & Soundness

**Verdict: collapse the fortress to one process so the agentic layer can finally be tested.**

**The problem.** Atlas v1 is security-first, contract-first, fail-closed: two privileged broker daemons, three OS identities, socket IPC, Ed25519/Secure-Enclave authorization, per-run capability minting, a fail-closed secret scan with ciphertext quarantine, trust tiers + taint, a WORM-anchored signed audit ledger, the §2.8 four-step cross-store write, and a `refs/atlas/main` absorb-cycle. That machinery is the reason the repo exists — and it is exactly what blocks the work the owner now wants: **getting, fetching, rewriting, enhancing, and relating notes** via the agentic layer. Every agentic experiment pays a broker round-trip, a capability mint, and a scan gate before it can touch a note.

**The decision (made, not open).** Tear it down **in-place**. v2 is one process: `brain <cmd>` opens the vault **working tree** directly (`~/Code/Vaults/main-vault`), opens SQLite + LanceDB, does the thing, **commits to git**, exits. No daemons, no sockets, no OS identities, no challenges, no capabilities, no scans, no quarantine, no trust tiers, no audit ledger, no absorb-cycle.

**Why this solves it.** The agentic core (retrieve → LLM plan → validate → apply) runs directly against the vault with no privilege boundary in the path. **Safety collapses to git:** one commit per applied ChangePlan; undo = `git revert <sha>` **followed by `brain sync`** (refold the derived stores). The surviving checks — grounding, section content-hash validation, ChangePlan validation — are **correctness**, not security. They stay.

**Trade-off, named once.** Agents write **directly into the real second brain** with git history as the only undo. Accepted, deliberately. Granular **one-commit-per-ChangePlan** keeps every revert surgical.

**Alternatives rejected.** (1) *Keep the brokers, add a dev-mode bypass* — rejected: a bypass is **more** code, not less; the goal is to delete the machinery, not gate it. (2) *Fork a fresh v2 repo* — rejected: owner chose in-place demolition; everything is revivable from the `v1-fortress` tag.

**Assumptions (stated, consistent across every section below).** Single user, single trusted machine (the owner's Mac), single trusted operator. The real vault is already graduated (210 notes, 2026-07-17) — the one-time onboarding is **done and will not recur**. Gemini is the only provider. Git is present and healthy on the vault.

**Success criteria (objective — an engineer can check each).**
- Full `pnpm -r build` + `pnpm -r test` green with **zero provisioning** (no `ATLAS_PROVISIONED`, no daemons, no `atlas-*` identities); the provisioned-only suites are **deleted, not skipped**.
- The command surface shrinks from **55 to the survivor set** owned by `commands.json`; the `contract-lint` bijection (registry ↔ fixture ↔ schemas) and `contract:check` determinism gate both pass.
- `index eval` clears the normative gate (**recall@10 ≥ 0.85 / MRR ≥ 0.70**; current default hybrid **0.911 / 0.830**).
- No **runtime** source references a retired package, socket path, capability key, or canonical-ref env var. The deprovision script's explicit deletion **allowlist** is the single exempt location: the no-reference grep gate excludes that script's path, and a companion check asserts the allowlist enumerates exactly the retired resources (so the gate and the cleanup script can both hold).
- A ChangePlan apply produces **exactly one commit** touching only the ChangePlan's paths; `git revert` on that sha **followed by `brain sync`** (to refold the derived stores) restores prior state.
- The deprovision script leaves the live Mac with no `atlas-*` users/groups, sockets, WORM anchor, launchd services, or **retired v1** Keychain items (signer/capability); the surviving `atlas-gemini-api-key` item is **preserved**.

**Finalized vs open.** The demolition, the kept core, the exit-code set, and the two binding contracts (`link --json`, `sync` semantics) are **finalized** here. Genuinely-open items are enumerated in `open-questions` — nothing is punted silently.

## scope — Scope & Boundaries

**Tier: playground.** Single-user, local, personal tooling on the owner's own Mac. The **absence** of HA, migration ceremony, audit trails, secret rotation, adversarial-input defense, and 10×-scale capacity is the **point of this spec**, not a gap. This document *removes* that machinery; do not read a missing production subsystem as a defect.

**In scope.** (1) An in-place demolition of the security architecture. (2) A direct, in-process implementation of the kept core behind the existing seams. (3) A shrunken, drift-gated command surface. (4) A deprovision script for the live Mac. (5) `ADR-0003` recording the retirement + a `v1-fortress` tag on `main` before any deletion (`0001` egress-scan and `0002` P-256 signer exist; ADRs are immutable — the retirement supersedes both, at the next monotonic number).

**Kill list (all owner-confirmed).**

| Kill | Extent |
|---|---|
| `packages/broker` — both daemons, sockets, challenges, capability minting | whole package |
| `provisioning/` + 3 OS identities + launchd services | plus a deprovision script for the live Mac |
| `console/` + `console/signer/` + the `watch` command | nuked — new UI comes later, once Atlas works properly |
| `@atlas/scan` — engine, both guards, quarantine | total kill; exit code **3** retires |
| Trust tiers, taint, `source trust *`, `PromoteTrust` / `RevokeTrust` ops | fail-closed ingest posture dies |
| Graduation pipeline (`graduation scan\|audit\|migrate`) | onboarding done; revive from tag if ever needed |
| Audit ledger, run-manifests-as-audit, WORM anchor, §2.8 write protocol, AEAD backup + watermark blocking, `db backup\|restore\|verify` | tamper-evidence machinery |
| `--export-challenge` / `--authorization` flows, `--yes`-never-authorizes doctrine | broker authz UX; exit code **6** retires |
| `refs/atlas/main` absorb-cycle, `sync reset`, canonical-ref indirection (`ATLAS_CANONICAL_REF`) | vault working tree is read/written directly |
| Parser sandbox jail (Seatbelt / userns / seccomp / cgroup) | md/txt/pdf/html normalizers survive |
| Issues **#60, #65, #297, #298** | close as retired |

**Keep list (all owner-confirmed).**

| Keep | v2 shape |
|---|---|
| Note model — parse, frontmatter, section tree, ChangePlan (15 ops incl. `CreateRelationship`/`SetLink`), grounding + section content-hash validation | unchanged; these are correctness, not security |
| SQLite projection | stripped to plain migrations + rebuild-from-vault; DB disposable |
| LanceDB retrieval — chunk/embed, hybrid FTS+vector, staleness/repair, eval harness | unchanged; eval gate stays normative |
| Synthesis engine — retrieve → LLM plan (`generateObject<ChangePlan>`) → validate → apply | the agentic core under test |
| Evidence machinery — `evidence resolve\|retry\|review` + reverification | rebased onto the direct model client; run-ledger/audit deps stripped to plain SQLite state |
| Gemini adapter | moves out of the egress broker into a direct in-process provider client; `brain` reads the Keychain item **directly** (env var only as CI/test override — no launcher, §interfaces); per-call cap survives |
| Jobs queue | minimal, for reindex batching |
| `maintain` workflow | agentic maintenance |
| CLI-contract harness — `commands.json` + fixture + schemas + `contract-lint` | survives as the drift gate; demolition = delete rows + regenerate |
| `withFixtureVault` testing harness | fixture vault in a throwaway git repo *is* the v2 shape; provisioned-only suites die |

**Command surface: 55 → the survivor set** (membership owned by `commands.json`, §ssot). Survivors: `status` (absorbs `doctor`, `db status`, `index status`, `sync status`), `note show|add|history|related`, `query`, `enrich`, **`link`** (NEW — fronts `CreateRelationship`/`SetLink`), `ingest`, `source add|list|show`, `index rebuild|eval`, `db migrate|rebuild`, `sync` (diff working tree → reindex changed), `validate`, `maintain`, `jobs run|list`, `evidence resolve|retry|review`. Killed: `doctor`, `db backup|restore|verify|status`, all 8 `git *` commands (git log/revert **is** the review), `graduation *`, `quarantine *`, `source trust *`, `purge`, `reconcile` (folds into `sync`), `index repair|status|verify` (fold into `index rebuild` / `status`), `watch`, `sync reset|status`.

**Lead decisions on the delegated-discretion commands** (the brief left `inspect` and `jobs retry|cancel` to the lead — recorded here, not silently punted): **kill `inspect`** (its read surface folds into `status` + `note show`) and **kill `jobs retry|cancel`** (a single-user reindex queue re-runs via `jobs run`; retry/cancel are ceremony). The final row count is whatever `commands.json` holds post-demolition — the brief's "~18" is a target, not a contract.

**Delivery — 6 phased PRs, each independently green + mergeable.**

| # | PR | Gate |
|---|---|---|
| 1 | `ADR-0003` + this spec; `v1-fortress` tag on `main` | docs land; tag exists |
| 2 | In-process cutover — replace broker/egress clients with direct impls behind existing seams; daemons off | full suite green, **zero provisioning** |
| 3 | Demolition — delete broker/provisioning/console/signer/scan/quarantine/trust/graduation; shrink `commands.json`; delete dead tests | `contract-lint` + `contract:check` green; no dangling imports |
| 4 | Persistence strip — plain SQLite; no ledger protocol, no backup | `db rebuild` parity holds |
| 5 | Point at `main-vault` directly + deprovision script | live Mac clean (human-run) |
| 6 | Docs rewrite — new CLAUDE.md constitution, README; retire spec-corpus pointers | docs honest to v2 |

**What this is NOT.** Not a retrieval or note-model rewrite (parse/index/retrieve internals unchanged where possible). Not a new UI (Console nuked; a new UI comes later). Not multi-provider (Gemini ported as-is; an Anthropic provider is future work). Not a security redesign (v2 intentionally has **no** security boundary beyond git history). Not touching the legacy `2nd-brain`/`brain-hub` ecosystem. **MCP server surface: out of scope** (a future agent surface).

## interfaces — Interfaces & Contracts

**Command membership, phase, privilege, idempotency are owned by `docs/specs/cli-contract/commands.json`** (version-bumped, still gated by the bijection). Handlers register at import time; nothing re-classifies a command outside the registry. Adding/removing/renaming a command is a `commands.json` row diff + a fixture line + a per-command schema file, then `pnpm contract:write` (§ssot).

### `link` (NEW) — flag surface + `--json` schema

`link` fronts two ChangePlan ops: **`CreateRelationship`** (a typed edge, `--predicate` present) and **`SetLink`** (a plain link/wikilink, no predicate).

| Flag / arg | Rule |
|---|---|
| `<source>` (positional) | source note id — required |
| `<target>` (positional) | target note id — required |
| `--predicate <p>` | present ⇒ `CreateRelationship` (`predicate` set; `action:"related"` **when a new edge is created**); absent ⇒ `SetLink` (`predicate:null`; `action:"added"` **when a new edge is created**). An alias change on an **existing** edge returns `action:"updated"` in both forms; noops return `action:"noop"` (§behavior) |
| `--alias <a>` | display alias; sets `alias`. Meaningful **only on add**. **`--alias` + `--remove` ⇒ exit 5 (usage)**, evaluated before anything else. |
| `--remove` | removes the matching edge. **With `--predicate <p>`**: removes exactly that relationship edge (`source→target`, `predicate=p`), leaving the plain link and any other-predicate edges intact. **Without `--predicate`**: removes only the plain `SetLink` edge (`predicate` NULL). Matched ⇒ `action:"removed"`; no matching edge ⇒ `action:"noop"` (§behavior). |
| `--json` | emit the machine object below to stdout |

**Link-removal semantics are finalized (not open):** the selector is `(source, target)` plus `predicate` **iff** `--predicate` is passed; a remove never touches an edge the selector doesn't name; a remove that matches nothing is a **noop**, not an error (§behavior). This closes the one previously-open removal question.

`link --json` output object — **owned by `docs/specs/cli-contract/link.schema.json`** (machine SSOT), `contract-lint`-gated like every command:

| Field | Type | Meaning |
|---|---|---|
| `action` | `"added" \| "updated" \| "removed" \| "related" \| "noop"` | what happened (`related` = new `CreateRelationship` edge; `updated` = **alias changed on an existing edge** — a metadata mutation, never a new edge) |
| `source` | `string` | source note id |
| `target` | `string` | target note id |
| `predicate` | `string \| null` | the relationship predicate; `null` for SetLink forms |
| `alias` | `string \| null` | the display alias; `null` unless `--alias` |
| `commit` | `string \| null` | sha of the one commit; **`null` iff `noop`** |
| `noop` | `boolean` | `true` iff `action:"noop"` |

### `sync` — `--json` schema

`sync` reconciles the **working tree** against the SQLite projection by per-note content hash (§behavior). **There is no HEAD cursor** — the projection's per-note `contentHash` *is* the cursor (§ssot). Schema **owned by `docs/specs/cli-contract/sync.schema.json`** (machine SSOT); the full field set, reproduced here for the implementer:

| Field | Type | Meaning |
|---|---|---|
| `scannedCount` | integer | working-tree note files hashed this run |
| `changedCount` | integer | notes whose on-disk hash ≠ projection `contentHash` → reindexed |
| `newCount` | integer | working-tree notes with no projection row → indexed |
| `droppedCount` | integer | projection rows with no backing file → removed (cross-store purge, §behavior) |
| `movedCount` | integer | pure moves — same id, same hash, new path → projection `path` updated in place, **no re-embed** |
| `noop` | boolean | `true` iff `changedCount = newCount = droppedCount = movedCount = 0` |

Contract deltas from the v1 `sync --json`: **drops `head`** (no cursor), **adds `scannedCount` + `movedCount`**. `reindexed = changedCount + newCount` is derivable and is **not** a stored field (SSOT — consumers sum; no re-derived owner); a pure move is **never** part of `reindexed` — that is why it has its own counter.

**Moves/renames (binding).** Notes are matched by **stable note id** (frontmatter `id`), never by path. A file whose id matches an existing projection row but whose **path** differs — content hash unchanged — is a **move**: the projection row's `path` is updated in place, counted in **`movedCount`**, and nothing is re-embedded (chunks/links/evidence key on the note id, not the path). A moved-**and-edited** note is simply a changed note (`changedCount`, reindexed). A new path carrying a **new** id is `new` + the old row ages out as `dropped` — the literal drop-recreate never fires for a pure move.

### `status` — `--json` schema (absorbs `doctor`, `db status`, `index status`, `sync status`)

Schema **owned by `docs/specs/cli-contract/status.schema.json`** (machine SSOT); the full field set, reproduced for the implementer. Each folded surface is a named sub-object:

| Field | Type | Meaning |
|---|---|---|
| `ok` | boolean | all `checks[]` passed |
| `vault` | object | `{ path: string, headSha: string, dirty: boolean, noteCount: integer }` |
| `db` | object | `{ schemaVersion: integer, noteCount: integer, sectionCount: integer, linkCount: integer }` |
| `index` | object | `{ chunkCount: integer, staleCount: integer, embeddingModel: string }` — `staleCount` = chunks whose backing note hash changed since embed |
| `sync` | object | `{ pendingChangedCount: integer, pendingNewCount: integer, pendingDroppedCount: integer, pendingMovedCount: integer }` — the **complete** pending-reconciliation picture, one field per reconciliation category (changed / new / dropped / moved), all from the one reconciliation routine (§ssot); **informational** (pending sync work is the normal state of a dirty tree, not unhealth) and never drives `checks[]` |
| `checks` | array | the retained `doctor` health probes: `[{ name: string, ok: boolean, detail: string \| null }]` — the surviving set is `vault-reachable`, `git-healthy`, `provider-key-present`, `index-not-stale` |

Contract deltas from v1: `status.sync` **drops `lastIndexedHead`**, **adds the four pending counts**; the v1 `doctor` backup-health and signer-registry checks are **retired with their machinery** (§security) and do not appear in `checks[]`.

**Exit contract (binding).** `status` exits **0 whenever the payload was produced** — including `ok:false` (a failed probe is data, not a process failure; consumers inspect `ok`, matching the old `doctor` posture). It exits **2** only when the vault/config is unresolvable and no payload is possible. No other exit is defined for `status`.

### Exit codes

The binary's `EXIT` set contracts to **`{0, 1, 2, 4, 5}`** + `7` (jobs-run aggregate only):

| code | meaning |
|---|---|
| `0` | ok |
| `1` | validation — includes **grounding failure** (dirty edited note) |
| `2` | vault / lock — includes vault-lock contention or a pre-existing git `index.lock` |
| `4` | internal |
| `5` | usage — includes `--alias` + `--remove` on `link` |
| `7` | **only** the `jobs run` batch aggregate (a transient-but-exhausted item) |

**Retired: `3` (secret-scan)** and **`6` (action-required / broker authz)** — no command emits them.

### Error envelope

The single error envelope is unchanged: `{ code, message, remediation, retryable, retryAfterMs }`. `retryable`/`retryAfterMs` ride the envelope at exit 4; nothing emits exit 6 or 7 through it. The **sole exception** stays the batch commands (`jobs run`), which emit `{ items[], aggregate }` with the aggregate `exitCode` (the only path to 7).

### File formats & data model

- **Vault note** — markdown (frontmatter + section tree). Unchanged. The vault is the **system of record** for note/section/link *content*.
- **ChangePlan** — the **15 remaining ops** (incl. `CreateRelationship`/`SetLink`), canonical serialization, and identity-key are owned by **`@atlas/contracts`**; the CLI consumes them, never re-derives.
- **SQLite projection** (derived cache, rebuildable via `db rebuild`): `note(id, path, title, contentHash, frontmatter)` 1:N `section(noteId, heading, contentHash, order)`; `link(sourceId, targetId, predicate NULL, alias NULL)` as an N:M edge set between notes — a plain link (`predicate` NULL) and a `cites` relationship between the same pair are **distinct rows**. Because a bare SQLite `UNIQUE(sourceId, targetId, predicate)` will **not** dedupe plain links (SQLite treats every NULL as distinct), uniqueness is enforced by **two partial indexes** — `UNIQUE(sourceId, targetId) WHERE predicate IS NULL` and `UNIQUE(sourceId, targetId, predicate) WHERE predicate IS NOT NULL` — which is what makes the duplicate-add noop and the exact-remove selector well-defined; `chunk` metadata (1 note : N chunks; the embeddings themselves live in **LanceDB**, the retrieval index, rebuildable via `index rebuild`).
- **Operational state** (SQLite is the SoR, **not** vault-derived, retained across `db rebuild`): `jobs` / `job_attempts` (owned by `@atlas/jobs`), `source` registry (below), `model_calls` (provider-call log for token/cost observability). **Evidence state is NOT here** — it is a **vault-derived projection** folded from note frontmatter (below), regenerated by `db rebuild` like `note`/`link`, not retained operational state.
- **Source registry** (operational SQLite — the persistence model behind `source add|list|show` + `ingest`): `source(id TEXT PK, kind TEXT CHECK(kind IN ('file','url')), locator TEXT UNIQUE, title TEXT NULL, addedAt TEXT, lastIngestedAt TEXT NULL)`. `source add` inserts (duplicate `locator` ⇒ noop success, id returned); `ingest` normalizes the source's bytes into notes and stamps `lastIngestedAt`; notes produced from a source carry its id in their frontmatter `sources:` list (the vault side of the relationship — vault is SoR for note content, the registry is SoR for the source's own row). Retained across `db rebuild`.
- **Evidence state** (a **vault-derived projection** folded from note frontmatter — the note's `evidence:` block is the SoR; `db rebuild`/`sync` regenerate the row, so it is **not** retained operational state; rebased off the v1 run-ledger/audit coupling): `evidence(id TEXT PK, noteId TEXT, sectionPath TEXT NULL, claim TEXT, citation TEXT NULL, status TEXT, verdict TEXT NULL, attempts INTEGER DEFAULT 0, lastCheckedAt TEXT NULL, sourceNoteHash TEXT NULL, createdAt TEXT)` — `status ∈ {pending, resolved, failed, needs-review}`; `verdict` holds the reverification-outcome text (`NULL` until first checked); `attempts` counts `evidence retry` re-runs; `sourceNoteHash` is the between-fold **content-hash staleness guard** (the note's on-disk content hash when the row was last folded — a row whose recorded hash no longer matches its note is treated as stale/`needs-review`, never trusted). **`sectionPath` is the note model's section path** (e.g. `Overview/Goals`) — a documented **soft locator**, `NULL` for note-level evidence. Cardinality: N `evidence` rows : **0..1** note — `noteId` is a **soft** reference to the note's stable id, **not** a rebuild-enforced foreign key, because `db rebuild` regenerates the row from note frontmatter and a transiently-dangling reference must never abort the rebuild. Resolution is best-effort at read time: a `noteId`/`sectionPath` that no longer resolves (deleted note, renamed section) is surfaced by `evidence review` as `target: missing` and is eligible for `needs-review` — never a crash, never silently dropped. Consumed by `evidence resolve|retry|review`. **This is the final, complete v2 contract — the eleven columns above are the whole table.** No v1 evidence column is carried: the v1 run-ledger/audit couplings (run-id, ledger-seq, signature, and manifest back-references) are **dropped, not migrated**, because v2 starts a **fresh** `evidence` table per the no-shims doctrine (§behavior — v1 state is revived from the `v1-fortress` tag, never carried forward). **In-place cutover (owned, not implied):** the `evidence` table belongs to `@atlas/sqlite-store`'s migration chain (§ssot); Phase 4 ships a **destructive migration** that drops the v1 evidence/audit-coupling tables and creates the v2 table above — v1 evidence rows are **discarded by design** on the live install (accepted: playground data, revivable from the tag). A cutover test starts from the v1 table shape and asserts the exact v2 schema after `db migrate`.
- **Provider client** — a direct in-process Gemini client, ported from `packages/broker/src/egress/gemini.ts` (the `x-goog-api-key` HTTP path survives; the IPC/capability wrapper does not). **Key resolution (binding — there is no launcher):** at process start, `brain` reads **`ATLAS_GEMINI_API_KEY`** if set (the CI/test/override path), **else reads the Keychain item `atlas-gemini-api-key` directly** (`security find-generic-password -s atlas-gemini-api-key -w`). The v1 "brain never touches the Keychain" doctrine existed for privilege separation, which is retired — one process reads its own key. The resolved key is held **in-process only** — never on disk, in logs, or in git. Enforces the per-call cap `PLAN_GENERATION_MAX_TOKENS = 4096` (§ssot).

## behavior — Behavior & Correctness

**Command lifecycle (every command).** Resolve the vault path → open the working tree → open SQLite + LanceDB → do the thing → **exit**. Read commands never write git.

**The canonical mutation order (binding SSOT — every mutating path follows exactly this sequence; no section may state another):**

> **take the vault lock → validate the ChangePlan (`@atlas/contracts`) → ground it against the projection → apply to the working tree → commit (pathspec-scoped `git commit -- <paths>`, only the ChangePlan's touched paths, leaving pre-existing staged entries for other files untouched) → refresh the SQLite projection + LanceDB index for the touched notes → release the lock → exit.**

Commit precedes refresh deliberately: a crash **after** the commit leaves the projection stale, and the next `sync` heals it structurally (the projection is the cursor); the reverse order would strand a committed-but-unmirrored tree only a human can notice. A crash **before** the commit leaves an uncommitted working-tree edit, which the dirty-note grounding rule then surfaces on the next mutation (remediation: commit/stash or `git checkout` the file).

**Dirty-vault doctrine (binding — replaces the blanket "vault dirty ⇒ exit 2").**
- **Read commands + `sync`:** a dirty tree is normal input, **never an error**.
- **Mutating commands** (`link`, `enrich`, `note add`, `maintain` / `evidence` applies): allowed with **unrelated** dirt. The apply stages + commits **only the paths its ChangePlan touched**; unrelated dirt stays uncommitted in the working tree.
- **Dirty edited/named note (binding):** grounding fails → **exit 1**, **before any apply or commit**, if any note the command **edits or names** is dirty. A named note is dirty if **either** its on-disk hash ≠ projection `contentHash` (stale projection — remediation `run brain sync`) **or** it carries an **uncommitted git diff against HEAD** (a pre-existing edit — remediation `commit or stash it first`). The git-clean requirement is load-bearing: a synced-but-uncommitted edit matches the projection yet would otherwise be swept into the ChangePlan commit, so it must fail grounding too. Both the `link` source and target must be clean at apply time: the **source** because it is rewritten, the **target** because grounding binds the new edge to the target's known projection identity. Dirt on notes the command does **not** name is **unrelated dirt** and never fails grounding (per the mutating-commands rule above).
- **git `index.lock` present** ⇒ **exit 2** (unchanged).

**`link` behavior (binding — noop / duplicate / absent-edge).** `link` validates flags, then grounds, then applies against the `link` edge set; every outcome below is gated by the two prior steps.
- **`--alias` + `--remove`** ⇒ **exit 5 (usage)**, evaluated **before** grounding — no mutation, no commit.
- **Grounding precedes every add/remove outcome:** grounding fails → **exit 1** (never a noop), **before any apply or commit**, if `<source>` or `<target>` does not resolve to an existing note, **or the source note — the file the edge is written into — is dirty**, **or the target is dirty** (dirty = the two-condition test above: on-disk hash ≠ projection `contentHash`, **or** an uncommitted git diff vs HEAD). The noop paths below apply **only** to grounded, clean, existing notes.
- **Add — new edge.** No edge with the selector `(source, target, predicate)` exists → create it. Plain form (no `--predicate`) → `action:"added"`; predicate form → `action:"related"`. One commit; `commit:<sha>`, `noop:false`, exit 0.
- **Add — duplicate (noop).** An edge with the **same** `(source, target, predicate)` already exists **and** either `--alias` is absent or its value equals the stored alias → **noop**: `action:"noop"`, `commit:null`, `noop:true`, **no git write**, exit 0. Re-adding an identical edge is idempotent.
- **Add — alias change.** The same `(source, target, predicate)` edge exists but `--alias` supplies a **different** alias → update the alias in place: one commit, **`action:"updated"`** (distinguishable from edge creation — a consumer counting new relationships must not count an alias touch), `noop:false`. An add **without** `--alias` never clobbers a stored alias — it falls to the duplicate-noop path.
- **Remove — matching edge.** `--remove` with an edge matching the selector (predicate-scoped iff `--predicate`, per §interfaces) → remove it: `action:"removed"`, one commit, `noop:false`, exit 0.
- **Remove — absent edge (noop).** `--remove` whose selector matches **no** edge → **noop**: `action:"noop"`, `commit:null`, `noop:true`, no git write, exit 0. Removing an edge that is not there is idempotent, not an error.
- **noop conditions, summarized:** exactly (a) the duplicate-identical add and (b) the absent-edge remove. Every noop emits `action:"noop"`, `commit:null`, `noop:true`, exit 0, and writes **neither** git **nor** the projection.

**`sync` mechanism (binding).** No HEAD cursor — **the projection IS the cursor**; no second state marker exists. `sync` runs the one reconciliation routine (§ssot): scan vault files → hash each → compare to the projection's per-note `contentHash` → **reindex mismatches + new files** and, for each projection row with no backing file, **purge the note across both stores, invisibility first**: delete the note's projection row **and** its `chunk` metadata rows in **one SQLite transaction** (retrieval joins results against live projection rows, so the note is unreturnable the instant that transaction commits), **then** delete its LanceDB vectors. An interruption can only strand LanceDB residue that the projection join already filters — never a retrievable ghost; residue is swept by **`index rebuild` only** (sync never touches it — a sweep inside `sync` would make an unchanged-tree run write the index and break the structural-noop invariant below). Dirty vs clean is irrelevant — **uncommitted editor edits are sync's primary input.** Idempotency is structural: an unchanged tree (clean *or* dirty) re-hashes to all-match → **`noop: true`, exit 0, no index write**.

**`db rebuild`.** Regenerates the vault-derived projection (`note`/`section`/`link`/`chunk` metadata **and the `evidence` rows** — folded from note frontmatter) from the vault working tree. Operational tables (`jobs`, `job_attempts`, the `source` registry, `model_calls`) are **retained** across rebuild (lead decision — they are not vault-derived and losing them loses history, not correctness). Evidence is **NOT** retained — it is regenerated with the rest of the vault-derived projection. The DB is disposable in that a lost projection is fully regenerable; operational history is best-effort.

**Fail-fast, no shims.** Grounding failure is a hard exit 1, never a silent skip-and-continue. No compatibility fallbacks, no infinite retries on a flaky provider (the per-call token cap bounds a single call; a failed plan-gen surfaces the error), no v1/v2 migration shims — v1 state is revived from the tag, not carried forward.

**Concurrency & zero-state.** Single-process, single-user — but two `brain` invocations can still overlap (two terminals, a scripted batch), so serialization is a **brain-owned vault lock** (an advisory `flock` on a vault-local lockfile), **not** git's `index.lock` (git holds that only during individual index operations, so it does not span grounding + working-tree apply). **Every derived-store writer takes the same lock** — mutating commands (held for the full canonical mutation order above), **`sync`**, `db migrate|rebuild`, `index rebuild`, and `jobs run` — so a `sync` can never interleave with a mutation's apply/refresh; read commands never take it. Any writer that cannot take the lock **exits 2** (fail-fast, no queueing). A pre-existing external git `index.lock` at apply time is a separate preflight failure (also exit 2). Empty vault ⇒ `db rebuild` yields an empty projection; `sync` on an unchanged/empty tree ⇒ `noop`; `query` against an empty index ⇒ empty result set, exit 0.

**Observability.** Structured logs to **stderr**; `--json` payloads to **stdout**. **`git log` on the vault is the mutation audit trail** — it replaces the retired ledger; remediation is **`git revert <sha>` + `brain sync`** (the revert restores the tree; the sync refolds the projection + index — a git-only revert leaves the derived stores stale by design).

**Deprovision (Phase 5) — destructive, human-run, not CI.** The script unloads the 3 launchd services and deletes the `atlas-*` OS users/groups, sockets, WORM-anchor dir, and the **retired v1** Keychain items (signer/capability approver keys) from an explicit allowlist — it **preserves `atlas-gemini-api-key`**, the credential `brain` reads directly (§interfaces). The allowlist is the **single location exempt** from the no-retired-reference grep gate (§intent success criteria) — the gate excludes the script's path; a companion check asserts the allowlist enumerates exactly the retired resources. It **mutates real host state and is irreversible without re-provisioning** — it is owner-run with `sudo`, gated on explicit confirmation, and never executed in CI.

## ssot — Single Source of Truth

Every value/rule/state below has exactly **one** owner; consumers consume, never re-derive.

- **Command membership / phase / privilege / idempotency** → `docs/specs/cli-contract/commands.json`.
- **`link --json` schema** → `docs/specs/cli-contract/link.schema.json`.
- **`sync` / `status` schemas** → their respective `*.schema.json` (the retirements of `head` / `lastIndexedHead` and the additions of `scannedCount` + `movedCount` and the **four** `status.sync` pending counts live only there).
- **ChangePlan (15 ops), canonical serialization, identity-key** → `@atlas/contracts`.
- **The sync cursor** → the SQLite projection's per-note **`contentHash`**. There is **no** `head`, **no** `lastIndexedHead`, no second marker — the design's one dual-state risk is closed by declaring the projection the sole cursor.
- **The vault↔projection diff** → **one reconciliation routine owned by the sync engine** — file discovery, the note-file filter, hashing, and changed/new/dropped/moved classification live there and nowhere else. `sync` consumes its result to reconcile; `status` consumes the **same** routine read-only for the four pending counts. Two commands can never disagree about the pending set because neither re-derives it.
- **Retirement decision** → **`ADR-0003`** (supersedes `0001` egress-scan + `0002` P-256 signer; ADRs immutable — supersede, don't edit).
- **Eval thresholds** (recall@10 ≥ 0.85 / MRR ≥ 0.70) → the `index eval` harness config; the current score (0.911 / 0.830) is a measurement, not a duplicated constant.
- **`PLAN_GENERATION_MAX_TOKENS = 4096`** → owned once at `apps/cli/src/workflows/index.ts`; the direct provider client reads it — no second copy.
- **Vault path** → config (points at the working tree); no canonical-ref indirection, no `ATLAS_CANONICAL_REF`.
- **Exit-code set** → the binary's `EXIT` set (the schema `exitCode` enums consume it).
- **Gemini API key** → one Keychain item (`atlas-gemini-api-key`), read **directly by `brain`** at process start, with the env var `ATLAS_GEMINI_API_KEY` as the override path (CI/tests) — no launcher, no second store (§interfaces Provider client).
- **Migration ownership** → each package owns its own migrations (`@atlas/sqlite-store` core projection; `@atlas/jobs` owns `jobs`/`job_attempts`).

## security — Security & Trust

**Verdict: v2 has NO security boundary beyond git history — by design. This is correct restraint for a single-user laptop tool, not a gap.**

**Threat model: a trusted operator is not the same as trusted bytes.** Single trusted user, single trusted machine, single trusted operator — but the operator can still `ingest` externally-sourced documents (PDF/HTML from the world), and **those bytes are untrusted even when the operator is not**. v2 parses them **unsandboxed** (the jail is retired): a parser exploit runs with the operator's full filesystem privileges and can reach the in-process Gemini key. That is a **named, accepted** residual risk (below), not an oversight — the spec defends nothing here by explicit owner choice.

**Trust model.** `brain` runs as the invoking user with that user's full filesystem privileges. No privilege separation, no OS identities, no brokers, no sockets. The v1 impossibility properties (unexported `runGit`, protected-ref mutator monopoly) are **moot** — `packages/git` becomes plain typed git ops including committing to the vault's `refs/heads/main`.

**Retired security machinery (all confirmed):**

| Retired | Was |
|---|---|
| `@atlas/scan` + both guards + quarantine | fail-closed secret detector; exit 3 |
| Trust tiers + taint floors + `source trust *` | fail-closed ingest posture |
| Challenges / capabilities / `atlas-signer` / Secure-Enclave P-256 | broker authorization; exit 6 |
| Audit ledger + WORM anchor + §2.8 protocol + AEAD backup | tamper-evidence |
| Sandbox jail (Seatbelt / userns / seccomp) | parser isolation |
| Egress broker | sole credential/network holder |

**Secrets.** The Gemini API key lives in the Keychain (`atlas-gemini-api-key`) → is read **once at process start by `brain` itself** (env var `ATLAS_GEMINI_API_KEY` as the CI/test override) → held **in-process only** → **never** written to disk, logs, or git. Provider calls go over TLS via the SDK/HTTP client.

**Egress posture (owner's explicit choice).** Request bytes **and** released response bytes go to Gemini with **nothing between the notes and the provider** — the scan gate is retired. Note content leaves the machine on `enrich` / `query` / `maintain`. Accepted.

**Data.** The vault is the user's own notes on the user's own machine. No sensitivity classification, no PII-handling ceremony, no rotation schedule — proportional to the tier.

**Audit & remediation.** `git log` / `git history` **is** the audit trail; **`git revert <sha>` + `brain sync`** is the remediation (§behavior Observability — the sync refolds the derived stores). There is no separate signed ledger.

**Named residual risks (both accepted, both owner-chosen — do not re-introduce the retired machinery to "close" them):**
1. Agents write directly into the real second brain; git history is the only undo. **One-commit-per-ChangePlan** keeps reverts surgical.
2. Externally-sourced ingested documents are parsed **unsandboxed** with the operator's full privileges and the in-process provider key reachable (threat model above). Mitigation: none, by design; the practical control is the operator choosing what to `ingest`.

## test-plan — Test Plan

Substrate: the `withFixtureVault` harness (a fixture vault copied into a throwaway git repo, torn down on exit). CI matrix: `ubuntu-latest` + `macos-15`, Node 26 — but **no `ATLAS_PROVISIONED`, no two-UID job, no daemons**. **Platform posture:** macOS is the **only supported target** (single trusted machine = the owner's Mac; the Keychain read is macOS-only, env-var override elsewhere); the ubuntu runner is retained purely as a cheap **portability canary** for the platform-neutral suite, not a support commitment — dropping it later is a CI edit, not a scope change.

**Binding proving tests — dirty-vault doctrine (named rows):**

| # | Test | Asserts |
|---|---|---|
| a | unrelated-dirt + `link`, where the dirt is **both** an unstaged edit **and** a pre-**staged** unrelated file | success; the commit touches **only** `link`'s paths — the pre-staged unrelated file is **excluded** from the commit; both kinds of unrelated dirt are intact afterward |
| b | dirty-**target** + `enrich` / `link` (an uncommitted git edit on the target) | **exit 1** grounding failure, remediation `commit or stash` |
| b2 | dirty-**source** + `link` (an uncommitted git edit on the note the edge is written into) | **exit 1** grounding failure, remediation `commit or stash` — proves the edited file's dirt fails **before apply**, symmetric with row b; **no commit, no projection write** |
| b3 | edit source A on disk → `brain sync` → `link A B` | **exit 1** grounding failure — after sync A's on-disk hash matches the projection, but A still carries an **uncommitted git diff vs HEAD**, so grounding fails; remediation `commit or stash`; **no commit** (the manual edit is never swept into a ChangePlan commit) |
| c | dirty tree + `sync`, then immediate second `sync` | first run indexes the changed notes; second run ⇒ **`noop: true`, no index write** |
| d | git `index.lock` present + a mutating command | **exit 2** |
| d2 | **two overlapping mutations** — the harness pauses invocation 1 **after grounding** (holding the vault lock), releases both concurrently | **exactly one** succeeds with one commit; the loser **exits 2** with **no** working-tree, projection, or HEAD change — proves the vault lock spans the full canonical mutation order, not just git's transient `index.lock` |
| d3 | `sync` launched while a mutation holds the vault lock | `sync` **exits 2** (every derived-store writer contends on the same lock); no partial index write |

**Binding proving tests — `link` (add / noop / predicate-scoped remove / alias+remove):**

| # | Test | Asserts |
|---|---|---|
| e | `link A B` on a fresh pair | `action:"added"`, `predicate:null`; **exactly one commit**, `commit` = that sha, `noop:false`; the SetLink edge is present in the projection afterward |
| f | `link A B --predicate cites` on a fresh pair | `action:"related"`, `predicate:"cites"`; one commit, `noop:false`; the relationship edge present |
| g | `link A B` run **twice** (duplicate add) | 2nd run ⇒ `action:"noop"`, `commit:null`, `noop:true`, exit 0; **HEAD sha unchanged** from the 1st run (no new commit, no projection write) |
| h | given **both** a plain link and a `cites` edge A→B, run `link A B --predicate cites --remove` | removes **only** the `cites` edge; the plain link **survives** in the projection; `action:"removed"`, one commit |
| i | `link A B --remove` when **no** A→B edge exists (absent-edge remove) | `action:"noop"`, `commit:null`, `noop:true`, exit 0; **no commit** (HEAD unchanged) |
| j | `link A B --alias foo --remove` (alias + remove) | **exit 5 (usage)**; no mutation, no commit, no projection write — the flag conflict is caught before grounding |
| k | `link A MISSING` / `link MISSING B` (unknown target / source) | **exit 1** grounding failure — never a noop; no commit, no projection write |
| l | `link A B --alias foo`, then `link A B --alias bar` (alias change) | 2nd run ⇒ `action:"updated"`, **one** in-place alias mutation + one commit, `noop:false`; **no duplicate edge** in the projection |
| m | `link A B --alias foo`, then `link A B` (re-add **without** `--alias`) | 2nd run ⇒ `action:"noop"`, `commit:null`, exit 0; the stored alias **`foo` is preserved** (an aliasless re-add never clobbers) |
| n | `link A B --alias foo`, then `link A B --alias foo` (identical alias re-add) | 2nd run ⇒ `action:"noop"`, `commit:null`, HEAD unchanged — alias equality is part of the duplicate test |

**Contract & drift gates.**
- `contract-lint.test.ts` — registry ↔ fixture ↔ schema **bijection** holds after the row deletions and the new `link` row.
- `command-registration.test.ts` — no `not-implemented`-at-live-drive class regressions.
- `node tools/gen-cli-contract.ts --check` — determinism.

**Correctness & retrieval.**
- **`db rebuild` parity** — rebuild-from-vault produces the same projection as the incremental fold.
- **Operational-table retention across `db rebuild`** — seed `jobs`, `job_attempts`, `source`, and `model_calls` operational rows PLUS a note carrying `evidence:` frontmatter; run `db rebuild`; assert the vault-derived projection (`note`/`section`/`link`/`chunk` **and the `evidence` rows**) is regenerated from the vault **and** every seeded operational row survives unchanged. **Break scenario it catches:** a rebuild that drops or truncates operational tables (the §behavior retention contract silently violated) — the parity row above only proves the *derived* projection, so without this row a wiped `jobs`/`source`/`model_calls` table passes CI and history is lost on the next rebuild. (Evidence is on the derived side — regenerated, not retained — so it is asserted regenerated here, not "survives unchanged".)
- **`status --json` merged-schema conformance** — run `status --json` against a fixture vault; assert the runtime payload validates against `status.schema.json` with the four folded sub-objects (`vault`, `db`, `index`, `sync`) present at the specified field names/types and `checks[]` carrying exactly the surviving probe set (`vault-reachable`, `git-healthy`, `provider-key-present`, `index-not-stale`). Cover the pending categories: a **new unindexed note** ⇒ `pendingNewCount:1` (with `pendingChangedCount:0`); a deleted file ⇒ `pendingDroppedCount:1`. Cover the exit contract: a failed probe (e.g. no provider key) ⇒ `ok:false` **at exit 0**; an unresolvable vault ⇒ exit 2. **Break scenario it catches:** the merge of `doctor` + `db status` + `index status` + `sync status` emits a payload that drifts from the schema at runtime (e.g. `status.sync` still carrying the retired `lastIndexedHead`, missing pending counts, or unhealth leaking into the exit code) — `contract-lint` checks the schema *file*, not the live output, so without this row the runtime divergence ships green.
- **`index eval`** — recall@10 ≥ 0.85 / MRR ≥ 0.70 (current 0.911 / 0.830).
- **One-commit-per-ChangePlan + full restoration** — an apply yields exactly one commit, touched-paths-only; **`git revert <sha>` + `brain sync`** restores the working tree, the SQLite projection, **and** the LanceDB index to the pre-ChangePlan state (asserted on all three — a git-only revert leaving the derived stores stale is the regression this row exists to catch).
- **`sync` runtime contract — all four states, schema-validated** — run `sync --json` for (1) unchanged, (2) changed, (3) **newly added file** (`newCount:1`, indexed + retrievable), (4) deleted file; validate **every** payload against `sync.schema.json` (all six fields present, retired `head` absent), assert exact counts + `scannedCount`, stdout is clean JSON with logs on stderr only, and the second identical run is `noop:true` with no index write.
- **Dropped-note cross-store purge** — index a note, delete its file, `sync`; assert the projection row is gone, its `chunk` metadata rows are gone, its LanceDB vectors are deleted, and **`query` can no longer return it**. Failpoint variant: interrupt **after** the SQLite transaction (row + chunk metadata deleted) but **before** the vector delete — assert `query` still cannot return the note (the projection join filters the residue), that a subsequent `sync` on the unchanged tree is **still `noop:true` with no index write** (residue never re-triggers sync), and that `index rebuild` sweeps the orphaned vectors.
- **Move/rename** — `git mv` a note (same id, same content), `sync`; assert the projection row's `path` updated in place, **`movedCount:1`** (with `changedCount:0` — a pure move is never "reindexed"), no re-embed (chunk rows untouched), links/evidence still resolve by note id.
- **Evidence v1→v2 cutover** — seed a database with the v1 evidence table shape; run `db migrate`; assert the exact eleven-column v2 schema, the v1 audit-coupling columns/tables gone, and (accepted) the v1 rows discarded.
- **Empty-vault zero-state** — on a fresh empty vault: `db rebuild` ⇒ empty projection, exit 0; `status` ⇒ well-formed payload, zero counts; `sync` ⇒ `noop:true`; `query` ⇒ empty result set, exit 0 (the §behavior zero-state contract, proved not asserted).

**Agentic workflow — end-to-end (the core this spec exists to test).**
- **`enrich` / `maintain` through a deterministic Gemini double** — drive the full retrieve → plan → validate → apply path against a fixture vault with a stubbed provider, asserting working-tree, projection, and HEAD state plus the `--json` / error envelope across: a **valid** grounded ChangePlan (working-tree edit, one touched-paths-only commit, projection + index refreshed, HEAD advanced); a **malformed** / non-parseable response (**exit 4**, no mutation, no commit); a **schema-invalid** ChangePlan (**exit 1** validation, no mutation, no commit); a **grounding-failed** plan naming a dirty/absent note (**exit 1**, no mutation, no commit); and a **provider error / timeout** (error envelope at exit 4, no commit). The valid and failure cases together prove mutation **never precedes** validation+grounding and **never** follows a provider failure.

**Demolition hygiene & cutover parity.**
- **Phase-2 cutover parity** — the direct in-process impls behind the existing seams pass the **same suite** the broker/egress clients did.
- **Zero-provisioning green** — full `pnpm -r test` passes with no `ATLAS_PROVISIONED`; the provisioned-only suites are **deleted, not skipped** (a skipped provisioned suite is a failure of this criterion).
- **No dangling references** — `pnpm -r build` clean; grep gates confirm no import of a killed package and no reference to a retired env var / socket path / canonical-ref.
- **Exit-code regression** — no command emits **3** or **6**; **7** appears only from the `jobs run` aggregate.

**Called-out gaps (honest, not silent).**
- The **deprovision script is not CI-tested** — it mutates real host OS state (users, groups, launchd, Keychain) and is destructive + human-run. Verification is a one-time manual pass on the live Mac, recorded in a retro.
- **Live provider calls** (`enrich` / `query` / `maintain` against real Gemini) are exercised in a manual live drive, not in the unit suite — the token-cap and the plan-gen path are unit-tested against a test double; the real API is verified live per the repo's "test live" rule.

## accessibility — Accessibility

**`n_a` — headless CLI, no user-facing GUI.** The only surfaces are the human-readable terminal render and the `--json` machine surface agents drive. The macOS Console GUI (and its VoiceOver / Full-Keyboard-Access checklist) is **nuked** in this spec; a new UI — with its own accessibility bar — is explicitly deferred until Atlas works properly, and will carry that bar when it is specced.

## open-questions — Open Questions

Genuinely-open items only. Every decision this spec introduces is now resolved above — recorded here so their absence from an open list reads as a decision, not a punt: the discretionary-command calls (`inspect`, `jobs retry|cancel` → killed), the `db rebuild` disposal boundary, the **`status` merged `--json` field set + exit contract** (specified in §interfaces), the **`link` removal / noop / alias-update semantics** (specified in §interfaces + §behavior, `action:"updated"`), the **final evidence-state schema + its destructive Phase-4 cutover** (the eleven-column table + migration owner in §interfaces), the **`source` registry table** (§interfaces), the **canonical mutation order** and the **vault-lock scope covering every derived-store writer** (§behavior), the **move/rename rule** (stable-id matching, §interfaces), the **cross-store dropped-note purge** (§behavior), the **direct Keychain key resolution — no launcher** (§interfaces + §ssot), the **retirement ADR number = `0003`** (§scope + §ssot), and the **macOS-only support posture** (§test-plan). No decision required to implement v2 remains open.

**Deferred (tracked, not V1):** an **Anthropic provider** (future work — Gemini ported as-is for v2); the **MCP server surface** (a future agent surface, out of scope here).
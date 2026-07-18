# Atlas Console SP-1 — `brain watch` Implementation Plan

## 1. Overview

This plan implements `brain watch`: a long-lived, read-only NDJSON event stream, plus a `--json` read-surface conformance sweep. The approach is **contracts-gate-first** (matching all six prior Atlas phases): land the registry row, fixture line, and `watch.schema.json` before any handler code, so the drift-proof harness gates every subsequent PR.

**Registry-flip timing:** `main.ts` dispatch checks only whether a **handler is registered** (`apps/cli/src/main.ts:198–213`) — it does **not** inspect `row.implemented`. So once Phase 3 registers the handler, the real child (`dist/bin.js`) can dispatch `watch` directly for every stream test, regardless of the registry flag. The `implemented:false → true` flip is therefore pure contract bookkeeping and stays deferred until the **end of Phase 5**, after the complete handler (domain events, replay, re-attach, termination, read-only proof) passes.

**Key architectural decisions (inherited from the spec, not invented):**
- **SSOT reuse over reimplementation (§7.6):** snapshot derivations are *extracted* from `status`; the jobs-list item projection is refactored **at its actual owner, `packages/jobs/src/repo.ts`** (not re-hand-rolled in the CLI). Never a second copy.
- **Broker probe resolved before the atomic SQLite capture.** `getAuditChainStatus` is an async RPC; `better-sqlite3` transactions are synchronous. So `watch` (and the extracted `status` path) resolves the broker probe to a plain value **outside** any transaction, then the DB snapshot derivation runs **synchronously** inside one brief read transaction (Phase 1 Task 1, Phase 3 Task 2). The ledger cross-check the spec requires is preserved — it runs synchronously against the already-resolved probe value.
- **Broker-failure taxonomy tracks the *actual* broker error contract.** Classification is derived from `packages/broker/src/protocol.ts`'s real behavior — `BrokerClient.getAuditChainStatus()` returns a valid `AuditChainStatus`, throws `BrokerRefusal("broker.bad_request")` on a malformed **correlated** result, or (for a malformed **uncorrelated** frame, which the client *ignores*) never resolves — plus a connect error for an unreachable socket. `watch` wraps the call in a bounded RPC timeout so an ignored-frame hang cannot stall the stream. Connect errors **and** timeouts degrade to `sqlite-only` (the outage is data); a `broker.bad_request` refusal is the protocol fault that goes fatal exit 4 (Phase 1 Task 1, Phase 5 Task 4).
- **Read-only ledger access goes through a `@atlas/sqlite-store` opener**, not a direct `better-sqlite3` import — `apps/cli` does not depend on `better-sqlite3` and must not (Phase 1 Task 4).
- **Immutable replay window captured inside the attach transaction.** The `--since-seq` replay set is the **exact ordered rows** read *inside* the atomic attach read-transaction — never re-queried against the live connection afterward. A row that commits into the range after attach cannot inflate the announced count or perturb the pending-hole behavior (Phase 3 Task 2, Phase 5 Task 1).
- **Poll-based cross-process detection via `PRAGMA data_version`** over one read-only, transaction-free connection (§9).
- **Incarnation-scoped dedup state** (§9.1) — every cursor/set resets on re-attach.
- **A single `runWatch` orchestrator owns both ledger states.** It drives the attached poll loop *and* the detached re-probe loop, consuming each loop's completion promise before deciding attach/re-attach/exit — so a startup-detached ledger is polled to life exactly like a mid-stream re-attach (Phase 3 Task 3, Phase 5 Task 2).
- **Resumable-space cursor is `run.%` only.** The executable ledger allocator (`packages/sqlite-store/src/ledger/intents.ts:267–270`) increments the **db-event** counter (base `DB_EVENT_SEQ_BASE = 10¹²`) for **every non-`run.%` event** — so `db.backup`, `db.restore`, `db.force_unblock`, **and `evidence.retry_enqueued`** all land in the 10¹²+ high space and are classified **ledger-internal** (`packages/contracts/src/audit.ts:43`). The resume cursor and `--since-seq` replay are defined over the **low/resumable space only**: `event_type LIKE 'run.%'`, equivalently `seq < DB_EVENT_SEQ_BASE`. The high space is live-only — a `run.%`-vs-not split, **not** a `db.%`-vs-not split.

**Phases (6):**
1. Shared-derivation extraction + typed anchor probe (broker-contract-grounded) + read-only ledger opener (refactor/additions, no behavior change).
2. Contracts gate (registry + schema + fixture + harness widening + enum/seq-space reconciliation + this spec).
3. Read-only poller core + `watch.hello`/`--once` + the `runWatch` orchestrator with attached + detached loops (handler registered; row stays `implemented:false`).
4. Domain event taxonomy + control events + ordering/coalescing (live stream only; no detach/re-attach yet).
5. Resume, replay (immutable captured window), re-attach (incl. the recoverable-ledger-fault path), incarnation reset, exit/signal handling + read-only proof, then **flip `implemented:true`**.
6. `--json` read-surface conformance sweep + in-chain nonconformance fixes.

Phases 1–2 overlap. Phase 6 depends on Phase 2 (registry/schema) + Phase 3 (registered handler + `--once`); it can be built alongside Phases 4–5.

## 2. Prerequisites

- **Exists already:** the CLI-contract harness (`tools/cli-contract.ts`, `docs/specs/cli-contract/commands.json`, `docs/specs/cli-contract/cli-surface.fixture.txt`, `tools/contract-lint.test.ts`, `tools/cli-schemas.test.ts`), `docs/specs/cli-contract/error-envelope.schema.json`, the draft-2020-12 validator used by `tools/cli-schemas.test.ts`, `withFixtureVault` + in-process `BrokerService` (`@atlas/testing`), the read-only `getAuditChainStatus` broker IPC, `apps/cli/src/errors/envelope.ts` (`emitJson`, line 192 — the **sole** file `apps/cli/test/no-render-bypass.test.ts` permits direct stdout writes from), `apps/cli/src/commands/pagination.ts`, and the ledger DDL (`packages/sqlite-store/migrations/0001_core.ts`).
- **Confirmed during planning (no longer open):**
  - `status` handler = `apps/cli/src/commands/status.ts`; daemon-probe / `assertReadAuditReady` = `apps/cli/src/audit/readonly.ts`; `verifyAuditAnchor` = `apps/cli/src/audit/anchor-check.ts:93` — it is `async`, takes `(db, anchorPath, env, broker: AuditChainProbe | null)`, awaits `broker.getAuditChainStatus()` **internally**, and its single `catch` degrades **every** RPC failure to `sqliteOnlyResult` (so it cannot today distinguish unreachable from malformed — Phase 1 Task 1 fixes this).
  - **The broker error contract** lives in `packages/broker/src/protocol.ts`: `BrokerClient` correlates each RPC to its response frame, throws `BrokerRefusal(code)` (code `"broker.bad_request"`) when a **correlated** result fails validation, and **silently ignores an uncorrelated/malformed frame** (no matching in-flight id). There is no `AuditChainStatus` Zod schema in `packages/contracts/src/audit.ts` — validation of the chain-status result is the broker client's job, so `watch` classifies on the **thrown `BrokerRefusal` code**, not a re-validation in the CLI.
  - The `jobs list` projection is **owned by `packages/jobs/src/repo.ts`**: `JobListRow` (`repo.ts:719`), `listJobs(...)` (`repo.ts:736`) returning `{ rows: JobListRow[]; total: number }`. `apps/cli/src/commands/jobs.ts` only serializes that projection to JSON — it holds neither the SQL nor the row shape. `updated_at`/`updatedAt` already exist on the neighboring enqueue-row projection (`repo.ts:78`, `repo.ts:270`); whether `JobListRow` itself carries `updatedAt` is settled in Phase 1 Task 2.
  - `SqliteDatabase` is the ledger DB type, exported from `@atlas/sqlite-store` (`packages/sqlite-store/src/connection.ts` → `src/index.ts:9`). `apps/cli/package.json` depends on `@atlas/sqlite-store` but **not** on `better-sqlite3`/`@types/better-sqlite3` (those are `@atlas/sqlite-store`'s deps); no read-only opener is exported yet (Phase 1 Task 4 adds one).
  - Package name for the retained harness is **`@atlas/cli-contract-tools`** (`tools/package.json`).
  - The router strips global `--json` before constructing `RunContext.argv` (`apps/cli/src/router.ts:57–130`); `--json`-ness is read from `ctx.output.mode`, never re-parsed from `ctx.argv`.
  - `main.ts` dispatch (`apps/cli/src/main.ts:198–213`) gates on handler registration only — **not** `row.implemented`.
  - The `audit_events` CHECK (`0001_core.ts:175–178`) enumerates **14** kinds: 10 `run.*` (`run.started, run.planned, run.integrated, run.refreshed, run.rejected, run.rolled_back, run.failed, run.cancelled, run.readonly, run.projection`), 3 `db.*` (`db.backup, db.restore, db.force_unblock`), and `evidence.retry_enqueued`.
  - `DB_EVENT_SEQ_BASE = 1_000_000_000_000` (`intents.ts:165`). The executable seq-space split: the **low/resumable** space is `event_type LIKE 'run.%'` (`seq < DB_EVENT_SEQ_BASE`); the **high/live-only** space is every **non-`run.%`** kind (`intents.ts:267–270` `nextDbEventSeq` increments for all of them) — the 3 `db.*` **plus `evidence.retry_enqueued`** — allocating from `DB_EVENT_SEQ_BASE`. `evidence.retry_enqueued` executes via `nextDbEventSeq` (`apps/cli/src/commands/evidence-retry.ts:80`) and is classified ledger-internal (`packages/contracts/src/audit.ts:43`).
  - `enrich` is a real registry command (`commands.json:62`) — §13.9's `brain enrich --apply` live-drive generator is valid.

## 2.5 Global Constraints

- **TypeScript strict / ESM / NodeNext**; `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`, `verbatimModuleSyntax`, `isolatedModules`; compile with `tsc`. Narrow types over `any`.
- **Node ≥ 24, pnpm ≥ 11.** Deps pinned once in `catalog:` of `pnpm-workspace.yaml`. **`apps/cli` gains no new dependency** — ledger access rides `@atlas/sqlite-store`'s exported opener.
- **Commits authored `Aryeh Stark <aryeh@21stark.com>`.** Branch + PR for everything; every review finding posted on the PR.
- **Exit-code set caps at 6.** `watch` uses the strict subset **`[0, 2, 4, 5]`** (§10.1).
- **Single error envelope** (`error-envelope.schema.json`); `watch` emits **at most one**, never interleaved with event lines (§6).
- **CLI-contract registry is SSOT.** `watch` row: `phase:6`, `idempotency:"none"`, `privilege:"shared"`, `schemaRef:"docs/specs/cli-contract/watch.schema.json"`, `executionClass:"read"` (schema `x-atlas-contract`) — **not** `"audited-read"`; `watch` emits **no `run.readonly`** (§5.1).
- **NDJSON envelope v1:** one JSON object per `\n`-terminated line (final line terminated), UTF-8, no BOM, no raw newlines. Every *event* line carries `v:1`, `event:"<type>"`, `at` (RFC-3339 ms UTC).
- **Global constants:** `DB_EVENT_SEQ_BASE = 1_000_000_000_000`; low-space (`run.%`) seqs start at **0**; `backup_watermark`/empty-ledger seed = **`-1`**.
- **Seq-space split:** low/resumable = `event_type LIKE 'run.%'` (`seq < DB_EVENT_SEQ_BASE`); high/live-only = every non-`run.%` kind (3 `db.*` + `evidence.retry_enqueued`, `seq ≥ DB_EVENT_SEQ_BASE`).
- **Broker-failure taxonomy (grounded in `protocol.ts`):** connect/socket error **or** RPC timeout ⇒ `unreachable` ⇒ degrade to `anchorSource:"sqlite-only"`; a thrown `BrokerRefusal("broker.bad_request")` ⇒ `protocol-error` ⇒ `watch` fatal exit 4, `status` degrades unchanged.
- **Allowlisted metadata only.** The **only** free-text fields: `job.lastError`, `watch.error.message` — both escaped over **C0 *and* C1** control ranges before serialization.
- **Read-only enforcement:** the ledger is opened via `@atlas/sqlite-store`'s read-only opener (`readonly:true`); no Atlas lock any scope; no git repo opened; no broker method beyond read-only `getAuditChainStatus`. Pinned by `x-atlas-contract.prohibitedEffects`.
- **Flag defaults/constraints:** `--json` required (validated from `ctx.output.mode`); `--since-seq` int ≥ −1; `--once` mutually exclusive with `--since-seq`; `--poll-ms` 100–10000 (default 500); `--heartbeat-seconds` 5–300 (default 30).

---

## 3. Phases

## Phase 1: Shared-derivation extraction + typed anchor probe + read-only opener (SSOT prep)
**Goal:** Extract snapshot derivations into a **synchronous** shared function fed by a **pre-resolved, typed** broker probe classified against the real broker error contract; refactor the jobs-list projection at its owning package; and expose a read-only ledger opener from `@atlas/sqlite-store`. No behavior change to `status`/`jobs list`/`doctor`.
**Dependencies:** none
**Estimated effort:** M

### Tasks
1. **Split the broker probe (broker-contract-grounded) from a synchronous snapshot derivation**
   - What: two coordinated changes in `apps/cli/src/audit/anchor-check.ts` + a new `apps/cli/src/health/snapshot.ts`.
     - **(a) Typed, async probe resolver, split from the synchronous verdict.** In `anchor-check.ts`, factor the RPC out of `verifyAuditAnchor`. Add `resolveAnchorProbe(broker: AuditChainProbe | null, env: NodeJS.ProcessEnv): Promise<AnchorProbe>` (async, the **only** async part) and `deriveAnchorVerdict(db: SqliteDatabase, anchorPath: string, env: NodeJS.ProcessEnv, probe: AnchorProbe): AnchorCheckResult` (**synchronous** — it runs the existing SQLite cross-check `live.count`/`live.head` vs the probe's `count`/`head` against `db` inside the caller's transaction). `resolveAnchorProbe` classifies using the **actual broker contract** in `packages/broker/src/protocol.ts`, wrapping the RPC in a bounded timeout so an *ignored malformed frame* (which never correlates a response) cannot hang the stream:
       - `broker === null`, or the call throws a connect/socket error (`ECONNREFUSED`/`ENOENT`/`EPIPE`), or the RPC timeout (`ATLAS_WATCH_PROBE_TIMEOUT_MS`, default 2000 ms) elapses before a correlated response ⇒ `{kind:"unreachable"}` (a hung or unreachable broker is an outage → degrade).
       - the call throws `BrokerRefusal` with code `"broker.bad_request"` (the broker correlated a response and rejected it as malformed) ⇒ `{kind:"protocol-error", detail: code}`.
       - a correlated, well-formed `AuditChainStatus` result ⇒ `{kind:"answered", status}`.

       (No re-validation against a nonexistent `packages/contracts/src/audit.ts` schema — the broker client already owns result validation; `watch` reads its *outcome*.) **`verifyAuditAnchor` is kept as a thin behavior-preserving wrapper:** `verifyAuditAnchor(db, anchorPath, env, broker) = deriveAnchorVerdict(db, anchorPath, env, await resolveAnchorProbe(broker, env))`, and `deriveAnchorVerdict` maps **both** `unreachable` and `protocol-error` to the existing `sqliteOnlyResult` — so `status`'s degraded behavior is byte-identical. Only `watch` (Phase 5 Task 4) inspects `kind === "protocol-error"` to go fatal.
     - **(b) Synchronous snapshot derivation.** Pull `openRuns`, `backup`, `audit`, `jobs`, `quarantineCount` derivation out of `status.ts` into `deriveSnapshot(ctx: SnapshotContext): SnapshotShape` — **synchronous**, no `await`, safe to call inside a `better-sqlite3` read transaction. It calls `deriveAnchorVerdict` (sync) with `ctx.probe` (already resolved by the caller). Leave the audited-read `run.readonly` append in the `status` handler — `watch` must not inherit it (§5.1). `status.ts` now: `const probe = await resolveAnchorProbe(broker, env); const snap = db.transaction(() => deriveSnapshot({conn: db, anchorPath, env, probe}))();` — same output, RPC out of the transaction.
   - Files: `apps/cli/src/audit/anchor-check.ts`, `apps/cli/src/commands/status.ts`, new `apps/cli/src/health/snapshot.ts`.
   - Interfaces — **Produces:**
     ```ts
     type AnchorProbe =
       | { kind: "unreachable" }
       | { kind: "answered"; status: AuditChainStatus }
       | { kind: "protocol-error"; detail: string };   // detail = the BrokerRefusal code
     function resolveAnchorProbe(broker: AuditChainProbe | null, env: NodeJS.ProcessEnv): Promise<AnchorProbe>;
     function deriveAnchorVerdict(db: SqliteDatabase, anchorPath: string, env: NodeJS.ProcessEnv, probe: AnchorProbe): AnchorCheckResult;

     interface SnapshotContext {
       conn: SqliteDatabase;                       // from @atlas/sqlite-store; opened read-only for watch
       anchorPath: string;
       env: NodeJS.ProcessEnv;
       probe: AnchorProbe;                          // resolved BEFORE the transaction
     }
     interface SnapshotShape {
       openRuns: Record<string, number>;
       jobs: { queued: number; failed: number };
       quarantineCount: number;
       backup: { watermarkSeq: number; coveredSeq: number; healthy: boolean };
       audit: { headSeq: number; head: string; anchorOk: boolean; anchorSource: "git" | "sqlite-only" };
     }
     function deriveSnapshot(ctx: SnapshotContext): SnapshotShape;   // synchronous
     ```
     **Consumes:** the existing backup/watermark readers and `liveAudit(db)` cross-check inside `deriveAnchorVerdict`; the `AuditChainProbe`/`AuditChainStatus` types and the `BrokerRefusal` class + `"broker.bad_request"` code from `packages/broker/src/protocol.ts`.
   - Test (create + modify): `apps/cli/test/read-commands.cli.test.ts` stays green; add a golden assertion that `status --json` is byte-identical to a pre-refactor capture for the fixture vault. New `apps/cli/test/anchor-probe.test.ts` — with a broker stub that (i) refuses connection ⇒ `unreachable`; (ii) throws `BrokerRefusal("broker.bad_request")` ⇒ `protocol-error`; (iii) never responds (ignored-frame simulation) ⇒ `unreachable` via the timeout; (iv) returns a valid status ⇒ `answered`; and `deriveAnchorVerdict` maps both `unreachable` and `protocol-error` to `sqlite-only` (the `status`-preserving assertion).
2. **Refactor the jobs-list item projection at its owner (`@atlas/jobs`)**
   - What: `apps/cli/src/commands/jobs.ts` does not own the projection — `packages/jobs/src/repo.ts` does. Ensure `JobListRow` carries `updatedAt` (add the field + select `updated_at` in `listJobs` if absent) and export a **shared row projector** `projectJobListRow(row): JobListRow` so both `listJobs` and `watch` produce the identical shape. `jobs.ts` continues to serialize `listJobs`' (paginated `{limit, offset}`) rows to JSON (unchanged output). `watch`'s `job` event is `JobListRow` field-for-field (it already includes `updatedAt`; the §7.3 payload = `jobId, workflow, state, attempts, maxAttempts, nextRunAt?, lastError?, updatedAt`).
     - **Unpaginated full-table reader for `watch`.** `listJobs` is paginated (`{limit, offset}`, CLI-capped at 500/page) — `watch`'s full-table diff (§9.1, §4 scale of 10²–10³ jobs) must see **every** job in one **transactionally consistent** read, not a page. Export a second owner-side reader `listAllJobs(db: SqliteDatabase): JobListRow[]` from `@atlas/jobs` that wraps the same SQL in a single `db.transaction(() => …)` with **no limit/offset**, returning every row via `projectJobListRow` (so it is byte-identical to `listJobs`' projection, one owner for the shape). `watch` consumes `listAllJobs`; `jobs list --json` keeps `listJobs`. This closes the "jobs beyond the selected page are never observed" gap without a pagination loop in the poller.
   - Files: `packages/jobs/src/repo.ts`, `packages/jobs/src/index.ts` (export `projectJobListRow`, `listAllJobs`, `JobListRow`), `apps/cli/src/commands/jobs.ts` (no shape change; confirm it consumes `listJobs`).
   - Interfaces — **Produces (from `@atlas/jobs`):** `interface JobListRow { jobId: string; workflow: string; state: string; attempts: number; maxAttempts: number; nextRunAt?: string; lastError?: string; updatedAt: string }`; `function listJobs(db: SqliteDatabase, opts): { rows: JobListRow[]; total: number }`; `function listAllJobs(db: SqliteDatabase): JobListRow[]` (unpaginated, single-transaction — the reader `watch` uses); `function projectJobListRow(row: JobsRawRow): JobListRow`. **Consumes:** the `jobs`/`job_attempts` SQL already in `repo.ts`.
   - Test (create + keep): new `packages/jobs/test/repo.projection.test.ts` — `listJobs` rows include `updatedAt` and equal `projectJobListRow` applied to the raw rows; **`listAllJobs` on a seeded set of 600 jobs (past the 500 page cap) returns all 600**, each equal to `projectJobListRow` of the raw row, in one consistent read; `apps/cli/test/jobs.cli.test.ts` unchanged and green (proves the serialized `jobs list --json` output is byte-stable).
   - Verification: `pnpm --filter @atlas/jobs test && pnpm --filter @atlas/cli test -- jobs.cli.test.ts`.
3. **Extract the daemon connect/close probe — with a typed unreachable-vs-fault outcome**
   - What: expose the reachability probe from `apps/cli/src/audit/readonly.ts` as a reusable function; `doctor`/`assertReadAuditReady` consume it (mapping the typed result back to their existing boolean view, so their behavior is unchanged). The probe **distinguishes ordinary socket unreachability from an unexpected probe fault** — the spec requires the former to surface as a `daemon` event (`reachable:false`, §7.3) and the latter as a non-fatal `watch.error` (`source:"broker"|"egress"`, §7.1/§5.2), so a single `boolean` cannot carry both. Classification: a clean connect (then close) ⇒ `reachable`; a connect error in the expected socket-down set (`ECONNREFUSED`/`ENOENT`/`EACCES`/`ETIMEDOUT`) ⇒ `unreachable` (ordinary — drives the `daemon` event); any **other** thrown error (unexpected: e.g. a malformed socket path type error, an unanticipated syscall failure) ⇒ `fault` carrying the code/message (drives `watch.error`). The `daemon` name is attached by the caller (broker vs egress).
   - Files: `apps/cli/src/audit/readonly.ts` (add export), new `apps/cli/src/health/probe.ts`.
   - Interfaces — **Produces:**
     ```ts
     type DaemonProbe =
       | { socketPath: string; status: "reachable" }
       | { socketPath: string; status: "unreachable"; code: string }        // ordinary → daemon event reachable:false
       | { socketPath: string; status: "fault"; code: string; message: string }; // unexpected → watch.error
     function probeDaemon(socketPath: string): Promise<DaemonProbe>;         // connect/close only, no bytes
     function isReachable(p: DaemonProbe): boolean;                          // = p.status === "reachable" (doctor/snapshot view)
     ```
     The `daemons` snapshot object and the `daemon` transition event both read `isReachable`; only Phase 4 Task 3's heartbeat probe branch maps `status === "fault"` to `buildWatchError(source, code, message)`.
   - Test (create + modify): `apps/cli/test/doctor.quarantine.test.ts` green unchanged (via `isReachable`); new `apps/cli/test/daemon-probe.test.ts` — a live socket ⇒ `reachable`; a missing socket path ⇒ `unreachable` (`ENOENT`); a probe against a path that triggers a non-socket-down error ⇒ `fault` with its code/message (the seam Phase 4 Task 3 maps to `watch.error`).
4. **Read-only ledger opener in `@atlas/sqlite-store`**
   - What: add `openReadonlyLedger(path: string): SqliteDatabase` to `packages/sqlite-store/src/connection.ts` (better-sqlite3 `readonly: true`, no migration/checkpoint/write) and export it from `src/index.ts`. `apps/cli` consumes this opener + the already-exported `SqliteDatabase` type — it never imports `better-sqlite3` directly (which is not in its dependency graph). This is the interface Phase 3's attach and every `SqliteDatabase`-typed `watch` module use.
   - Files: `packages/sqlite-store/src/connection.ts`, `packages/sqlite-store/src/index.ts`.
   - Interfaces — **Produces (from `@atlas/sqlite-store`):** `function openReadonlyLedger(path: string): SqliteDatabase`; re-export of the `SqliteDatabase` type.
   - Test (create): `packages/sqlite-store/test/readonly-open.test.ts` — the opener returns a usable read connection on a seeded ledger; a write attempt through it throws `SQLITE_READONLY`; opening a missing path throws a distinguishable error (so `watch`'s attach can map absence → `ledger.attached:false`).

### Risks
- Hidden coupling between `status`'s derivation and its `run.readonly` append — **mitigation:** extract *only* the pure synchronous derivation; leave the append in `status.ts`; the golden test proves parity.
- Splitting the anchor probe subtly changes `status`'s degraded verdict — **mitigation:** `verifyAuditAnchor` stays a wrapper mapping both failure kinds to `sqliteOnlyResult`; `anchor-probe.test.ts` pins it.
- The probe timeout misfires on a slow-but-healthy broker — **mitigation:** the 2 s default sits well above the local IPC round-trip; a timeout degrades (never fatal), so a false positive costs only a `sqlite-only` snapshot, not a killed stream.

### Verification
- `pnpm --filter @atlas/jobs test && pnpm --filter @atlas/sqlite-store test -- readonly-open.test.ts && pnpm --filter @atlas/cli test -- read-commands.cli.test.ts jobs.cli.test.ts doctor.quarantine.test.ts anchor-probe.test.ts` green; `status --json` / `jobs list --json` / `doctor --json` outputs byte-identical to pre-refactor goldens.

---

## Phase 2: Contracts gate
**Goal:** Land `watch`'s contract (registry row, fixture line, schema, harness widening), reconcile the `eventType` enum and seq-space classification against the executable ledger code, and land this spec — all with `implemented:false`.
**Dependencies:** none (parallel with Phase 1)
**Estimated effort:** M

### Tasks
1. **Registry row + fixture line + harness widening**
   - What: insert the §5 row into `docs/specs/cli-contract/commands.json` (name-sorted, after `validate`), `implemented:false`; add fixture heading `# Console enablement (Phase 6)` + the line `` `watch` — long-lived NDJSON stream of jobs, model calls, ledger appends, backup watermark, daemon health. `` to `docs/specs/cli-contract/cli-surface.fixture.txt`; widen `tools/cli-contract.ts` `PHASES` from `[0..5]` to `[0..6]` (same PR); run `pnpm contract:write` to regenerate `docs/specs/cli-contract/commands-overview.md`.
   - Files: `commands.json`, `cli-surface.fixture.txt`, `tools/cli-contract.ts`, generated `commands-overview.md`.
   - Interfaces — **Produces:** registry membership of `watch` (row `{name, schemaRef, phase:6, idempotency:"none", privilege:"shared", implemented:false}`).
   - Test: `tools/contract-lint.test.ts` (`validateRegistry`, `checkFixtureConsistency`) green with the phase-6 row.
2. **`eventType` enum + seq-space reconciliation against the executable ledger**
   - What: derive the `audit` event `eventType` enum from the CHECK in `0001_core.ts:175–178` — the **14** kinds. Confirm §7.3/§8.1 prose uses the **executable** seq-space rule: the resumable low space is `event_type LIKE 'run.%'` (`seq < DB_EVENT_SEQ_BASE`, the 10 `run.*` kinds); the live-only high space is every **non-`run.%`** kind — the 3 `db.*` **and `evidence.retry_enqueued`** — allocated from `DB_EVENT_SEQ_BASE` by `nextDbEventSeq` (`intents.ts:267–270`), so `seq ≥ DB_EVENT_SEQ_BASE`. Any `NOT LIKE 'db.%'` / `LIKE 'db.%'` phrasing is replaced with `LIKE 'run.%'` / `NOT LIKE 'run.%'` (equivalently the `seq < DB_EVENT_SEQ_BASE` threshold). `watch.schema.json`'s enum is a replica; the DDL CHECK is SSOT for kinds, `intents.ts` for the space split.
   - Files: `docs/specs/cli-contract/watch.schema.json` (enum), this spec (§7.3/§8.1 text + the space-predicate phrasing).
   - Interfaces — **Consumes:** the CHECK literal in `0001_core.ts` and the `nextDbEventSeq` predicate in `intents.ts` as owners.
3. **Author `watch.schema.json`**
   - What: the §6/§7 line-union — a discriminated union over `event` across the 8 types (`watch.hello`, `watch.heartbeat`, `watch.error`, `job`, `model_call`, `audit`, `backup`, `daemon`), each carrying `v:1`, `event`, `at` + its payload; the `audit` member's `eventType` uses the 14-value enum. `x-atlas-contract`: `phase:6`, `privilege:"shared"`, `idempotency:"none"`, `executionClass:"read"`, `exitCodes:[0,2,4,5]`, `prohibitedEffects` (no-lock/no-git/no-mutation/no-network per §5.2). One `examples` instance per event type. Description pins: consumers **must ignore unknown `event` values** (§15).
   - Files: new `docs/specs/cli-contract/watch.schema.json`.
   - Interfaces — **Produces:** `watch.schema.json` with `command:"watch"` binding.
   - Test: `tools/cli-schemas.test.ts` validates all examples; `tools/contract-lint.test.ts` (`checkImplementedSchemas` sees the schema for the still-unimplemented row without error; schema `command`/phase/privilege/idempotency bind to the row).
4. **Drift assertion: schema enum ↔ DDL CHECK, and space predicate ↔ `intents.ts`**
   - What: a test pinning `watch.schema.json`'s `audit.eventType` enum **derived at runtime** from the `audit_events` CHECK (parsed from the migration source, not hardcoded) so a new DDL kind fails CI until the schema enum matches; and asserting the low/high classification predicate resolves to `run.%` / non-`run.%` with the `DB_EVENT_SEQ_BASE` threshold consistent with `intents.ts`.
   - Files: new `tools/watch-eventtype-drift.test.ts`.
   - Interfaces — **Consumes:** the CHECK in `0001_core.ts`, `DB_EVENT_SEQ_BASE` and the `nextDbEventSeq` predicate from `intents.ts`.
   - Test: fails on a deliberate DDL-only addition; green when both sides match.

### Risks
- Harness widening lands speculatively without a phase-6 row — **mitigation:** spec mandates same-PR pairing; enforced in review.

### Verification
- `pnpm --filter @atlas/cli-contract-tools test` (runs `contract-lint.test.ts`, `cli-schemas.test.ts`, `watch-eventtype-drift.test.ts`) green; `node tools/gen-cli-contract.ts --check` passes; `pnpm contract:check` clean.

---

## Phase 3: Read-only poller core + `watch.hello` + `--once` + orchestrator
**Goal:** A registered, dispatchable `watch` handler that opens the ledger read-only (via the `@atlas/sqlite-store` opener), emits a `watch.hello` snapshot (Phase 1 synchronous derivation), supports `--once`, runs the `PRAGMA data_version` poll loop (no domain events yet), and drives both ledger states through a single `runWatch` orchestrator with a **detached re-probe loop** and an **attached poll loop that reports its completion** back to the orchestrator. The handler is registered — so the real child dispatches it directly for tests — but the registry row **stays `implemented:false`** (the flip waits for Phase 5).
**Dependencies:** Phase 1, Phase 2
**Estimated effort:** L

### Tasks
1. **Handler skeleton + flag parsing + registration**
   - What: create `apps/cli/src/commands/watch.ts` with `registerCommand("watch", handler)` and add the barrel import to `apps/cli/src/handlers.ts`. **`--json`-ness is validated from `ctx.output.mode`, not parsed from argv** (`router.ts:57–130`): reject with usage error (exit 5) unless `ctx.output.mode === "json"`. The watch-specific flags (`--since-seq`, `--once`, `--poll-ms`, `--heartbeat-seconds`) are parsed from `ctx.argv`: ranges, `--once`⊥`--since-seq`, integer/boundary checks → exit 5 with one conforming error envelope. Use `apps/cli/src/commands/pagination.ts`-style parsers — **no bare `Number()`**.
   - Files: `apps/cli/src/commands/watch.ts`, `apps/cli/src/handlers.ts`.
   - Interfaces — **Produces:** `registerCommand("watch", handler)`; `parseWatchFlags(argv: string[], outputMode: string): WatchOpts` where `WatchOpts = { sinceSeq?: number; once: boolean; pollMs: number; heartbeatSeconds: number }` and the function throws a usage error unless `outputMode === "json"`. **Consumes:** `ctx.output.mode`, `ctx.argv`, `emitJson` and the error-envelope emitter from `apps/cli/src/errors/envelope.ts`.
   - Test (create): `apps/cli/test/watch.flags.cli.test.ts` — the §6a table subset (boundaries + invalid neighbors + missing-`--json` via non-json output mode + `--once --since-seq` → exit 5, exactly one envelope, no event line).
2. **Atomic attach: resolve probe, then synchronous consistent capture — capturing the immutable replay window inside the transaction**
   - What: open the ledger with `openReadonlyLedger(path)` (Phase 1 Task 4). If absent/unmigrated (opener throws the distinguishable missing-path/no-schema error) → a `DetachedLedger` (no connection, no cursor; `resume`/`replay` absent). Config missing/invalid → `config-invalid`, exit 2. When present: **first resolve the broker probe asynchronously** — `const probe = await resolveAnchorProbe(broker, env)` (Phase 1 Task 1); if `probe.kind === "protocol-error"` this is fatal (Phase 5 Task 4 maps it to exit 4) — **then**, from **one brief synchronous read transaction on the connection that becomes the steady-state poller** (never a throwaway), capture a single consistent point: `deriveSnapshot({conn, anchorPath, env, probe})` (synchronous, no await inside the transaction), the four source baselines, the ledger identity, the initial `data_version`, **and — if `--since-seq` — the exact ordered replay rows read *inside this same transaction***. The replay window is therefore an **immutable snapshot of rows**, not a stored `(sinceSeq, upperSeq)` bound re-queried later: `ReplayWindow = { sinceSeq, rows }` where `rows` are the low-space (`run.%`) audit rows with `sinceSeq < seq`, in strict `seq` order, materialized now; `events = rows.length`. A row that commits into the range *after* the transaction closes cannot appear in `rows`, cannot inflate the announced `events` count, and is delivered later by the live diff (preserving the §7.4 pending-hole behavior). Then close only the transaction, keep the connection. Daemon reachability for the snapshot's `daemons` object is probed via `probeDaemon` **before** the transaction alongside the broker probe; the attach composes `WatchSnapshot = { ...deriveSnapshot(...), daemons }` and records the initial reachability into `baselines.daemonReachable` (via `isReachable`) so the first `daemon` transition event (Phase 4) compares against captured state with no re-probe and no hidden state. `emitHello` (declared below) is the sole reader of this composed snapshot + cursor.
   - Files: `apps/cli/src/commands/watch.ts`, new `apps/cli/src/watch/attach.ts`.
   - Interfaces — **Produces:**
     ```ts
     interface AuditEventRow { seq: number; runId: string | null; eventType: string; gitHead: string | null; createdAt: string }
     interface LedgerIdentity { device: number; inode: number; schemaHead: string }
     interface ReplayWindow { sinceSeq: number; rows: AuditEventRow[] }  // rows captured INSIDE the attach txn; events = rows.length
     interface SourceBaselines {
       auditContiguousPrefix: number;        // low-space (run.%) contiguous committed prefix, −1 if none
       auditSparseEmitted: Set<number>;      // low-space seqs already emitted above the prefix
       highSpaceEmitted: Set<number>;        // non-run.% (db.* + evidence.retry_enqueued) emitted seqs, incarnation-scoped
       modelCallEmitted: Set<string>;        // emitted call_id, incarnation-scoped
       jobsMap: Map<string, { state: string; attempts: number; nextRunAt: string | null; updatedAt: string }>;
       backupRow: { watermarkSeq: number; healthy: boolean; lastBackupAt: string | null; updatedAt: string } | null;
       daemonReachable: { broker: boolean; egress: boolean };   // initial reachability, captured at attach — the baseline the first daemon transition compares against (no re-probe, no hidden state)
     }
     interface DaemonSnapshot {                                 // the §7.2 daemons object
       broker: { socketPath: string; reachable: boolean };
       egress: { socketPath: string; reachable: boolean };
     }
     type WatchSnapshot = SnapshotShape & { daemons: DaemonSnapshot };   // hello snapshot = status shape + daemon probes (§7.2)
     interface AttachedLedger {
       attached: true;
       connection: SqliteDatabase;           // from openReadonlyLedger
       identity: LedgerIdentity;
       snapshot: WatchSnapshot;              // status shape + daemons (§7.2) — carries the daemon probes, not just SnapshotShape
       baselines: SourceBaselines;           // includes daemonReachable, the transition baseline
       dataVersion: number;
       replay?: ReplayWindow;                // present iff --since-seq; immutable captured rows
       resumeCursor: number;                 // hello auditHeadSeq: min(sinceSeq, prefix) during replay, else prefix; −1 if none
     }
     interface DetachedLedger {
       attached: false;
       snapshot: { daemons: DaemonSnapshot };   // detached hello carries daemons only (§7.2)
     }
     // Hello emitter — the sole constructor of a watch.hello line from an Attachment. Declared here (referenced by the Phase 3 Task 4 orchestrator) so hello is built from captured state, never a re-probe:
     function emitHello(att: Attachment, emit: (line: unknown) => Promise<void>): Promise<void>;
     // Attached: {v:1, event:"watch.hello", at, pid, ledger:{attached:true,path}, snapshot (WatchSnapshot), resume:{auditHeadSeq: att.resumeCursor}, replay?:{sinceSeq, events: att.replay.rows.length}, config}.
     // Detached: {…, ledger:{attached:false,path}, snapshot:{daemons}} with resume/replay ABSENT (§7.1).
     type Attachment = AttachedLedger | DetachedLedger;
     interface AttachContext { anchorPath: string; env: NodeJS.ProcessEnv; broker: AuditChainProbe | null; brokerSocket: string; egressSocket: string }
     function attachLedger(path: string, opts: WatchOpts, ctx: AttachContext): Promise<Attachment>;
     ```
     Low-space predicate = `event_type LIKE 'run.%'` (`seq < DB_EVENT_SEQ_BASE`) throughout; high-space = the complement. **Consumes:** `openReadonlyLedger`, `resolveAnchorProbe`, `deriveSnapshot` (synchronous), `probeDaemon`. The seed rule (§9.1): scan the existing low-space (`run.%`) `seq` set to seed `auditContiguousPrefix` + baseline-seen marks; scan the high-space seqs to seed `highSpaceEmitted`; the pre-attach backlog is not replayed but a later gap-fill still emits.
   - Test (create): `apps/cli/test/watch.hello.cli.test.ts` (real child `dist/bin.js`) — `--once` emits exactly one `watch.hello` conforming to `watch.schema.json`, exit 0; snapshot equals `status --json`'s summary on shared keys (run `watch --once` **before** `status`; exclude `audit.headSeq`/`audit.head` — §13.2); ledger-absent hello reports `attached:false` with `resume`/`replay` absent. **Immutable-window unit test** (in-process): open an attach with `--since-seq k`, then commit a new low-space row into the `> k` range from a second connection *after* attach returns; assert `attachment.replay.rows` still has the pre-commit count and does not contain the late row (it will surface via the live diff instead).
3. **Poll loop reporting completion + inode/schema guard (async, serialized ticks)**
   - What: every `pollMs`, read `PRAGMA data_version` on the transaction-free poller connection (never hold an open txn across ticks — it pins the value). On change (or an `attached` transition) invoke `onTick` — an **async** callback that is **serialized** (a tick never starts until the prior tick's promise resolves), so emission can await pipe backpressure (Phase 4) without overlapping or reordering. Each tick also `stat()`s the ledger path and compares `(device, inode)` + schema head vs `AttachedLedger.identity`; mismatch/vanished → the loop resolves its completion promise with `"reattach"` (the detach/re-attach *action* is Phase 5 Task 2; Phase 3 only detects and surfaces it). A `stop()` call (signal handler) resolves the promise with `"stopped"`. `fs.watch` on `-wal` is an **optional** wake hint — **ship poll-only in v1**.
   - **The loop returns a completion channel** so the `runWatch` orchestrator (Task 4) can await the outcome and decide re-attach vs exit — closing the finding that a bare `{ stop() }` handle stranded the `"reattach"` result:
     ```ts
     interface PollHandle { stop(): void; done: Promise<"stopped" | "reattach"> }
     function runPollLoop(att: AttachedLedger, opts: WatchOpts, onTick: (att: AttachedLedger) => Promise<"continue" | "reattach">): PollHandle;
     ```
     `done` resolves `"reattach"` when a tick (or `onTick`) reports the inode/schema change, `"stopped"` when `stop()` is called; the loop stops ticking once resolved. **Consumes:** `attachLedger`.
   - Files: new `apps/cli/src/watch/poll-loop.ts`.
   - Test (add to) `apps/cli/test/watch.hello.cli.test.ts`: **in-process callback test** — a change committed by the test process fires `onTick` within 2×`pollMs`; two rapid commits produce non-overlapping serialized invocations; an inode swap resolves `done` with `"reattach"`; a `stop()` resolves `done` with `"stopped"`.
4. **`runWatch` orchestrator: attached + detached loops, consuming each loop's completion**
   - What: a single top-level orchestrator that owns the whole lifecycle across both ledger states and is the sole caller of `runPollLoop`, `runDetachedLoop`, `reattach` (Phase 5), and the emitters. It resolves the finding that nothing polled an initial `DetachedLedger`: an **explicit detached re-probe loop** re-runs `attachLedger` every `pollMs` until the ledger appears, emitting detached heartbeats at the heartbeat cadence meanwhile, then hands a freshly-`AttachedLedger` back so the orchestrator emits a fresh `watch.hello` (and, if `--since-seq` was pending, runs the deferred replay against that first attached ledger — Phase 5 Task 1). Control flow (Phase 3 wires attached↔detached transitions and exit; the re-attach *action* body and replay land in Phase 5):
     ```ts
     interface DetachedHandle { stop(): void; done: Promise<"stopped" | { attached: AttachedLedger }> }
     function runDetachedLoop(path: string, opts: WatchOpts, ctx: AttachContext, emitHeartbeat: () => Promise<void>): DetachedHandle;

     async function runWatch(path, opts, ctx, emit): Promise<number> {   // returns the process exit code
       let att = await attachLedger(path, opts, ctx);
       await emitHello(att, emit);                                        // detached hello carries daemons only
       for (;;) {
         if (att.attached) {
           if (att.replay) { await runReplay(att.replay, emit); await emitPostReplayHeartbeat(att, emit); }  // Phase 5
           const h = runPollLoop(att, opts, onTick);
           const outcome = await h.done;                                 // <-- consumes the completion channel
           if (outcome === "stopped") return 0;
           await emitWatchError("ledger", ..., emit);                    // Phase 5 Task 2
           att = await reattach(path, opts, ctx);                        // Phase 5 Task 2 (fresh incarnation)
           await emitHello(att, emit);
         } else {
           const d = runDetachedLoop(path, opts, ctx, () => emitDetachedHeartbeat(emit));
           const outcome = await d.done;                                 // <-- consumes the detached completion channel
           if (outcome === "stopped") return 0;
           att = outcome.attached;                                       // freshly attached
           await emitHello(att, emit);                                   // first real resume/replay cursor here
         }
       }
     }
     ```
     `stop()` on whichever loop is active is invoked by the signal handlers (Phase 5 Task 4); a `--once` invocation short-circuits before the `for` loop (emit hello, return 0).
   - Files: `apps/cli/src/commands/watch.ts` (orchestrator + wiring), new `apps/cli/src/watch/detached-loop.ts`.
   - Interfaces — **Produces:** `runWatch(...)`, `runDetachedLoop(...): DetachedHandle`. **Consumes:** `attachLedger`, `runPollLoop`, `probeDaemon`, the emitters.
   - Test (create): `apps/cli/test/watch.detached.cli.test.ts` (real child) — **startup-detached transition:** start `watch` against a **missing** ledger path; assert the first line is a `watch.hello` with `ledger.attached:false` (no `resume`/`replay`) and that a detached `watch.heartbeat` (no cursor) arrives at the heartbeat cadence; then create+migrate the ledger under the running watcher and assert a **fresh `watch.hello`** with `attached:true` and a real `resume` cursor arrives within ~`pollMs`, followed by live streaming. This is the executable absent-ledger → later-attach → fresh-hello flow the detached loop now provides.

### Risks
- Poller holding a read txn pins `data_version` → misses commits. **Mitigation:** explicit "close txn, keep connection" contract + the detection test.
- The orchestrator dropping a completion outcome (re-attach lost, or exit-on-stop missed). **Mitigation:** both loops expose a single `done` promise the orchestrator `await`s; the detached-transition test and the Phase 5 re-attach test exercise both branches end-to-end.
- Reusing the audited `status` path drags in `run.readonly`. **Mitigation:** Phase 1 extracted only pure derivation; Phase 5 Task 5 asserts no mutation.

### Verification
- `pnpm --filter @atlas/cli build` then `pnpm --filter @atlas/cli test -- watch.flags.cli.test.ts watch.hello.cli.test.ts watch.detached.cli.test.ts` green; the registry row is still `implemented:false` and `node tools/gen-cli-contract.ts --check` passes (schema exists, row unimplemented — a legal state).

---

## Phase 4: Domain event taxonomy + control events + ordering
**Goal:** The five domain events + `watch.heartbeat`/`watch.error`, with per-source diffing, coalescing, and §7.4 ordering — the live stream complete for a **single, stable ledger incarnation**. Detach/re-attach (and the recoverable-ledger-fault path) are Phase 5. Runs against the real child.
**Dependencies:** Phase 3
**Estimated effort:** L

### Tasks
1. **Per-source diff cursors**
   - What: on each pending-diff tick, diff the four sources per §9.1:
     - **low-space audit** (`event_type LIKE 'run.%'`, `seq < DB_EVENT_SEQ_BASE`): read `seq > auditContiguousPrefix` minus `auditSparseEmitted` → emit late-committing lower seqs on the tick they commit, never twice; advance the contiguous prefix + sparse set.
     - **high-space audit** (non-`run.%`: `db.*` + `evidence.retry_enqueued`, `seq ≥ DB_EVENT_SEQ_BASE`): diff against `highSpaceEmitted` (live-only, incarnation-scoped).
     - `model_calls`: diff by `call_id` against `modelCallEmitted` (full-scan, §4 scale — no `created_at` window).
     - `jobs`: full-table diff via **`listAllJobs`** (Phase 1 Task 2, `@atlas/jobs` — the unpaginated single-transaction reader, **not** the 500-capped `listJobs`) vs `jobsMap` — the SSOT reader, never a hand-rolled query, so every job at the §4 scale is observed regardless of count.
     - `backup_watermark`: single-row compare vs `backupRow`.
   - Files: new `apps/cli/src/watch/diff.ts`, new `apps/cli/src/watch/incarnation.ts` (owns `SourceBaselines` mutation).
   - Interfaces — **Produces:** `diffSources(conn: SqliteDatabase, state: SourceBaselines): WatchEvent[]`. **Consumes:** `DB_EVENT_SEQ_BASE`, the `run.%` predicate, `listAllJobs`/`projectJobListRow` from `@atlas/jobs`.
   - Test (create): `apps/cli/test/watch.liveness.cli.test.ts` (real child) — enqueue a job / finalize an attempt / append a low-space audit row / insert a `model_calls` row / flip the watermark via the harness → each event arrives within 2×`pollMs`, correctly shaped, in per-source order (§13.3). This is the §9.3 cross-process `data_version` pin (writer = test process, watcher = spawned child).
2. **Event payload builders (SSOT-bound)**
   - What: build each payload per §7.3. `job` = `projectJobListRow` output (already carries `updatedAt`). `model_call`/`audit` = DDL columns camelCased (`audit` omits `payload_hash`). `backup` exposes DDL `seq` as **`watermarkSeq`** (the one documented correlation rename), other fields mirror the DDL. `daemon` = transition-only (`daemon, socketPath, reachable, previousReachable`).
   - Files: new `apps/cli/src/watch/events.ts`.
   - Interfaces — **Produces:** `buildJobEvent`, `buildModelCallEvent`, `buildAuditEvent`, `buildBackupEvent`, `buildDaemonEvent`, each returning the matching `watch.schema.json` member. **Consumes:** `projectJobListRow` from `@atlas/jobs` (never a second copy).
   - Test (add to) `watch.liveness.cli.test.ts`: `watch` and `jobs list --json` agree on the same job row (SSOT); `watermarkSeq` is the only invented name.
3. **Control events: heartbeat + non-fatal error + ordering/coalescing**
   - What: emit `watch.heartbeat` every `heartbeatSeconds` of quiet *or* activity, carrying `resume:{auditHeadSeq}` = contiguous prefix (absent while `attached:false` — the detached heartbeat wired in Phase 3 Task 4); probe daemons at heartbeat cadence via `probeDaemon` (Phase 1 Task 3): a `reachable`/`unreachable` outcome drives a `daemon` event on reachability **transition** only (compare `isReachable` vs the prior); a `fault` outcome (unexpected probe exception) instead emits a non-fatal `watch.error` with `source:"broker"|"egress"` + the fault `code`/`message` (§5.2/§7.1) — the stream continues. The `watch.error` *payload builder and emission mechanism* land here (`source, code, message`); the broker/egress **probe-fault** path is proven here (Task 3 test), and the specific ledger-detach fault that triggers `source:"ledger"` is exercised in Phase 5 (Task 2), where the detach/retry path exists. Enforce §7.4: fixed per-tick source order (`audit, model_call, job, backup`), `audit` in `seq` order within a batch; current-state coalescing (one `job` event with final state per interval; watermark latest only); append-only never coalesce.
   - Files: `apps/cli/src/watch/heartbeat.ts`, wire into `poll-loop.ts` and the detached loop.
   - Interfaces — **Produces:** `heartbeatTick(state, emit)`; `buildWatchError(source, code, message): WatchErrorLine`. **Consumes:** `probeDaemon`, the emit writer (Task 4).
   - Test (create): `apps/cli/test/watch.ordering.cli.test.ts` — two rapid job transitions in one tick → one event, final state (§13.5); heartbeat carries the prefix cursor; **daemon transition events on socket toggle** (reachable→unreachable→reachable, the §13.3 companion — `probeDaemon` exists, no detach needed); **a probe `fault` outcome emits `watch.error` (`source:"broker"`) and the stream keeps streaming** (the Phase 1 Task 3 fault seam proven end-to-end). **The recoverable-ledger-fault assertion (`watch.error(source:"ledger")` then continued streaming) is *not* here** — it requires the detach/re-attach path (Phase 5 Task 2) and is asserted in `watch.reattach.cli.test.ts` (Phase 5).
4. **Blocking NDJSON writer in `errors/envelope.ts`**
   - What: because `apps/cli/test/no-render-bypass.test.ts` permits direct `process.stdout` writes **only** from `apps/cli/src/errors/envelope.ts`, add the blocking line writer **there** (alongside `emitJson`), not in a `watch/` module. It must `\n`-terminate, apply `escapeControls` to free-text, **await write completion** (resolve on the callback / on `drain` when `write()` returns `false`), and swallow `EPIPE`-class errors (converted to a clean exit-0 signal, §10.1). Existing `emitJson` (which ignores backpressure) is left intact for one-shot commands; `watch` uses the new awaitable writer.
   - Files: `apps/cli/src/errors/envelope.ts` (new `emitLineAwaitable(obj: unknown): Promise<void>` + `escapeControls`), `apps/cli/src/watch/*` consume it.
   - Interfaces — **Produces:** `emitLineAwaitable(obj: unknown): Promise<void>`, `escapeControls(s: string): string` (escapes both C0 **and** C1 ranges, incl. U+009B CSI — `JSON.stringify` alone passes C1 raw).
   - Test (create): `apps/cli/test/watch.backpressure.cli.test.ts` — a **slow consumer** (a reader that pauses between reads, filling the pipe) receives every line **in order, none dropped**, proving `emitLineAwaitable` honored `drain`; and a `job.lastError` + `watch.error.message` each carrying U+009B and U+0000 serialize with both ranges escaped while conforming to the schema (§13.3 control-escaping). Also assert `no-render-bypass.test.ts` still passes.

### Risks
- Late-committing lower seq dropped/double-emitted. **Mitigation:** contiguous-prefix + sparse-set design; the §13.5 late-commit case (Phase 5 Task 1 test).
- `model_calls` `created_at` window would silently drop late commits. **Mitigation:** full-scan `call_id` set.

### Verification
- `pnpm --filter @atlas/cli build && pnpm --filter @atlas/cli test -- watch.liveness.cli.test.ts watch.ordering.cli.test.ts watch.backpressure.cli.test.ts no-render-bypass.test.ts` green on both CI legs.

---

## Phase 5: Resume, replay, re-attach, exit/signal handling + read-only proof — then flip `implemented:true`
**Goal:** `--since-seq` replay over the immutable captured window with the pre-replay-checkpoint rule, mid-stream re-attach (including the recoverable-ledger-fault path Phase 4 deferred) + incarnation reset, signal/EPIPE/fatal exit semantics, the behavioral read-only guard, and — once all of it passes — the registry flip.
**Dependencies:** Phase 4
**Estimated effort:** L

### Tasks
1. **`--since-seq` replay over the immutable captured window**
   - What: the window is the **immutable `ReplayWindow.rows`** captured in the atomic attach txn (Phase 3 Task 2) — `runReplay` replays *those* rows and **never re-queries the live connection** (closing the finding that querying live after the txn could over-emit). Sequence: emit `watch.hello` carrying `replay:{sinceSeq, events: rows.length}` and `resume.auditHeadSeq = min(sinceSeq, prefix)` (= `sinceSeq` in normal resume) → **then** `runReplay` re-sends `window.rows` as ordinary `audit` lines in strict `seq` order (never embedded in hello; the rows are already ordered by the capture query) → **then** emit an immediate `watch.heartbeat` advancing `resume.auditHeadSeq` to the new contiguous prefix. Because the window is a fixed snapshot, a row that commits into the `> sinceSeq` range between hello and replay is absent from `rows`, keeping `events` exact; that row surfaces through the live diff (its seq either extends the prefix or lands as a pending-hole fill per §7.4). `n=-1` replays from seq 0. High-space (non-`run.%`) rows are never in the captured window. `--since-seq` against a `DetachedLedger` defers to the first attached ledger (the orchestrator runs the deferred replay when the detached loop attaches, Phase 3 Task 4).
   - Files: new `apps/cli/src/watch/replay.ts`.
   - Interfaces — **Produces:** `runReplay(window: ReplayWindow, emit: (e: WatchEvent) => Promise<void>): Promise<void>` — iterates `window.rows` only; **takes no live connection**, computes no new count. **Consumes:** `ReplayWindow` (immutable rows), `buildAuditEvent`.
   - Test (create): `apps/cli/test/watch.replay.cli.test.ts` — seed rows `0..N`, `--since-seq k` replays exactly `k+1..N` in `seq` order, `replay.events` = replayed line count; **immutable-window race:** commit a new in-range low-space row after the child prints `watch.hello` but the replayed line count still equals the announced `events` (the extra row arrives later as a live `audit` line, not a replay line); `resume.auditHeadSeq = k` during replay then an immediate heartbeat at the new prefix (§13.4); `--since-seq -1` replays from row 0 (seq-0 pin); **crash-mid-replay** (kill child after hello, before the post-replay heartbeat; restart from the last *persisted* cursor `k`) skips no row; **cursor-above-head** (post-restore rewind) → `replay.events:0`, hello `resume.auditHeadSeq < n`; a seeded high-space row (`seq ≥ 10¹²`, e.g. a `db.backup` or an `evidence.retry_enqueued`) streams live but never replays and never enters the cursor; **pending-hole** (row 12 committed, 11 a pending intent) → `--since-seq 10` opens replay including 12 (the captured rows) with no pruning inference, row 11 emitted live when it commits.
2. **Mid-stream re-attach + incarnation reset (with the recoverable-ledger-fault path)**
   - What: the `runWatch` orchestrator (Phase 3 Task 4) invokes this after `runPollLoop().done` resolves `"reattach"` (ledger vanish / inode change / schema-head change). It emits `watch.error(source:"ledger")` (the Phase 4 Task 3 `buildWatchError`), drops the connection, and calls `reattach` — which re-runs `attachLedger` (re-opening via `openReadonlyLedger`); on a still-absent ledger it returns a `DetachedLedger`, so the orchestrator falls into its detached loop (Phase 3 Task 4) rather than spinning here. On success the orchestrator emits a **fresh `watch.hello`** (new snapshot + new `resume` cursor). This is also the sole home for the **recoverable-ledger-fault → continue-streaming** assertion Phase 4 deferred. `reattach` **resets and re-seeds every dedup field** (`auditContiguousPrefix`, `auditSparseEmitted`, `highSpaceEmitted`, `modelCallEmitted`, `jobsMap`, `backupRow`) scoped to the new attach epoch — never carried across (a restore rewind can re-issue seqs; a stale set would suppress live-only high-space rows forever). Re-seed the audit prefix by scanning existing low-space (`run.%`) seqs.
   - Files: new `apps/cli/src/watch/reattach.ts`, `apps/cli/src/watch/incarnation.ts`.
   - Interfaces — **Produces:** `reattach(path: string, opts: WatchOpts, ctx: AttachContext): Promise<Attachment>` (a fresh `Attachment` with reset baselines; may be `DetachedLedger` if the ledger is still gone). **Consumes:** `attachLedger`, `openReadonlyLedger`.
   - Test (create): `apps/cli/test/watch.reattach.cli.test.ts` — (a) **recoverable ledger fault, then continue** (the deferred §13.3 case): induce a detach mid-stream, assert `watch.error(source:"ledger")` **followed by a fresh `watch.hello` and continued streaming**; (b) **atomic restore/rewind** (lower `seq` at same path) → inode check fires `watch.error(source:"ledger")` then a fresh hello with the rewound cursor, consumer re-baselines (§13.7); (c) **incarnation reset**: after re-attach, a new high-space row (e.g. `evidence.retry_enqueued`) **and** a new low-space row whose seqs the *previous* incarnation already emitted are **both re-emitted**; (d) **detach-into-detached-loop**: delete the ledger mid-stream and leave it gone, assert `reattach` yields a `DetachedLedger`, the orchestrator emits a detached hello + detached heartbeats, and re-creating the ledger produces a fresh attached hello (proves re-attach and startup-detached share one path).
3. **Cursor semantics + stale-cursor (cursor-above-head)**
   - What: `resume.auditHeadSeq` = the contiguous-committed-prefix high-water of the low space among emitted rows (distinct from `snapshot.audit.headSeq` = max committed low-space seq; never the max emitted). Empty ledger ⇒ `resume:{auditHeadSeq:-1}`. **No `earliestAvailableSeq`, no too-old branch** (410-Gone unreachable in V1, §8.2).
   - Files: `apps/cli/src/watch/incarnation.ts` (accessor), `replay.ts`.
   - Interfaces — **Produces:** `contiguousPrefix(state: SourceBaselines): number`.
   - Test: covered by the `watch.replay.cli.test.ts` cursor-above-head + empty-ledger `-1` cases.
4. **Exit codes + signal/EPIPE handling + fatal protocol-error mapping**
   - What: per §10.1 — `--once` done / SIGINT / SIGTERM / EPIPE ⇒ flush the current line, exit **0**; config/vault startup fault ⇒ exit **2** envelope; internal fault **or a broker `protocol-error` probe result during the snapshot** (Phase 1 Task 1's `AnchorProbe.kind === "protocol-error"`, i.e. a thrown `BrokerRefusal("broker.bad_request")` — *not* `unreachable`, which is data and degrades to `sqlite-only`) ⇒ exit **4**, one final `error-envelope` line, no event line after, no raw stack; usage ⇒ exit **5**. EPIPE exits 0 quietly (never 141); other signals keep default 128+n. The signal handlers call `stop()` on whichever loop (`PollHandle`/`DetachedHandle`) the orchestrator is currently awaiting, so `runWatch` resolves `"stopped"` and returns 0. The attach path (Phase 3 Task 2) already resolves the probe before the transaction; here that resolved `kind` is mapped to the fatal path.
   - Files: `apps/cli/src/commands/watch.ts` (signal handlers, top-level catch, protocol-error → fatal), `apps/cli/src/errors/envelope.ts` (the `emitLineAwaitable` EPIPE path).
   - Interfaces — **Produces:** signal handlers wired to the active loop's `stop()`; `emitFatalEnvelope(err: unknown): never` (final envelope + mapped exit).
   - Test (create): `apps/cli/test/watch.termination.cli.test.ts` — SIGINT/SIGTERM → exit 0 with a flushed final line (from both an attached and a detached state, proving `stop()` reaches whichever loop is active); a `head -1`-style consumer closing the read end → exit 0, no SIGPIPE kill; broken config → exit 2 envelope (§13.6); §13.11 fatal framing: (a) a **`broker.bad_request` refusal** during the snapshot probe (`resolveAnchorProbe` returns `protocol-error`) → exit **4**, exactly one envelope, no event line, no stack; (b) an unexpected exception after ≥1 streamed event → exit 4, one envelope, no event after; and a **contrast case** — an *unreachable* broker at attach degrades to `sqlite-only` and keeps streaming (exit stays live), proving unreachable ≠ protocol-error.
5. **Read-only / prohibited-effects proof**
   - What: the behavioral guard that `watch` mutates nothing and reuses no audited path.
   - Files: new `apps/cli/test/watch.readonly.cli.test.ts`.
   - Interfaces — **Consumes:** the in-process broker + lock harness instrumentation.
   - Test (§13.10): snapshot `audit_events` head, `backup_watermark`, and lock state before attach; run `watch` across attach → ≥1 heartbeat → ≥1 domain event → SIGTERM; assert **none changed** (no new `run.readonly` or any audit row, no watermark/backup-cadence movement, no lock acquired); assert the **only** broker call observed is read-only `getAuditChainStatus` (+ reachability probes) — no mutation method.
6. **Flip `implemented:true`**
   - What: with the complete handler passing Phases 3–5, flip the `commands.json` row `implemented:false → true` and regenerate the overview (`pnpm contract:write`). The flip is contract bookkeeping only — the handler was already dispatchable since Phase 3 (`main.ts` gates on registration, not the flag); this makes `checkImplementedSchemas` and `command-registration.test.ts` assert the flip-with-handler pairing on a command that now fully works.
   - Files: `commands.json`, generated `commands-overview.md`.
   - Test: `apps/cli/test/command-registration.test.ts` (the #145 guard) passes the flip-with-handler pairing; `node tools/gen-cli-contract.ts --check` and `pnpm contract:check` clean.

### Risks
- Persisted-hello-cursor consumer crashing mid-replay skips rows if the checkpoint were the head. **Mitigation:** pre-replay-checkpoint rule + crash-mid-replay test.
- Re-attach carrying stale dedup state suppresses live-only high-space rows forever. **Mitigation:** incarnation-scoped reset + the explicit §13.7 test.
- `unreachable` misclassified as `protocol-error` would kill a stream during a normal broker outage. **Mitigation:** the Phase 1 `anchor-probe.test.ts` classification pin (timeout/connect ⇒ unreachable; `broker.bad_request` ⇒ protocol-error) + the §13.11 contrast case.

### Verification
- `pnpm --filter @atlas/cli build && pnpm --filter @atlas/cli test -- watch.replay.cli.test.ts watch.reattach.cli.test.ts watch.termination.cli.test.ts watch.readonly.cli.test.ts command-registration.test.ts` green; full contract suite green with `implemented:true`; `node tools/gen-cli-contract.ts --check` passes.

---

## Phase 6: `--json` read-surface conformance sweep
**Goal:** One sweep test asserting every read-class command's `--json` validates against its `schemaRef`; fix nonconformances in-chain.
**Dependencies:** Phase 2 (registry/schema), Phase 3 (registered handler + `--once`, so `watch --json --once` dispatches for its sweep line — independent of the Phase 5 flip).
**Estimated effort:** M

### Tasks
1. **Runtime-derived inventory + sweep test + per-command invocation adapter map**
   - What: `apps/cli/test/json-conformance.sweep.test.ts` derives the inventory **at runtime** from the schemas by `executionClass` ∈ {`read`, `audited-read`, `pure`} (24 commands at spec time + `watch`), never a hardcoded list. Each command drives through an **invocation adapter** rather than a generic `--json` call, because several need positional identifiers, named path flags, or an authorization flow. The adapter interface:
     ```ts
     interface InvocationAdapter {
       arrange(vault: FixtureVault, harness: TestHarness): Promise<{ argv: string[]; cleanup?: () => Promise<void> }>;
     }
     ```
     `arrange` seeds the fixture and returns the **concrete argv with fixture-derived ids/paths** (no literal id or path guessed). The adapter map:
     | Command | argv produced by `arrange` |
     |---|---|
     | `status`, `doctor`, `validate`, `db status`, `db verify` | `["<cmd…>", "--json"]` (no positional) |
     | `jobs list`, `source list`, `evidence review`, `git status`, `git verify`, `index status`, `index verify` | `["<cmd…>", "--json"]` |
     | `git review` | `["git", "review", <seededRunId>, "--json"]` — requires `<runId>` |
     | `source show` | `["source", "show", <seededSourceId>, "--json"]` |
     | `source trust show` | `["source", "trust", "show", <seededSource>, "--json"]` — requires `<source>` |
     | `note show` / `note history` / `note related` | `["note", "<sub>", <seededNoteId>, "--json"]` |
     | `inspect` | `["inspect", <seededRunId>, "--json"]` |
     | `query` | `["query", <fixtureQueryText>, "--json"]` — in-process egress harness armed |
     | `index eval` | `["index", "eval", "--queries", <queriesPath>, "--labels", <labelsPath>, "--json"]` — seeded index + eval-set fixture + in-process egress harness; **requires `--queries`/`--labels`, not bare `--json`** |
     | `graduation scan` | `["graduation", "scan", "--source", <sourcePath>, "--copy", <copyPath>, "--json"]` — the source-copy arrangement the existing graduation tests build; **requires `--source`/`--copy`, not a positional path** |
     | `graduation audit` | `["graduation", "audit", "--json"]` — after a prior `graduation scan` persisted scan-state |
     | `quarantine inspect` | export-challenge → sign → authorization: `arrange` runs `["quarantine","inspect",<seededQuarantineId>,"--export-challenge"]`, signs the challenge with the **test-mode fixture signer** (`tools/` fixture authorization signer, under `ATLAS_TEST_MODE`), writes `<authPath>`, then returns `["quarantine","inspect",<seededQuarantineId>,"--authorization",<authPath>,"--json"]` |
     | `watch` (streaming adapter) | `["watch","--json","--once"]` — the sole long-lived command; `--once` bounds it; its single `watch.hello` line validated against the union |
     Per command: run the argv, validate stdout against the command's `schemaRef` with the draft-2020-12 validator (already a dependency of `cli-schemas.test.ts`); non-streaming commands run to natural exit.
   - Files: new `apps/cli/test/json-conformance.sweep.test.ts`, new `apps/cli/test/support/invocation-adapters.ts`.
   - Interfaces — **Consumes:** registry rows + schemas (derive inventory), `withFixtureVault`, the in-process broker/egress harness, the existing graduation/quarantine test harnesses (reuse, don't rebuild), the fixture authorization signer.
   - Test: §13.8 — the sweep passes for all runtime-inventoried commands, each under its adapter; `watch` doesn't hang the sweep.
2. **In-chain nonconformance fixes (fix-forward)**
   - What: fix each divergence the sweep finds — *output* bugs in the handler, *schema* bugs in the schema (diff called out in the PR). Known candidate: route the `jobs list` bare-`Number()` pagination parse through `apps/cli/src/commands/pagination.ts` (the SSOT owner).
   - Files: offending handlers/schemas; `apps/cli/src/commands/jobs.ts`.
   - Interfaces — **Consumes:** `apps/cli/src/commands/pagination.ts`.
   - Test (modify): `apps/cli/test/pagination.contract.test.ts` asserts `jobs list` uses the shared parser; the sweep green after fixes.

### Risks
- Sweep hangs on `watch` without `--once`. **Mitigation:** the streaming adapter uses `--json --once`.
- A discovered divergence balloons the diff. **Mitigation:** land each fix as its own reviewable commit (§15 anticipates it).

### Verification
- `pnpm --filter @atlas/cli build && pnpm --filter @atlas/cli test -- json-conformance.sweep.test.ts pagination.contract.test.ts` green on both CI legs.

---

## 4. Integration Points

- **`watch` ↔ `status`/`doctor`:** the shared derivation modules (`apps/cli/src/health/snapshot.ts`, `apps/cli/src/health/probe.ts`) plus the anchor-probe split in `anchor-check.ts` are the contract. `deriveSnapshot` is **synchronous** and takes a `SnapshotContext` whose `probe` is a **pre-resolved `AnchorProbe`** — the async `getAuditChainStatus` RPC (`resolveAnchorProbe`, classified via `packages/broker/src/protocol.ts`'s `BrokerRefusal` contract + a bounded timeout) runs *before* the `better-sqlite3` transaction, so the atomic capture never awaits. The ledger cross-check runs synchronously inside that transaction against the resolved probe. Byte-agreement with `status` is a test invariant (§7.6, Phase 1 goldens).
- **`watch` ↔ `@atlas/jobs`:** the `job` event and `jobs list` share one owner — `packages/jobs/src/repo.ts`'s `listJobs`/`projectJobListRow`/`JobListRow` (with `updatedAt`). `watch` calls `listJobs` per tick; it never issues its own jobs SQL.
- **`watch` ↔ `@atlas/sqlite-store`:** the ledger is opened only through `openReadonlyLedger` and typed as `SqliteDatabase` — `apps/cli` takes no direct `better-sqlite3` dependency.
- **`watch` ↔ ledger DDL:** `audit_events` low/high seq split by the executable `run.%`-vs-not allocator (`intents.ts:267–270`) — low = `run.%` (`seq < DB_EVENT_SEQ_BASE`), high = the 3 `db.*` + `evidence.retry_enqueued` (`seq ≥ DB_EVENT_SEQ_BASE`); `model_calls`, `jobs`+`job_attempts`, `backup_watermark`. The `eventType` enum is a harness-pinned replica of the 14-value DDL CHECK. The `--since-seq` replay window is captured immutably inside the attach transaction (`ReplayWindow.rows`), never re-queried live.
- **`watch` ↔ broker:** the single read-only `getAuditChainStatus` IPC (via `resolveAnchorProbe`) + connect/close reachability probes — nothing else. Connect error / timeout ⇒ `unreachable` ⇒ degrade; `BrokerRefusal("broker.bad_request")` ⇒ `protocol-error` ⇒ fatal exit 4.
- **Orchestration seam:** `runWatch` is the sole caller of `runPollLoop` (attached) and `runDetachedLoop` (detached); each returns a `done` promise the orchestrator awaits to decide re-attach vs exit. Startup-detached and mid-stream-re-attach share the one detached loop.
- **CLI-contract harness:** `commands.json` ↔ `cli-surface.fixture.txt` ↔ `watch.schema.json` bijection; `PHASES=[0..6]`. Package `@atlas/cli-contract-tools`.
- **Envelope:** every event line and the one error envelope share NDJSON v1 framing; the blocking writer lives in `apps/cli/src/errors/envelope.ts` (the sole render-bypass-allowlisted file); `error-envelope.schema.json` reused verbatim.

## 5. Testing Strategy

Vitest, `withFixtureVault` + in-process `BrokerService`, no OS provisioning; both CI legs (ubuntu + macos). `watch` is spawned as a **real child process** (`dist/bin.js`) for stream tests — the stream contract *is* the process boundary. The child dispatches `watch` from Phase 3 onward because the **handler is registered** (`main.ts` gates on registration, not `row.implemented`); the flip to `implemented:true` is Phase 5 bookkeeping and does not gate dispatch.

**Order:** contract gates (Phase 2) → hello/once + in-process tick test + startup-detached transition (Phase 3) → liveness + ordering + backpressure/escaping (Phase 4, single stable incarnation) → replay (immutable window) + re-attach (incl. the recoverable-ledger-fault + detach-into-detached-loop paths) + termination + read-only proof + flip (Phase 5) → conformance sweep (Phase 6). The §13 acceptance list (items 1–11) is the exit bar; the §9.3 cross-process `data_version` property is pinned by the liveness test (§13.3, Phase 4 — the first phase with real domain emission to observe). The recoverable-ledger-fault assertion (§13.3's ledger half) lives in Phase 5's `watch.reattach.cli.test.ts`, where detach/re-attach exists; the startup-detached → attach transition lives in Phase 3's `watch.detached.cli.test.ts`, where the detached loop lands.

**Live drive (manual, per test-live posture):** on this Mac against the real provisioned install — `brain watch --json | head` shows hello + real events while `brain enrich --apply` runs in another terminal (`enrich` confirmed present in the registry); kill/re-attach with the printed cursor. Documented as a PR runbook step (§13.9), not automated.

*(No Rollback Plan section: §4 scopes this as a single-user playground tool — no shared state, no migration, no cloud infra. `watch` is read-only by construction and a `git revert` fully undoes any code change; the spec's own crash-consistency story is "`watch` holds no durable state; restart and re-baseline", §8.3.)*

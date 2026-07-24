# `@atlas/jobs` — the operational async queue

SQLite-backed, single-runner, crash-durable job queue. Implements
[`docs/specs/jobs-contract.md`](../../docs/specs/jobs-contract.md) — the contract is the SSOT, this
package is the implementation. A job *drives* a workflow run; it is **not** a run. Job rows live in
`jobs`/`job_attempts`/`job_cancellations`, never in `agent_runs`.

**v2 posture (ADR-0003):** the queue is **retained infrastructure with ZERO production enqueuers.**
`reverify` (the last real workflow) and the retention sweeps, trust remediation, and the absorb-cycle
`index:reconcile` all died with their enqueuers (#334); `evidence retry` is now a synchronous
frontmatter mutation, not an enqueued job. Nothing production code runs enqueues anything, so
`jobs run` drains an **empty** production set — the durable engine stays for the survivor
`jobs run|list` commands, the env-gated test handler, and any future workflow. The code carries a
few **v1-vestigial branches** (see Gotchas) because `jobs-contract.md` is a V1-era contract that was
superseded, not rewritten.

## How it fits

- **Runs in-process in the single `brain` process** (v2 — no broker mediates it). **Depends on**
  `@atlas/contracts` (ids, canonical serialization) + `@atlas/sqlite-store` (the `Store`, migration
  runner) + `better-sqlite3`. It **never imports `apps/cli` or `@atlas/lancedb-index`** — the OS lock
  (`deps.withLock`), config, filesystem, and workflow handlers are all injected (plan §2.5 module
  discipline). The only `apps/cli` mentions in the source are docstrings.
- **Sole owner of the queue DDL + all writes.** `@atlas/sqlite-store` deliberately does not know the
  `0002`/`0007` migrations and consumes the queue **read-only** via `readSnapshot`. `@atlas/jobs` is
  the only writer of `jobs`/`job_attempts`/`job_cancellations`.
- **Consumers (both in `apps/cli/src/commands/jobs.ts`):** `jobs list` calls `listJobs`; `jobs run`
  wires `runAll` + `SqliteCancellationSource` + a per-drain handler map from
  `buildJobHandlers` (`apps/cli/src/commands/job-handlers.ts` — **empty in v2**). `jobs retry` and
  `jobs cancel` were **culled** in the 55→24 command cut (only `jobs list` + `jobs run` remain in
  `commands.json`).

## Key files (all under `packages/jobs/`)

| File | Role |
|---|---|
| `src/index.ts` | Barrel — the entire public surface (functions, types, error classes, migrations). |
| `src/repo.ts` (868 lines) | Transactional core + **sole writer**: `enqueue`, `claimNext`, four finalizers, `cancelJob`, `retryJob`, `resetForRetry`, snapshot/list reads, payload-hash verification, all error classes, the `EnqueueContext` seam. |
| `src/runner.ts` (541 lines) | `runAll` synchronous drain + `{ items, aggregate }` batch protocol; `backoffDelayMs`, `classifyError`; `CancellationRegistry` (in-process) + `SqliteCancellationSource` (cross-process durable); exit-code precedence. |
| `src/recovery.ts` | `recoverDeadRunners` — startup reconciliation of a dead runner's `running` rows, under the lock, before any claim. |
| `src/register.ts` | Composition-root seams: `registerJobsMigration`, `openJobsStore`, `productionEnqueueContext`, `DEFAULT_MAX_ATTEMPTS = 5`. |
| `migrations/0002_jobs.ts` | `jobs` + `job_attempts` DDL (STRICT), verbatim from `sqlite-data-dictionary.md` §4. |
| `migrations/0007_job_cancellations.ts` | Durable cross-process cancel-intent table (STRICT, FK CASCADE). |
| `test/jobs.lifecycle.test.ts` | 35 tests — state machine, recovery, cancel races, stale-attempt guards, backoff, payload integrity, mutable-effect atomicity. |
| `test/repo.projection.test.ts` | 5 tests — `jobs list` projection: `listJobs` rows carry `updatedAt` and equal `projectJobListRow` of the raw row; `listAllJobs` returns the full table (past the 500 page cap) in one consistent read and equals the concatenation of the paginated `listJobs` pages, so both readers resolve through the one query builder. |

**Composition-root wiring.** `sqlite-store`'s `openStore` pre-registers only the retained core
migrations. The CLI's `db migrate` composition root (`apps/cli/src/commands/store-open.ts:37`,
`registerFeatureMigrations`) calls `registerJobsMigration(store)` **before**
`store.migrate()` so `db migrate` discovers `0002`/`0007` through the normal checksum-guarded,
gap-tolerant runner (identical pattern to the workflows layer's `registerWorkflowMigrations`).
`openJobsStore` is the one-call production path: open → register → migrate → bind a production
`EnqueueContext` (`src/register.ts:70`). **v2 (#338):** the AEAD backup/verify subsystem is retired,
so `registerJobsMigration` no longer calls `registerKnownSchemaHead` — the schema-head
self-recognition it needed is gone with it (`src/register.ts:54-56`).

## Invariants & guardrails

- **Budget enforced at exactly one point — the claim.** `claimNext` selects only jobs with
  `attempts < max_attempts` (`src/repo.ts:322`, SQL at `:341`/`:351`); no path (manual retry,
  recovery) can run a `maxAttempts+1` attempt — an exhausted job is simply un-claimable.
  `claimNext` increments `attempts` up front, so a crash costs exactly that attempt.
- **Two DISTINCT retry primitives — do not conflate (both EXPORTED, both UNWIRED in v2):**
  - `retryJob` (was CLI `jobs retry`, `failed → pending` only): **preserves `attempts`**, raises
    `max_attempts = MAX(max_attempts, attempts + 1)` — grants exactly one more attempt, keeps
    `attempt_no`s monotonic (`src/repo.ts:676`).
  - `resetForRetry` (was `evidence retry` #139; any terminal state): **resets `attempts → 0`**,
    `next_run_at → now`, **bumps `lease_epoch`**; idempotent (`already-active` for a live job)
    (`src/repo.ts:527`).
  - No production caller wires either today (`jobs retry` culled; `evidence retry` de-queued) — they
    are repo primitives exercised only by the lifecycle tests.
- **Every mutation is an IMMEDIATE transaction.** The claim's `pending → running` flip + the
  `job_attempts` insert land atomically; concurrent writers serialize on the SQLite write lock.
- **Payload integrity on every read.** `decodePayload` recomputes `sha256(canonicalSerialize(payload))`
  and throws `PayloadIntegrityError` on mismatch — enforced in `readSnapshot` **and** inside
  `claimNext` before the row is marked running.
- **All four finalizers require EXACTLY ONE active attempt.** The attempt UPDATE is scoped to
  `attempt_no = @attempt AND outcome = 'running' AND finished_at IS NULL` and demands `changes === 1`,
  else `StaleAttemptError` rolls the txn back — a stale/wrong attempt can never transition the job
  nor commit a side effect against the real running attempt.
- **Cancel arbitrated INSIDE finalization.** `completeJob`/`scheduleRetry`/`failJob` all call
  `arbitrateCancellation` FIRST (`src/repo.ts:406`, invoked at `:460`/`:500`/`:555`): a durable cancel
  intent drives the job `cancelled` and **no mutable effect runs** — closing the race of a cancel
  committed after the handler's final signal check. (No CLI path records such an intent in v2 — see
  Gotchas.)
- **Mutable effect commits atomically with terminal state + id.** `completeJob(effect)` runs the
  `commit` closure inside the same IMMEDIATE txn before the flip; a throw rolls back everything (job
  stays `running`, recoverable). A `commit` with a NULL/empty `sideEffectId` is rejected at the repo
  boundary (`SideEffectIdRequiredError`) and the runner classifies it as `validation` (permanent, one
  attempt) (`src/runner.ts:440`).
- **Enqueue idempotency** per `(workflow, idempotency_key)` via `ON CONFLICT DO NOTHING`; a duplicate
  returns the existing `jobId`. `maxAttempts` range `[1,20]` (`MAX_ATTEMPTS_MIN`/`MAX`) checked at
  enqueue on **both** the per-job override and the configured default (`assertMaxAttempts`) —
  zero/negative would wedge a job permanently unclaimable.

## Gotchas & sharp edges

- **The CLI cancel path is culled — the cross-process cancel machinery is now VESTIGIAL.** `jobs run`
  still constructs `new SqliteCancellationSource(store.db)` (`apps/cli/src/commands/jobs.ts:252`) and
  the runner still polls `job_cancellations`, but there is **no `jobs cancel` command** to record an
  intent, so nothing ever fires it. `cancelJob`/`requestJobCancellation` have no production caller.
  Retained for a future re-introduction; live-inert today.
- **`runner.ts` docstrings say "file-backed" cross-process cancel — that's STALE.** The comments
  (`src/runner.ts:46,65,258`) describe a filesystem-marker source, but the shipped mechanism is the
  **durable `job_cancellations` table** (`SqliteCancellationSource`). There is no file-backed
  `CancellationSource` in the tree. Read "file-backed" as "durable SQLite".
- **`classifyError` carries v1-vestigial permanent codes.** `secret-detected`/`secret-scan` →
  permanent (`src/runner.ts:356`) is **dead classification** — `@atlas/scan` is retired (ADR-0003),
  so nothing produces those codes. The transient set is also a slight superset of the contract table:
  `partial_batch` is transient (`src/runner.ts:325`), which contract §2's examples omit. Live
  behaviour: `locked:*` → transient; `validation`/`reserved-operation` → permanent; unknown →
  transient with stable code `internal`.
- **Aggregate exit precedence `4 ⊐ 2 ⊐ 1 ⊐ 7`** (`src/runner.ts:380`). Per-item: failed-`internal`→4,
  failed-`locked:*`→2, failed-transient-exhausted→7, failed-permanent→1;
  `succeeded`/`retry-scheduled`/`cancelled`/`skipped:*` never raise. The literal code array is
  `[4, 2, 1, 7, 6, 5]`, but the `6` slot (`action-required`) is **retired** (the v2 process-exit set
  is `0·1·2·4·5`; `runner.ts:364`'s `action-required→6` branch is unreachable — no handler returns
  `actionRequired`) and `5` is never a per-item outcome. `7` (provider-retryable) is emitted **only**
  by this batch aggregate, never by the single-error envelope.
- **Zero-backoff re-drain guard.** `runAll` tracks a `processed` set and passes it as `claimNext`'s
  `exclude` so a retry rescheduled with `next_run_at = now` (provider `retryAfterMs = 0` or a
  zero-jitter draw) is NOT re-claimed in the same invocation — each job runs at most once per drain
  (contract §5). better-sqlite3 forbids mixing `?` and `@named` params, hence the `@ex{i}` placeholder
  construction (`src/repo.ts:326-333`).
- **No `claimed` state, no `interrupted` outcome.** The single-runner queue claims + starts in one
  transition, so a crash leaves a `running` (never `claimed`) row. An interrupted attempt is finalized
  in place as `outcome = 'failed'`, `error_code = 'interrupted'` — NOT a distinct outcome and NOT a
  fresh attempt (`src/recovery.ts`, contract §4/§6).
- **Recovery on a crashed FINAL attempt drives terminal, does not re-queue.** An at-budget
  (`attempts >= max_attempts`) crashed job is closed `failed` (`attempts-exhausted`); re-queuing would
  run a `maxAttempts+1` attempt or wedge it `pending` forever under the claim guard. A durable cancel
  intent is honored FIRST, before budget handling (the "stranded intent" fix — pre-fix, a crash on the
  final attempt of an exhausted job went `failed`, never re-claimed, and the intent row leaked forever;
  `src/recovery.ts:63-65`).
- **`enqueue` needs a bound `EnqueueContext`.** A raw `openStore` connection has none; `enqueue`
  throws `EnqueueContextRequiredError` rather than minting a row with an unseeded clock/id. Use
  `openJobsStore` (production) or `bindEnqueueContext` (tests). The context lives in a `WeakMap` keyed
  by the connection object, so it GCs with the connection — no global singleton.
- **Two list orderings, both deterministic but different.** `listJobs` is `created_at DESC, job_id
  DESC` (newest-first); `jobIdsInStates` (bulk selectors) is `(next_run_at, job_id)` ascending
  (contract §8). Don't assume one order everywhere.
- **Migration numbering interleaves across packages — do NOT renumber.** `0001/0003/0004/0005/0006/
  0008–0015` are `sqlite-store`-owned; `0002` + `0007` are jobs-owned. Both jobs migrations landed in
  the same commit (#75); the gap reflects the plan's PR ordering, not chronology. The gap-tolerant
  runner applies by id order and never assumes contiguity (`migrations/0002_jobs.ts:16-20`).
- **`lease_epoch` is reserved and always 0 in V1.** Multi-worker leasing is deferred; when it lands,
  recovery keys on `(jobId, lease_epoch)`. Today recovery under the exclusive lock is unconditional
  over `running` rows.

## History (real PRs)

- **#61** (`21f8125`, Phase 0) — scaffolded the empty package (2-line `index.ts`).
- **#75** (`a0c8e1e`, plan Task #33) — the whole queue in one PR: `0002` **and** `0007`,
  repo/runner/recovery/register, both original test files. Review arc: nullable
  `job_attempts.side_effect_id` (content-addressed effects → NULL; mutable effects populate it) +
  `jobs.payload NOT NULL` (durable canonical JSON so recovery reconstructs work); hardened all four
  finalizers to the single-active-attempt guard; made cancel intent durable (`0007`).
- **#139** (`e414a58`, Task 4.7) — `brain evidence retry` added `resetForRetry` (terminal → fresh
  pending, `attempts→0`, `lease_epoch` bumped; idempotent). v2 de-queued `evidence retry`, so
  `resetForRetry` is now unwired.
- **#338** (`3078fa2`, v2 de-ledger) — stripped the AEAD backup/watermark + ledger tables; removed
  `registerKnownSchemaHead` from `register.ts` and deleted the `jobs.backup-schema-head.test.ts`
  regression (both existed only because a jobs-owned schema head had to be recognized by the retired
  backup-verify path).

## Open items

- **The queue is dormant — nothing production enqueues.** `PRODUCTION_WORKFLOWS` in
  `apps/cli/src/commands/job-handlers.ts` is empty; `jobs run` drains an empty set. Using the queue
  again means adding a workflow handler **and** an enqueuer (the completeness gate holds vacuously
  until then: every enqueueable workflow has a handler, no handler without an enqueuer).
- **v1-vestigial code to clean up** — the `secret-detected`/`secret-scan` classification, the
  `action-required`→6 branch + the `6` slot in `aggregateExit`, the "file-backed" cancel docstrings,
  and the live-inert cancel machinery all survive from V1. `jobs-contract.md` itself is an
  un-rewritten V1 spec (still lists `secret-detected`, backup/quarantine effect examples).
- **Multi-worker leasing (post-V1)** — `lease_epoch` is the reserved fencing token; claim + recovery
  are single-runner today.
- **`raw_payloads` deferred out of V1** — `jobs.payload NOT NULL` is the deliberate consequence so
  pending jobs are never orphaned by payload-by-reference.

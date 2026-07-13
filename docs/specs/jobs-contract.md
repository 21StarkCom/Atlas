# Jobs contract (normative) — Atlas V1 Phase 2

**Owner task:** 2.0 · **Consumed by:** Task 2.7 (`@atlas/jobs` + `jobs` CLI). This is the single
source of truth for the queue's legal state transitions, retry classification, backoff schedule,
terminal semantics, the `jobs-runner` process-lock ownership (D5), and dead-runner recovery. The
`0002_jobs` migration and the runner implement this contract verbatim.

> Scope note. The jobs queue is the **operational** async surface (capture follow-ons in Phase 2,
> synthesis in Phase 4). It is NOT the workflow state machine (`recovery-state-machine.md`) — a job
> *drives* a run, it is not a run. Job rows live in `jobs`/`job_attempts` (owned solely by
> `@atlas/jobs`), never in `agent_runs`.

## 1. Job states + legal transitions

A job is always in exactly one state. The closed set:

| State | Kind | Meaning |
|---|---|---|
| `pending` | active | eligible to be claimed once `next_run_at ≤ now` |
| `running` | active | claimed and executing (a claim atomically flips `pending → running`) |
| `succeeded` | terminal | completed successfully |
| `failed` | terminal | attempts exhausted (or a permanent error) |
| `cancelled` | terminal | cancelled by `jobs cancel` before/while running |

> State set = the authoritative `jobs.state` CHECK in the SQLite data dictionary
> (`pending | running | succeeded | failed | cancelled`). There is **no separate `claimed`
> state**: the single-runner queue claims and starts in one atomic transition (`pending →
> running`), so a crashed runner leaves a `running` (never `claimed`) row for recovery. The
> reserved `lease_epoch` fencing column exists for the deferred multi-worker lease but is written
> `0` and never advanced in V1.

Legal transitions (any transition not listed is illegal and rejected by the repository layer):

```json jobsStateMachine
{
  "version": 1,
  "states": ["pending", "running", "succeeded", "failed", "cancelled"],
  "terminals": ["succeeded", "failed", "cancelled"],
  "initial": "pending",
  "transitions": [
    { "from": "pending", "to": "running", "trigger": "runner-claim" },
    { "from": "pending", "to": "cancelled", "trigger": "jobs-cancel" },
    { "from": "running", "to": "succeeded", "trigger": "attempt-ok" },
    { "from": "running", "to": "pending", "trigger": "retry-scheduled" },
    { "from": "running", "to": "pending", "trigger": "dead-runner-recovery" },
    { "from": "running", "to": "failed", "trigger": "attempts-exhausted" },
    { "from": "running", "to": "failed", "trigger": "permanent-error" },
    { "from": "running", "to": "cancelled", "trigger": "cancel-observed" },
    { "from": "failed", "to": "pending", "trigger": "jobs-retry" }
  ]
}
```

`jobs retry` re-queues a `failed` job (→ `pending`, backoff cleared, `next_run_at = now`). `jobs
cancel` transitions a `pending` job to `cancelled` directly; a `running` job is signalled
cooperatively via its `AbortSignal` and reconciled to `cancelled` at its next checkpoint
(`cancel-observed`). Dead-runner recovery is the second `running → pending` edge (see §6).

## 2. Retry classification + bounded defaults

Every attempt failure is classified deterministically from the error taxonomy
(`@atlas/contracts` `ProviderError` + the internal error set). The classification decides whether the
job is retried:

| Class | Retried? | Examples |
|---|---|---|
| `transient` | yes (until attempts exhausted) | `timeout`, `transport`, `rate_limit`, `quota`, `locked:*` |
| `permanent` | no (→ `failed` immediately) | `validation`, `authentication`, `model_incompatible`, `secret-detected`, `reserved-operation` |
| `cancelled` | no (→ `cancelled`) | cooperative cancel observed |

Bounded defaults (config `jobs.*`, overridable per `JobSpec.maxAttempts`):

- `jobs.max_attempts` default **5** (min 1, max 20). A job's own `maxAttempts` wins when set.
- A `permanent` failure ends the job at whatever attempt it occurred, regardless of remaining budget.

## 3. Backoff schedule

Retry delay is exponential with full jitter, bounded, deterministic given the attempt number and the
job's seed (so a controlled clock makes tests deterministic):

```json jobsBackoff
{
  "strategy": "exponential-full-jitter",
  "baseMs": 1000,
  "factor": 2,
  "maxMs": 300000,
  "formula": "delay(n) = random_in([0, min(maxMs, baseMs * factor^(n-1))], seed=(jobId, n))",
  "example": [
    { "attempt": 1, "ceilingMs": 1000 },
    { "attempt": 2, "ceilingMs": 2000 },
    { "attempt": 3, "ceilingMs": 4000 },
    { "attempt": 8, "ceilingMs": 128000 },
    { "attempt": 20, "ceilingMs": 300000 }
  ]
}
```

`next_run_at = now + delay(attempt)`. `ceilingMs` is `min(maxMs, baseMs * factor^(n-1))`; the actual
delay is a jittered value in `[0, ceilingMs]`. Config keys: `jobs.backoff_base_ms` (default 1000),
`jobs.backoff_factor` (default 2), `jobs.backoff_max_ms` (default 300000).

## 4. Terminal semantics

- `succeeded` / `failed` / `cancelled` are absorbing: a terminal job is never re-executed. The ONLY
  transition out of a terminal state is `failed → pending` via an explicit operator `jobs retry`.
- A job's terminal outcome is recorded with its final attempt count and a stable failure
  classification (allowlisted metadata only — never raw payloads).
- `job_attempts` retains one row per attempt with exactly the DDL columns — `attempt_no`,
  `outcome ∈ (running, succeeded, failed, cancelled)`, `error_code` (stable classification, nullable),
  `started_at`, `finished_at`. There is **no `interrupted` outcome and no side-effect-id column**:
  an interrupted attempt is finalized in place as `outcome = 'failed'` with `error_code =
  'interrupted'` (see §6), and idempotency is carried by `jobs.idempotency_key`, not a per-attempt id.

## 5. `jobs-runner` process lock (D5)

- New named lock scope **`jobs-runner`** (exclusive). Ordered in the global lock hierarchy between
  `ledger-maintenance` and `canonical-integration`:
  `vault-maintenance ⊐ ledger-maintenance ⊐ jobs-runner ⊐ canonical-integration` (+ concurrent
  `shared`). A draining job may acquire `canonical-integration` per job (a strictly lower scope).
- `jobs run` acquires `jobs-runner` for the whole drain. A second concurrent `jobs run` fails with
  `locked:jobs-runner` (exit **2**), retryable.
- The lock records owner pid + start time so `doctor --reclaim-locks` can reclaim a dead-pid lock.

## 6. Dead-runner startup recovery

On runner startup (before claiming any job), under the exclusive `jobs-runner` lock, the runner
reconciles jobs the previous (now-dead) runner left mid-flight. Because the lock is exclusive and
single-runner, holding it means no live runner owns any `running` row, so recovery is
unconditional over `running` jobs:

- Any `running` job → reset to `pending` (`dead-runner-recovery`), backoff untouched, attempt count
  preserved. The interrupted `job_attempts` row (the one still `outcome = 'running'`,
  `finished_at IS NULL`) is finalized in place as `outcome = 'failed'`, `error_code = 'interrupted'`,
  `finished_at = now` — it is NOT counted as a fresh attempt (the `jobs.attempts` counter is left
  unchanged), so the reset attempt budget is identical to before the crash.
- Idempotency: recovery re-derives the same target state from the persisted rows, so running it
  twice converges (the second pass sees no `running` row). The reserved `lease_epoch` (§1) is `0`
  in V1; when multi-worker leasing lands, recovery keys on `(jobId, lease_epoch)` and leaves a job
  whose epoch already advanced alone.

## 7. Idempotency + side effects

- `enqueue` is idempotent per `(workflow, idempotency_key)` — the DDL's `UNIQUE (workflow,
  idempotency_key)` with `ON CONFLICT DO NOTHING` makes a duplicate enqueue return the existing
  `jobId`, never a second row.
- **Side-effect idempotency — content-addressed where the effect is content-addressed.** For a job
  whose durable side effect is itself content-addressed (a broker capture keyed by `contentId`/
  `captureId`, a note keyed by its identity hash), a retried attempt whose effect already landed
  re-derives the same content id and converges rather than double-applying — no per-attempt id is
  needed for those.
  - Idempotency of the *enqueue* is carried by `jobs.idempotency_key` (`UNIQUE (workflow,
    idempotency_key)`, `ON CONFLICT DO NOTHING`).
  - Idempotency of a *content-addressed side effect* is carried by that effect's own content hash in
    the effecting subsystem's row.

  > **OPEN (reconcile in Task 2.7 — do NOT resolve by editing the plan).** The authoritative plan
  > (Task 2.7) calls for *transactional side-effect-id recording*, and the current `0002_jobs`
  > `job_attempts` DDL (sqlite-data-dictionary.md §4) has no such column. Content-addressing covers
  > content-addressed effects, but it does **not** cover a **mutable** side effect (e.g. an
  > incrementing capture-observation counter): re-deriving a content id cannot prove whether the
  > increment committed before a crash, so such an effect needs a durable, transactionally-recorded
  > side-effect id to be crash-idempotent. Task 2.7 must either (a) confirm every Phase-2 job effect
  > is content-addressed (and record that as the reason the column is absent), or (b) add the
  > transactional side-effect-id the plan specifies. This contract does **not** override the plan;
  > the decision is deferred to the implementation task that exercises it. Tracked on the Phase-2
  > gate issue.

## 8. CLI mapping (registry rows, Phase 2)

All three mutating commands share the SSOT selector + batch protocol (design §"CLI contract"):
`[<jobId> | --all]` are **mutually exclusive** (both ⇒ exit `5`); bulk selection is deterministic,
ordered by `(next_run_at, jobId)`; each job is processed independently; and the result is one
`{ items, aggregate }` batch object (see `jobs-run`/`jobs-retry`/`jobs-cancel` schemas), never the
single-error envelope. A job that changes state mid-batch is `skipped:state-changed`, not an error.

- `jobs list` — read-only paginated list (`--state`, `--limit`/`--offset`), no lock; `total`/`hasMore`.
- `jobs run [<jobId> | --all]` — drain under `jobs-runner`; `--all` (default when neither given)
  drains every eligible job; per-job results + aggregate exit.
- `jobs retry [<jobId> | --all]` — re-queue `failed` jobs; **bare (no selector) ⇒ exit 5** (never a
  silent select-all).
- `jobs cancel [<jobId> | --all]` — cancel `pending`/`running` jobs; **bare ⇒ exit 5**.

## 9. Acceptance (implemented by Task 2.7 tests)

- Two concurrent `jobs run`: one drains, the other exits `2 locked:jobs-runner`; every job runs
  exactly once.
- Retry exhaustion drives `running → failed` at `maxAttempts`; a `permanent` class fails immediately.
- Startup recovery resets a dead runner's `running` jobs to `pending` idempotently, finalizing the
  interrupted `job_attempts` row as `failed`/`interrupted` without consuming the attempt budget.
- `jobs retry`/`jobs cancel` with no selector exit `5`; `<jobId>` and `--all` together exit `5`.

# Atlas — Recovery State Machine (normative contract)

**Status:** normative · **Owner task:** 0.1 (`task-0-1-recovery-state-machine`) ·
**Repo:** `21StarkCom/Atlas`

This document is the **single source of truth for crash recovery**. The run engine (Task 2.5) is
driven by it, and the generated failpoint suite (Task 4.11, `tools/gen-failpoints.ts`) is
**generated from the machine-readable [`stateTable`](#machine-readable-appendix-statetable) block**
at the end of this file. When the two disagree, this table wins — change the table, regenerate the
tests.

The normative workflow state set is fixed by the plan's **§2.5 Global Constraints** and is not
re-litigated here:

> `planned → patched → worktree-applied → agent-committed → [review-pending] → integrated →
> reindexed → finalized`; terminals `rejected`, `rolled-back`, `failed`, `cancelled` (recorded
> `failed@<checkpoint>` / `cancelled@<checkpoint>`).

## What this is

A per-state transition table. For **every** checkpoint of the normative state set it pins:

- **required artifacts + hashes** — what must durably exist for a run to legitimately *be* in this
  state (the gating precondition the single atomic write records);
- **the single atomic write** — the one durable mutation (§2.5: "single atomic write per transition
  with the gating artifacts/hashes") that *enters* this state, recorded in `agent_runs`;
- **legal next states** — including the `failed`/`cancelled` entry conditions reachable from here;
- **idempotency check** — how the reconciler recognises this state was already (partially) reached
  so re-driving is a no-op (end-to-end idempotency key is `(runId, seq)`, per §2.8);
- **retained artifacts** — what survives on exit / after cleanup;
- **worktree cleanup** — what happens to the run's git worktree;
- **audit emission** — which closed-set audit event (§2.5) the transition emits, if any;
- **recovery action** — what `reconcileInterruptedRuns` (Task 2.5) does if the process died in this
  state. **No state lacks a recovery action.**

## What this is not

- Not the DDL for `agent_runs` (Task 0.2 / migration `0001_core` owns columns + types).
- Not the cross-store audit write protocol — that ordering (intent → git append → ledger commit →
  backup/watermark) is **§2.8** and is *consumed* here, not duplicated. Where a transition "emits an
  audit event" it funnels through `finalizeLedgerWrite`; the `(runId, seq)` idempotency and the
  both-directions crash recovery between SQLite and the `refs/audit/runs` git stream are §2.8's, not
  restated per row.
- Not the observability matrix nor the lock contract (§2.5 lock scopes/order) — referenced, owned
  elsewhere.

## Model

A **run** is a single agent-driven mutation of the vault (capture in Phase 2; synthesis/integration
from Phase 4). It advances through **checkpoint** states, each recorded by exactly one atomic write
to its `agent_runs` row. It ends in exactly one **terminal** state. A crash at any point leaves the
run in its last durably-written checkpoint; `reconcileRunsOnStartup` drives it forward
(roll-forward) or to a `failed@<checkpoint>` terminal (give-up) deterministically from this table.

- **Checkpoints (progression):** `planned`, `patched`, `worktree-applied`, `agent-committed`,
  `review-pending`, `integrated`, `reindexed`. (`finalized` is the success terminal.) `review-pending`
  is entered only for Tier-3 runs — Tier-2 auto-commit runs skip it (§2.5 thresholds); it is a real
  state, not optional prose.
- **Terminals (state classes):** `finalized` (success), `rejected`, `rolled-back`, `failed`,
  `cancelled`. The `failed` and `cancelled` classes are **always recorded with the checkpoint they
  were reached from** — `failed@<checkpoint>` / `cancelled@<checkpoint>` — so the reconciler and the
  observability matrix can attribute them. Every checkpoint therefore has a corresponding
  `failed@<checkpoint>` and `cancelled@<checkpoint>` terminal.

### Cancellation vs. failure

- **`cancelled@<checkpoint>`** — cooperative abort via the run's `AbortSignal` (Task 2.5). The run
  had not yet committed anything irreversible past this checkpoint. Recovery is symmetric to failure
  from the same checkpoint but the audit event is `run.cancelled`.
- **`failed@<checkpoint>`** — an error (or a give-up decision by the reconciler, e.g. base ref moved
  under an applied-but-uncommitted worktree). Emits `run.failed`.

Both are only reachable from the checkpoint named in the suffix; both retain the run's ledger row and
audit trail, and both clean the worktree (nothing durable was integrated). A run that had already
reached `integrated`/`reindexed` cannot be `failed@`/`cancelled@` those checkpoints — forward
recovery finalizes it (an integrated mutation is durable in canonical git); the only way back out of
an integrated run is a **rollback**, which is **not a transition of the original run** but a
**separate, operator-initiated run** (`git rollback`, a privileged op) whose own terminal is
`rolled-back` and which is linked to the run it reverts via `rollbackOf` (see the `rolled-back`
terminal). It is never a crash-recovery outcome, so no checkpoint lists `rolled-back` as a legal
next state.

### Terminal state semantics (all terminals are true sinks)

Every terminal state — `finalized`, `rejected`, `rolled-back`, `failed@<checkpoint>`,
`cancelled@<checkpoint>` — has an **empty `nextStates`**. A run that reaches a terminal never
transitions again. Rollback of an already-`finalized` (or `integrated`/`reindexed`) run is modelled
as a **distinct run** with its own lifecycle, linked by `rollbackOf`; it does not re-open or mutate
the finalized run's row. This keeps the machine-readable `nextStates` consistent with terminal
semantics (a prior revision incorrectly listed `rolled-back` in `finalized.nextStates`).

### Terminal audit-write protocol (§2.8 is a prerequisite, not a follow-up)

Every terminal that emits an audit event (`rejected` → `run.rejected`, `rolled-back` →
`run.rolled_back`, `failed@<checkpoint>` → `run.failed`, `cancelled@<checkpoint>` → `run.cancelled`)
records that event through the **§2.8 ledger-write protocol**, and the terminal-state write is
**step 3 of that protocol**, not a bare `agent_runs.state=` update. The ordering is:

1. **§2.8 step 1 — intent (prerequisite).** Allocate the audit `seq`, compute
   `payloadHash = sha256(canonical(event))`, and durably write the `audit_intents` row
   `(runId, seq, payloadHash, event)`. This happens **before** the terminal-state CAS so a crash can
   never leave a run terminal-in-`agent_runs` with no intent, seq, or payload hash to replay from.
2. **§2.8 step 2 — git append.** Append the event to `refs/audit/runs` (idempotent on
   `(runId, seq)`).
3. **§2.8 step 3 — terminal CAS.** A **single SQLite transaction** that both sets
   `agent_runs.state='<terminal>'` **and** marks the `audit_intents` row for `(runId, seq)`
   completed. The two are inseparable — the terminal state is only durable together with the
   completed audit intent.
4. **§2.8 step 4 — backup/watermark.** Advance the backup watermark past `seq`.

The gating precondition (required artifacts) for every such terminal therefore includes the audit
intent `(runId, seq, payloadHash)`, and the idempotency check includes "the `audit_intents` row for
`(runId, seq)` exists with a matching `payloadHash`". Recovery for a crash between any two steps is
§2.8's replay keyed on `(runId, seq, payloadHash)`: re-run from the first incomplete step
idempotently (intent present ⇒ skip step 1; ref already carries `(runId, seq)` ⇒ skip step 2; etc.).

## Terminal audit cardinality

Per §2.5, each terminal audit event type occurs **exactly once per run**. The mapping is fixed:

| Terminal class | Audit event | Emitted when |
|---|---|---|
| `finalized` | `run.integrated` | integration completed and finalized (the run's single success terminal event; `run.planned`/`run.started` precede it non-terminally) |
| `rejected` | `run.rejected` | a `review-pending` run is rejected at review |
| `rolled-back` | `run.rolled_back` | an integrated run is explicitly rolled back (operator) |
| `failed` | `run.failed` | any `failed@<checkpoint>` terminal |
| `cancelled` | `run.cancelled` | any `cancelled@<checkpoint>` terminal |

`run.started` and `run.planned` are non-terminal progress events; `run.readonly` and `run.projection`
belong to read/projection runs outside this mutation lifecycle (referenced, not enumerated here).

---

## Per-state transition table

Every state below appears in the machine-readable `stateTable`. Prose here is explanatory; the JSON
is normative for the generator.

### Checkpoints

#### `planned`
- **Required artifacts + hashes:** `ChangePlan` persisted; `planHash = sha256(canonical(ChangePlan))`;
  `baseRef = sha256` of the canonical HEAD the plan was computed against.
- **Single atomic write:** `agent_runs` row upsert `state='planned'` with `planHash`, `baseRef`
  (from `null`/`run.started`).
- **Legal next states:** `patched`, `failed@planned`, `cancelled@planned`.
- **Idempotency check:** row exists with `state='planned'` and stored `planHash` matches recompute.
- **Retained artifacts:** `ChangePlan` (in `change_plans`).
- **Worktree cleanup:** none created yet.
- **Audit emission:** `run.planned` (non-terminal).
- **Recovery action:** no side effects past the row; re-drive planning is safe. Reconciler advances
  to `patched` if inputs unchanged, else fails `failed@planned` (reason `plan-stale`).

#### `patched`
- **Required artifacts + hashes:** materialized patch set; `patchHash = sha256(canonical(patches))`;
  `planHash` unchanged.
- **Single atomic write:** `state='patched'` with `patchHash` (gated on stored `planHash`).
- **Legal next states:** `worktree-applied`, `failed@patched`, `cancelled@patched`.
- **Idempotency check:** `state='patched'` and `patchHash` matches recompute from the stored plan.
- **Retained artifacts:** `ChangePlan`, patch set (`patches`, `patch_operations`).
- **Worktree cleanup:** none created yet.
- **Audit emission:** none (in-ledger progress only).
- **Recovery action:** patches are pure functions of the plan; recompute + compare `patchHash`.
  Match ⇒ advance; mismatch ⇒ `failed@patched` (reason `patch-nondeterministic`).

#### `worktree-applied`
- **Required artifacts + hashes:** a git worktree on the run's agent branch with the patch applied;
  `worktreePath`, `treeHash` of the applied tree, `baseRef` recorded.
- **Single atomic write:** `state='worktree-applied'` with `worktreePath`, `treeHash`
  (gated on `patchHash`).
- **Legal next states:** `agent-committed`, `failed@worktree-applied`, `cancelled@worktree-applied`.
- **Idempotency check:** worktree exists at `worktreePath` with working tree hashing to `treeHash`.
- **Retained artifacts:** plan, patches, the worktree (uncommitted).
- **Worktree cleanup:** on failure/cancel the orphaned worktree is removed (`git worktree remove
  --force` + prune).
- **Audit emission:** none.
- **Recovery action (the load-bearing case, per Task 2.5):** applied-uncommitted ⇒ **commit iff
  `planHash` + `baseRef` unmoved**, else `failed@worktree-applied` (reason `base-moved`). Orphaned
  worktree with no live run ⇒ clean.

#### `agent-committed`
- **Required artifacts + hashes:** a commit on the agent branch authored
  `Aryeh Stark <aryeh@21stark.com>`; `commitSha`; `treeHash` matches the applied tree.
- **Single atomic write:** `state='agent-committed'` with `commitSha` (gated on `treeHash`).
- **Legal next states:** `review-pending` (Tier-3), `integrated` (Tier-2 auto-commit),
  `failed@agent-committed`, `cancelled@agent-committed`.
- **Idempotency check:** `commitSha` exists on the agent branch and its tree hashes to `treeHash`.
- **Retained artifacts:** plan, patches, the agent-branch commit.
- **Worktree cleanup:** worktree may be removed after commit; the commit is the durable artifact.
- **Audit emission:** none (integration/finalization carries the terminal event).
- **Recovery action:** commit present ⇒ route by tier (Tier-2 ⇒ integrate; Tier-3 ⇒ leave for
  review). Commit missing but worktree present ⇒ treat as `worktree-applied` recovery.

#### `review-pending`
- **Required artifacts + hashes:** Tier-3 run parked for human/agent review; `commitSha` on the
  agent branch; review request recorded.
- **Single atomic write:** `state='review-pending'` (gated on `commitSha`).
- **Legal next states:** `integrated` (approved), `rejected`, `failed@review-pending`,
  `cancelled@review-pending`.
- **Idempotency check:** `state='review-pending'` with a live agent-branch `commitSha`.
- **Retained artifacts:** the agent-branch commit + review record (survives across restarts).
- **Worktree cleanup:** worktree removed; only the branch commit is retained.
- **Audit emission:** none until the terminal decision (`run.integrated` / `run.rejected`).
- **Recovery action:** **leave intact** (Task 2.5) — a review-pending run is never auto-advanced by
  the reconciler; it waits for `git approve`/`git reject`.

#### `integrated`
The `integrated` checkpoint records **three distinct effects** whose order and per-step crash cases
are pinned here (they are not conflated into one opaque write):

1. **Canonical integration effect (the durability point).** The broker fast-forwards / merges the
   agent-branch `commitSha` into the protected canonical ref, producing `canonicalSha`. **Idempotency
   evidence:** the canonical ref contains `canonicalSha` (and `canonicalSha`'s first parent is the
   pre-integration canonical HEAD / the merge includes `commitSha`). This is the one irreversible
   effect — once the canonical ref advanced, the mutation is durable and recovery is forward-only.
2. **Audit intent + append (§2.8 steps 1–2).** Allocate audit `seq`, compute
   `payloadHash = sha256(canonical(run.integrated event))`, write the `audit_intents` row
   `(runId, seq, payloadHash, "run.integrated")`, then append the event to `refs/audit/runs`.
3. **The `integrated` checkpoint (§2.8 step 3 CAS).** A single SQLite transaction that sets
   `state='integrated'` with `canonicalSha`, `seq` **and** marks the audit intent completed.

- **Required artifacts + hashes:** `canonicalSha` (canonical ref advanced); audit intent
  `(runId, seq, payloadHash)` for `run.integrated`.
- **Single atomic write:** the §2.8 step-3 CAS above — `state='integrated'` with `canonicalSha`,
  `seq`, audit intent completed (gated on `commitSha` and on the canonical ref already containing
  `canonicalSha`).
- **Legal next states:** `reindexed`. **No `failed@integrated` / `cancelled@integrated`** — a durable
  canonical mutation is not crash-reversible; forward recovery finalizes it. **No `rolled-back`** —
  rollback is a separate operator-initiated run (see terminal semantics above), not a transition of
  this run.
- **Idempotency check:** canonical ref contains `canonicalSha` **and** the `audit_intents` row for
  `(runId, seq)` exists with matching `payloadHash`.
- **Retained artifacts:** canonical commit, ledger rows, audit intent.
- **Worktree cleanup:** worktree removed (integration done from the branch commit).
- **Audit emission:** `run.integrated` via `finalizeLedgerWrite` (§2.8 ordering).
- **Recovery action (per-step, keyed on `(runId, seq, payloadHash)`):**
  - **Crash after canonical advancement, before the audit intent:** the canonical ref carries
    `canonicalSha` but no `audit_intents` row exists ⇒ the mutation is durable and must be
    audited — allocate `seq`/`payloadHash`, write the intent, append to `refs/audit/runs`, run the
    step-3 CAS, then continue to `reindexed`/`finalized`.
  - **Crash after intent, before git append:** intent present, ref lacks `(runId, seq)` ⇒ append,
    then step-3 CAS, then continue.
  - **Crash after append, before the `integrated` checkpoint CAS:** ref carries the event, intent not
    yet completed, `state` still `agent-committed` ⇒ run the step-3 CAS (idempotent on
    `(runId, seq)`), then continue.
  - **Integrated-but-unfinalized (state already `integrated`):** advance to `reindexed`/`finalized`
    idempotently on `(runId, seq)`; backup/watermark (§2.8 step 4) is completed at `finalized`.

#### `reindexed`
- **Required artifacts + hashes:** vault-projection updated for the integrated mutation — SQLite
  projection rows + LanceDB generation advanced; `indexGeneration` recorded.
- **Single atomic write:** `state='reindexed'` with `indexGeneration` (gated on `canonicalSha`).
- **Legal next states:** `finalized`. **No `rolled-back`** — rollback is a separate
  operator-initiated run, not a transition of this run. No `failed@reindexed` — the
  projection is rebuildable from canonical (`db rebuild` / `index rebuild`); a reindex crash recovers
  forward by re-running the idempotent projection.
- **Idempotency check:** projection reflects `canonicalSha` at `indexGeneration`.
- **Retained artifacts:** canonical commit, ledger rows, projection.
- **Worktree cleanup:** none (already removed at `integrated`).
- **Audit emission:** none (projection is derived; `run.projection` covers standalone rebuilds, not
  the in-lifecycle reindex).
- **Recovery action:** re-run the projection step (idempotent; derived state is always rebuildable
  from canonical Markdown), then advance to `finalized`.

### Terminals

#### `finalized`
- **Required artifacts + hashes:** run fully complete — `canonicalSha`, `indexGeneration`, audit
  `seq` done, backup watermark covering `seq`.
- **Single atomic write:** `state='finalized'` (gated on `reindexed` + §2.8 step 4 success).
- **Legal next states:** — (success terminal; empty). Rollback of a finalized run is a **separate**
  operator-initiated run linked by `rollbackOf`, not a transition out of `finalized`.
- **Idempotency check:** `state='finalized'` with `backup_watermark.seq >=` the run's `seq`.
- **Retained artifacts:** everything (canonical commit, ledger, projection, backup).
- **Worktree cleanup:** already clean.
- **Audit emission:** `run.integrated` is the terminal success event (emitted at `integrated`, not
  re-emitted here — exactly-once per §2.5).
- **Recovery action:** none needed; if `state='finalized'` the run is done. Reconciler treats it as a
  no-op.

#### `rejected`
- **Required artifacts + hashes:** a `review-pending` run declined; `commitSha` retained on the agent
  branch (not integrated); rejection reason; audit intent `(runId, seq, payloadHash)` for
  `run.rejected` (§2.8 step 1 — written **before** the terminal CAS).
- **Single atomic write:** §2.8 step-3 CAS — a single SQLite transaction that sets `state='rejected'`
  **and** completes the `audit_intents` row for `(runId, seq)` (gated on prior `review-pending` and
  on the step-1 intent + step-2 git append having preceded it).
- **Legal next states:** — (terminal).
- **Idempotency check:** `state='rejected'` with the recorded `commitSha` **and** the `audit_intents`
  row for `(runId, seq)` present with matching `payloadHash`.
- **Retained artifacts:** the agent-branch commit (kept for audit / possible re-plan) + ledger row +
  audit intent.
- **Worktree cleanup:** worktree removed; branch commit retained.
- **Audit emission:** `run.rejected` (exactly once).
- **Recovery action:** re-run the §2.8 protocol from the first incomplete step keyed on
  `(runId, seq, payloadHash)` — intent present ⇒ skip step 1; ref already carries `(runId, seq)` ⇒
  skip step 2; then the step-3 CAS. Nothing to roll forward.

#### `rolled-back`
`rolled-back` is the terminal of a **distinct, operator-initiated run** that reverts a previously
finalized/integrated run — **not** a transition of that original run. The reverting run carries
`rollbackOf = <original runId>` linking the two; the original run's row stays `finalized`.

- **Required artifacts + hashes:** an **integrated** run explicitly reverted by an operator
  (`git rollback`, privileged); `revertSha` on canonical; original `canonicalSha` recorded;
  `rollbackOf` (the reverted run's id); audit intent `(runId, seq, payloadHash)` for
  `run.rolled_back` (§2.8 step 1, before the terminal CAS).
- **Single atomic write:** §2.8 step-3 CAS — a single SQLite transaction that sets
  `state='rolled-back'` with `revertSha`, `rollbackOf` **and** completes the `audit_intents` row for
  `(runId, seq)` (gated on the reverted run being `integrated`/`reindexed`/`finalized`, on the
  canonical ref already containing `revertSha`, and on the step-1 intent + step-2 append preceding).
- **Legal next states:** — (terminal).
- **Idempotency check:** canonical ref contains `revertSha` reverting `canonicalSha` **and** the
  `audit_intents` row for `(runId, seq)` is present with matching `payloadHash`.
- **Retained artifacts:** both the original and the revert commit (git history is append-only);
  ledger row; audit intent.
- **Worktree cleanup:** none.
- **Audit emission:** `run.rolled_back` (exactly once).
- **Recovery action:** rollback is an operator-initiated run in its own right; on crash mid-rollback,
  re-run the §2.8 protocol from the first incomplete step keyed on `(runId, seq, payloadHash)` and
  re-drive the projection. Never auto-initiated by the reconciler.

#### `failed`
- **Required artifacts + hashes:** the class terminal for every `failed@<checkpoint>`; carries
  `failedAt` (the checkpoint) and a `reason`; audit intent `(runId, seq, payloadHash)` for
  `run.failed` (§2.8 step 1, before the terminal CAS).
- **Single atomic write:** §2.8 step-3 CAS — a single SQLite transaction that sets
  `state='failed@<checkpoint>'` with `failedAt`, `reason` **and** completes the `audit_intents` row
  for `(runId, seq)` (the step-1 intent + step-2 append precede it).
- **Legal next states:** — (terminal).
- **Idempotency check:** `state` matches `failed@<checkpoint>` with the recorded `reason` **and** the
  `audit_intents` row for `(runId, seq)` present with matching `payloadHash`.
- **Retained artifacts:** ledger row + audit intent + whatever pre-checkpoint artifacts existed
  (never an integrated canonical mutation — failure is only reachable pre-`integrated`).
- **Worktree cleanup:** any orphaned worktree removed.
- **Audit emission:** `run.failed` (exactly once).
- **Recovery action:** terminal — re-run the §2.8 protocol from the first incomplete step keyed on
  `(runId, seq, payloadHash)` and clean any orphaned worktree. Per-checkpoint entry conditions are
  the `failed@<checkpoint>` rows below.

#### `cancelled`
- **Required artifacts + hashes:** the class terminal for every `cancelled@<checkpoint>`; carries
  `cancelledAt` (the checkpoint); audit intent `(runId, seq, payloadHash)` for `run.cancelled`
  (§2.8 step 1, before the terminal CAS).
- **Single atomic write:** §2.8 step-3 CAS — a single SQLite transaction that sets
  `state='cancelled@<checkpoint>'` with `cancelledAt` **and** completes the `audit_intents` row for
  `(runId, seq)` (the step-1 intent + step-2 append precede it).
- **Legal next states:** — (terminal).
- **Idempotency check:** `state` matches `cancelled@<checkpoint>` **and** the `audit_intents` row for
  `(runId, seq)` present with matching `payloadHash`.
- **Retained artifacts:** ledger row + audit intent + pre-checkpoint artifacts; no integrated
  canonical mutation.
- **Worktree cleanup:** any orphaned worktree removed.
- **Audit emission:** `run.cancelled` (exactly once).
- **Recovery action:** terminal — re-run the §2.8 protocol from the first incomplete step keyed on
  `(runId, seq, payloadHash)` and clean any orphaned worktree.

### Checkpoint-suffixed terminals

Each progression checkpoint has a `failed@<checkpoint>` and a `cancelled@<checkpoint>` terminal.
They share the class semantics of `failed`/`cancelled` above; the suffix records **from which
checkpoint** the run terminated, which is what the reconciler and observability matrix attribute on.
Entry conditions:

- `failed@planned` / `cancelled@planned` — before any patch materialized.
- `failed@patched` / `cancelled@patched` — patches materialized, no worktree.
- `failed@worktree-applied` / `cancelled@worktree-applied` — worktree applied, uncommitted
  (`base-moved` is the canonical reconciler give-up reason here).
- `failed@agent-committed` / `cancelled@agent-committed` — commit on the agent branch, not integrated.
- `failed@review-pending` / `cancelled@review-pending` — parked for review, terminated before an
  integrate/reject decision (distinct from the `rejected` terminal, which is an explicit review
  decision).

The `integrated`, `reindexed`, and `finalized` checkpoints have **no** `failed@`/`cancelled@` forms —
past integration the mutation is durable and recovery is forward-only (or an explicit `rolled-back`).

---

## Machine-readable appendix: `stateTable`

The failpoint generator (Task 4.11, `tools/gen-failpoints.ts`) parses the single fenced block below.
Its opening fence info string is exactly `json stateTable`; `contract-lint.test.ts` asserts it parses
and covers every state in the §2.5 set (plus every `failed@`/`cancelled@` checkpoint terminal), and
that no state lacks a `recoveryAction`.

```json stateTable
{
  "version": 1,
  "source": "docs/plans/atlas-v1-implementation-2026-07-12.md#25-global-constraints",
  "checkpoints": [
    "planned",
    "patched",
    "worktree-applied",
    "agent-committed",
    "review-pending",
    "integrated",
    "reindexed"
  ],
  "terminals": ["finalized", "rejected", "rolled-back", "failed", "cancelled"],
  "auditEvents": {
    "finalized": "run.integrated",
    "rejected": "run.rejected",
    "rolled-back": "run.rolled_back",
    "failed": "run.failed",
    "cancelled": "run.cancelled"
  },
  "states": [
    {
      "state": "planned",
      "kind": "checkpoint",
      "requiredArtifacts": [
        { "artifact": "ChangePlan", "hash": "planHash=sha256(canonical(ChangePlan))" },
        { "artifact": "baseRef", "hash": "sha256(canonical-HEAD)" }
      ],
      "atomicWrite": "agent_runs.state='planned' with planHash,baseRef",
      "nextStates": ["patched", "failed@planned", "cancelled@planned"],
      "idempotencyCheck": "row state='planned' and stored planHash matches recompute",
      "retainedArtifacts": ["ChangePlan"],
      "worktreeCleanup": "none (not yet created)",
      "auditEmission": "run.planned",
      "recoveryAction": "no side effects past the row; advance to patched if inputs unchanged else failed@planned (reason plan-stale)"
    },
    {
      "state": "patched",
      "kind": "checkpoint",
      "requiredArtifacts": [
        { "artifact": "patch set", "hash": "patchHash=sha256(canonical(patches))" }
      ],
      "atomicWrite": "agent_runs.state='patched' with patchHash (gated on planHash)",
      "nextStates": ["worktree-applied", "failed@patched", "cancelled@patched"],
      "idempotencyCheck": "state='patched' and patchHash matches recompute from stored plan",
      "retainedArtifacts": ["ChangePlan", "patches", "patch_operations"],
      "worktreeCleanup": "none (not yet created)",
      "auditEmission": null,
      "recoveryAction": "recompute patches from plan; match patchHash advance, else failed@patched (reason patch-nondeterministic)"
    },
    {
      "state": "worktree-applied",
      "kind": "checkpoint",
      "requiredArtifacts": [
        { "artifact": "worktree on agent branch", "hash": "treeHash of applied tree" },
        { "artifact": "worktreePath", "hash": null },
        { "artifact": "baseRef", "hash": "sha256(canonical-HEAD)" }
      ],
      "atomicWrite": "agent_runs.state='worktree-applied' with worktreePath,treeHash (gated on patchHash)",
      "nextStates": ["agent-committed", "failed@worktree-applied", "cancelled@worktree-applied"],
      "idempotencyCheck": "worktree exists at worktreePath hashing to treeHash",
      "retainedArtifacts": ["ChangePlan", "patches", "worktree (uncommitted)"],
      "worktreeCleanup": "on failure/cancel remove orphaned worktree (git worktree remove --force + prune)",
      "auditEmission": null,
      "recoveryAction": "applied-uncommitted: commit iff planHash+baseRef unmoved, else failed@worktree-applied (reason base-moved); orphaned worktree with no live run: clean"
    },
    {
      "state": "agent-committed",
      "kind": "checkpoint",
      "requiredArtifacts": [
        { "artifact": "agent-branch commit (author Aryeh Stark <aryeh@21stark.com>)", "hash": "commitSha" },
        { "artifact": "applied tree", "hash": "treeHash" }
      ],
      "atomicWrite": "agent_runs.state='agent-committed' with commitSha (gated on treeHash)",
      "nextStates": ["review-pending", "integrated", "failed@agent-committed", "cancelled@agent-committed"],
      "idempotencyCheck": "commitSha exists on agent branch and its tree hashes to treeHash",
      "retainedArtifacts": ["ChangePlan", "patches", "agent-branch commit"],
      "worktreeCleanup": "worktree may be removed after commit; the commit is the durable artifact",
      "auditEmission": null,
      "recoveryAction": "commit present: route by tier (Tier-2 integrate; Tier-3 leave for review); commit missing but worktree present: recover as worktree-applied"
    },
    {
      "state": "review-pending",
      "kind": "checkpoint",
      "requiredArtifacts": [
        { "artifact": "agent-branch commit", "hash": "commitSha" },
        { "artifact": "review request record", "hash": null }
      ],
      "atomicWrite": "agent_runs.state='review-pending' (gated on commitSha)",
      "nextStates": ["integrated", "rejected", "failed@review-pending", "cancelled@review-pending"],
      "idempotencyCheck": "state='review-pending' with a live agent-branch commitSha",
      "retainedArtifacts": ["agent-branch commit", "review record"],
      "worktreeCleanup": "worktree removed; only the branch commit is retained",
      "auditEmission": null,
      "recoveryAction": "leave intact — never auto-advanced by the reconciler; waits for git approve/git reject"
    },
    {
      "state": "integrated",
      "kind": "checkpoint",
      "requiredArtifacts": [
        { "artifact": "canonical ref advanced (broker ff/merge) — durability point", "hash": "canonicalSha" },
        { "artifact": "audit intent (§2.8 step 1) for run.integrated", "hash": "(runId, seq, payloadHash)" }
      ],
      "atomicWrite": "§2.8 step-3 CAS: single SQLite tx setting state='integrated' with canonicalSha,seq AND completing the audit intent for (runId, seq); gated on commitSha and on the canonical ref already containing canonicalSha",
      "nextStates": ["reindexed"],
      "idempotencyCheck": "canonical ref contains canonicalSha AND audit_intents row for (runId, seq) exists with matching payloadHash",
      "retainedArtifacts": ["canonical commit", "ledger rows", "audit intent"],
      "worktreeCleanup": "worktree removed (integration done from the branch commit)",
      "auditEmission": "run.integrated",
      "recoveryAction": "per-step, keyed on (runId, seq, payloadHash): (a) canonical advanced but no intent -> allocate seq/payloadHash, write intent, append, step-3 CAS; (b) intent present, ref lacks (runId, seq) -> append then step-3 CAS; (c) ref has event, state still agent-committed -> step-3 CAS; (d) state already integrated -> advance to reindexed/finalized idempotently on (runId, seq)"
    },
    {
      "state": "reindexed",
      "kind": "checkpoint",
      "requiredArtifacts": [
        { "artifact": "SQLite projection + LanceDB generation advanced", "hash": "indexGeneration" }
      ],
      "atomicWrite": "agent_runs.state='reindexed' with indexGeneration (gated on canonicalSha)",
      "nextStates": ["finalized"],
      "idempotencyCheck": "projection reflects canonicalSha at indexGeneration",
      "retainedArtifacts": ["canonical commit", "ledger rows", "projection"],
      "worktreeCleanup": "none (already removed at integrated)",
      "auditEmission": null,
      "recoveryAction": "re-run the idempotent projection step (derived state is rebuildable from canonical Markdown), then advance to finalized"
    },
    {
      "state": "finalized",
      "kind": "terminal",
      "requiredArtifacts": [
        { "artifact": "canonicalSha", "hash": "canonicalSha" },
        { "artifact": "backup watermark covering seq", "hash": "backup_watermark.seq>=run.seq" }
      ],
      "atomicWrite": "agent_runs.state='finalized' (gated on reindexed + §2.8 step 4 backup/watermark success)",
      "nextStates": [],
      "idempotencyCheck": "state='finalized' with backup_watermark.seq >= run.seq",
      "retainedArtifacts": ["canonical commit", "ledger", "projection", "backup"],
      "worktreeCleanup": "already clean",
      "auditEmission": "run.integrated",
      "recoveryAction": "none — run is done; reconciler treats as a no-op. Rollback of a finalized run is a separate operator-initiated run linked by rollbackOf, not a transition out of finalized"
    },
    {
      "state": "rejected",
      "kind": "terminal",
      "requiredArtifacts": [
        { "artifact": "retained agent-branch commit (not integrated)", "hash": "commitSha" },
        { "artifact": "rejection reason", "hash": null },
        { "artifact": "audit intent (§2.8 step 1) for run.rejected", "hash": "(runId, seq, payloadHash)" }
      ],
      "atomicWrite": "§2.8 step-3 CAS: single SQLite tx setting state='rejected' AND completing the audit intent for (runId, seq); gated on prior review-pending and on the step-1 intent + step-2 git append preceding it",
      "nextStates": [],
      "idempotencyCheck": "state='rejected' with the recorded commitSha AND audit_intents row for (runId, seq) present with matching payloadHash",
      "retainedArtifacts": ["agent-branch commit", "ledger row", "audit intent"],
      "worktreeCleanup": "worktree removed; branch commit retained",
      "auditEmission": "run.rejected",
      "recoveryAction": "re-run the §2.8 protocol from the first incomplete step keyed on (runId, seq, payloadHash) (intent present -> skip step 1; ref carries (runId, seq) -> skip step 2; then step-3 CAS); nothing to roll forward"
    },
    {
      "state": "rolled-back",
      "kind": "terminal",
      "requiredArtifacts": [
        { "artifact": "revert commit on canonical", "hash": "revertSha" },
        { "artifact": "original integrated commit", "hash": "canonicalSha" },
        { "artifact": "rollbackOf (reverted run id) — this is a separate operator-initiated run, not a transition of the reverted run", "hash": "rollbackOf" },
        { "artifact": "audit intent (§2.8 step 1) for run.rolled_back", "hash": "(runId, seq, payloadHash)" }
      ],
      "atomicWrite": "§2.8 step-3 CAS: single SQLite tx setting state='rolled-back' with revertSha,rollbackOf AND completing the audit intent for (runId, seq); gated on the reverted run being integrated/reindexed/finalized, on the canonical ref already containing revertSha, and on the step-1 intent + step-2 append preceding it",
      "nextStates": [],
      "idempotencyCheck": "canonical ref contains revertSha reverting canonicalSha AND audit_intents row for (runId, seq) present with matching payloadHash",
      "retainedArtifacts": ["original commit", "revert commit", "ledger row", "audit intent"],
      "worktreeCleanup": "none",
      "auditEmission": "run.rolled_back",
      "recoveryAction": "operator-initiated only; on crash mid-rollback re-run the §2.8 protocol from the first incomplete step keyed on (runId, seq, payloadHash) and re-drive the projection; never auto-initiated by the reconciler"
    },
    {
      "state": "failed",
      "kind": "terminal",
      "requiredArtifacts": [
        { "artifact": "failedAt checkpoint + reason", "hash": null },
        { "artifact": "audit intent (§2.8 step 1) for run.failed", "hash": "(runId, seq, payloadHash)" }
      ],
      "atomicWrite": "§2.8 step-3 CAS: single SQLite tx setting state='failed@<checkpoint>' with failedAt,reason AND completing the audit intent for (runId, seq); the step-1 intent + step-2 append precede it",
      "nextStates": [],
      "idempotencyCheck": "state matches failed@<checkpoint> with recorded reason AND audit_intents row for (runId, seq) present with matching payloadHash",
      "retainedArtifacts": ["ledger row", "audit intent", "pre-checkpoint artifacts (never an integrated mutation)"],
      "worktreeCleanup": "any orphaned worktree removed",
      "auditEmission": "run.failed",
      "recoveryAction": "terminal — re-run the §2.8 protocol from the first incomplete step keyed on (runId, seq, payloadHash) and clean any orphaned worktree"
    },
    {
      "state": "cancelled",
      "kind": "terminal",
      "requiredArtifacts": [
        { "artifact": "cancelledAt checkpoint", "hash": null },
        { "artifact": "audit intent (§2.8 step 1) for run.cancelled", "hash": "(runId, seq, payloadHash)" }
      ],
      "atomicWrite": "§2.8 step-3 CAS: single SQLite tx setting state='cancelled@<checkpoint>' with cancelledAt AND completing the audit intent for (runId, seq); the step-1 intent + step-2 append precede it",
      "nextStates": [],
      "idempotencyCheck": "state matches cancelled@<checkpoint> AND audit_intents row for (runId, seq) present with matching payloadHash",
      "retainedArtifacts": ["ledger row", "audit intent", "pre-checkpoint artifacts (no integrated mutation)"],
      "worktreeCleanup": "any orphaned worktree removed",
      "auditEmission": "run.cancelled",
      "recoveryAction": "terminal — re-run the §2.8 protocol from the first incomplete step keyed on (runId, seq, payloadHash) and clean any orphaned worktree"
    },
    {
      "state": "failed@planned",
      "kind": "terminal",
      "checkpoint": "planned",
      "requiredArtifacts": [
        { "artifact": "failedAt=planned + reason", "hash": null },
        { "artifact": "audit intent (§2.8 step 1) for run.failed", "hash": "(runId, seq, payloadHash)" }
      ],
      "atomicWrite": "§2.8 step-3 CAS: single SQLite tx setting state='failed@planned' with reason AND completing the audit intent for (runId, seq); step-1 intent + step-2 append precede it",
      "nextStates": [],
      "idempotencyCheck": "state='failed@planned' AND audit_intents row for (runId, seq) present with matching payloadHash",
      "retainedArtifacts": ["ChangePlan", "ledger row", "audit intent"],
      "worktreeCleanup": "none (no worktree at planned)",
      "auditEmission": "run.failed",
      "recoveryAction": "terminal — re-run the §2.8 protocol from the first incomplete step keyed on (runId, seq, payloadHash); no worktree to clean"
    },
    {
      "state": "cancelled@planned",
      "kind": "terminal",
      "checkpoint": "planned",
      "requiredArtifacts": [
        { "artifact": "cancelledAt=planned", "hash": null },
        { "artifact": "audit intent (§2.8 step 1) for run.cancelled", "hash": "(runId, seq, payloadHash)" }
      ],
      "atomicWrite": "§2.8 step-3 CAS: single SQLite tx setting state='cancelled@planned' AND completing the audit intent for (runId, seq); step-1 intent + step-2 append precede it",
      "nextStates": [],
      "idempotencyCheck": "state='cancelled@planned' AND audit_intents row for (runId, seq) present with matching payloadHash",
      "retainedArtifacts": ["ChangePlan", "ledger row", "audit intent"],
      "worktreeCleanup": "none (no worktree at planned)",
      "auditEmission": "run.cancelled",
      "recoveryAction": "terminal — re-run the §2.8 protocol from the first incomplete step keyed on (runId, seq, payloadHash); no worktree to clean"
    },
    {
      "state": "failed@patched",
      "kind": "terminal",
      "checkpoint": "patched",
      "requiredArtifacts": [
        { "artifact": "failedAt=patched + reason", "hash": null },
        { "artifact": "audit intent (§2.8 step 1) for run.failed", "hash": "(runId, seq, payloadHash)" }
      ],
      "atomicWrite": "§2.8 step-3 CAS: single SQLite tx setting state='failed@patched' with reason AND completing the audit intent for (runId, seq); step-1 intent + step-2 append precede it",
      "nextStates": [],
      "idempotencyCheck": "state='failed@patched' AND audit_intents row for (runId, seq) present with matching payloadHash",
      "retainedArtifacts": ["ChangePlan", "patches", "ledger row", "audit intent"],
      "worktreeCleanup": "none (no worktree at patched)",
      "auditEmission": "run.failed",
      "recoveryAction": "terminal — re-run the §2.8 protocol from the first incomplete step keyed on (runId, seq, payloadHash); no worktree to clean"
    },
    {
      "state": "cancelled@patched",
      "kind": "terminal",
      "checkpoint": "patched",
      "requiredArtifacts": [
        { "artifact": "cancelledAt=patched", "hash": null },
        { "artifact": "audit intent (§2.8 step 1) for run.cancelled", "hash": "(runId, seq, payloadHash)" }
      ],
      "atomicWrite": "§2.8 step-3 CAS: single SQLite tx setting state='cancelled@patched' AND completing the audit intent for (runId, seq); step-1 intent + step-2 append precede it",
      "nextStates": [],
      "idempotencyCheck": "state='cancelled@patched' AND audit_intents row for (runId, seq) present with matching payloadHash",
      "retainedArtifacts": ["ChangePlan", "patches", "ledger row", "audit intent"],
      "worktreeCleanup": "none (no worktree at patched)",
      "auditEmission": "run.cancelled",
      "recoveryAction": "terminal — re-run the §2.8 protocol from the first incomplete step keyed on (runId, seq, payloadHash); no worktree to clean"
    },
    {
      "state": "failed@worktree-applied",
      "kind": "terminal",
      "checkpoint": "worktree-applied",
      "requiredArtifacts": [
        { "artifact": "failedAt=worktree-applied + reason (canonical: base-moved)", "hash": null },
        { "artifact": "audit intent (§2.8 step 1) for run.failed", "hash": "(runId, seq, payloadHash)" }
      ],
      "atomicWrite": "§2.8 step-3 CAS: single SQLite tx setting state='failed@worktree-applied' with reason AND completing the audit intent for (runId, seq); step-1 intent + step-2 append precede it",
      "nextStates": [],
      "idempotencyCheck": "state='failed@worktree-applied' AND audit_intents row for (runId, seq) present with matching payloadHash",
      "retainedArtifacts": ["ChangePlan", "patches", "ledger row", "audit intent"],
      "worktreeCleanup": "orphaned worktree removed (git worktree remove --force + prune)",
      "auditEmission": "run.failed",
      "recoveryAction": "terminal — re-run the §2.8 protocol from the first incomplete step keyed on (runId, seq, payloadHash) and clean the orphaned worktree"
    },
    {
      "state": "cancelled@worktree-applied",
      "kind": "terminal",
      "checkpoint": "worktree-applied",
      "requiredArtifacts": [
        { "artifact": "cancelledAt=worktree-applied", "hash": null },
        { "artifact": "audit intent (§2.8 step 1) for run.cancelled", "hash": "(runId, seq, payloadHash)" }
      ],
      "atomicWrite": "§2.8 step-3 CAS: single SQLite tx setting state='cancelled@worktree-applied' AND completing the audit intent for (runId, seq); step-1 intent + step-2 append precede it",
      "nextStates": [],
      "idempotencyCheck": "state='cancelled@worktree-applied' AND audit_intents row for (runId, seq) present with matching payloadHash",
      "retainedArtifacts": ["ChangePlan", "patches", "ledger row", "audit intent"],
      "worktreeCleanup": "orphaned worktree removed (git worktree remove --force + prune)",
      "auditEmission": "run.cancelled",
      "recoveryAction": "terminal — re-run the §2.8 protocol from the first incomplete step keyed on (runId, seq, payloadHash) and clean the orphaned worktree"
    },
    {
      "state": "failed@agent-committed",
      "kind": "terminal",
      "checkpoint": "agent-committed",
      "requiredArtifacts": [
        { "artifact": "failedAt=agent-committed + reason", "hash": "commitSha (retained, not integrated)" },
        { "artifact": "audit intent (§2.8 step 1) for run.failed", "hash": "(runId, seq, payloadHash)" }
      ],
      "atomicWrite": "§2.8 step-3 CAS: single SQLite tx setting state='failed@agent-committed' with reason AND completing the audit intent for (runId, seq); step-1 intent + step-2 append precede it",
      "nextStates": [],
      "idempotencyCheck": "state='failed@agent-committed' AND audit_intents row for (runId, seq) present with matching payloadHash",
      "retainedArtifacts": ["agent-branch commit", "ledger row", "audit intent"],
      "worktreeCleanup": "any orphaned worktree removed; the branch commit is retained",
      "auditEmission": "run.failed",
      "recoveryAction": "terminal — re-run the §2.8 protocol from the first incomplete step keyed on (runId, seq, payloadHash) and clean any orphaned worktree"
    },
    {
      "state": "cancelled@agent-committed",
      "kind": "terminal",
      "checkpoint": "agent-committed",
      "requiredArtifacts": [
        { "artifact": "cancelledAt=agent-committed", "hash": "commitSha (retained, not integrated)" },
        { "artifact": "audit intent (§2.8 step 1) for run.cancelled", "hash": "(runId, seq, payloadHash)" }
      ],
      "atomicWrite": "§2.8 step-3 CAS: single SQLite tx setting state='cancelled@agent-committed' AND completing the audit intent for (runId, seq); step-1 intent + step-2 append precede it",
      "nextStates": [],
      "idempotencyCheck": "state='cancelled@agent-committed' AND audit_intents row for (runId, seq) present with matching payloadHash",
      "retainedArtifacts": ["agent-branch commit", "ledger row", "audit intent"],
      "worktreeCleanup": "any orphaned worktree removed; the branch commit is retained",
      "auditEmission": "run.cancelled",
      "recoveryAction": "terminal — re-run the §2.8 protocol from the first incomplete step keyed on (runId, seq, payloadHash) and clean any orphaned worktree"
    },
    {
      "state": "failed@review-pending",
      "kind": "terminal",
      "checkpoint": "review-pending",
      "requiredArtifacts": [
        { "artifact": "failedAt=review-pending + reason", "hash": "commitSha (retained)" },
        { "artifact": "audit intent (§2.8 step 1) for run.failed", "hash": "(runId, seq, payloadHash)" }
      ],
      "atomicWrite": "§2.8 step-3 CAS: single SQLite tx setting state='failed@review-pending' with reason AND completing the audit intent for (runId, seq); step-1 intent + step-2 append precede it",
      "nextStates": [],
      "idempotencyCheck": "state='failed@review-pending' AND audit_intents row for (runId, seq) present with matching payloadHash",
      "retainedArtifacts": ["agent-branch commit", "review record", "ledger row", "audit intent"],
      "worktreeCleanup": "worktree already removed at review-pending; nothing to clean",
      "auditEmission": "run.failed",
      "recoveryAction": "terminal — re-run the §2.8 protocol from the first incomplete step keyed on (runId, seq, payloadHash); distinct from the rejected terminal (an explicit review decision)"
    },
    {
      "state": "cancelled@review-pending",
      "kind": "terminal",
      "checkpoint": "review-pending",
      "requiredArtifacts": [
        { "artifact": "cancelledAt=review-pending", "hash": "commitSha (retained)" },
        { "artifact": "audit intent (§2.8 step 1) for run.cancelled", "hash": "(runId, seq, payloadHash)" }
      ],
      "atomicWrite": "§2.8 step-3 CAS: single SQLite tx setting state='cancelled@review-pending' AND completing the audit intent for (runId, seq); step-1 intent + step-2 append precede it",
      "nextStates": [],
      "idempotencyCheck": "state='cancelled@review-pending' AND audit_intents row for (runId, seq) present with matching payloadHash",
      "retainedArtifacts": ["agent-branch commit", "review record", "ledger row", "audit intent"],
      "worktreeCleanup": "worktree already removed at review-pending; nothing to clean",
      "auditEmission": "run.cancelled",
      "recoveryAction": "terminal — re-run the §2.8 protocol from the first incomplete step keyed on (runId, seq, payloadHash); distinct from the rejected terminal (an explicit review decision)"
    }
  ]
}
```

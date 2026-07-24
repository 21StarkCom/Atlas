# Workflow / risk contract

Normative contract for the Phase-4 mutation workflows. It fixes: the **per-type mutation-policy
table** (the deterministic inputs `policies` consumes — Task 4.3), the **risk-tier definitions**, and
the **CAS / refresh semantics** of tiered integration. It **conforms to the plan** (§2.5, §2.6) and
consumes the upstream contracts `recovery-state-machine.md` (0.1, the state machine) and
`security-broker-contract.md` (0.3, privileged authorization) as the single source of truth — it does
not restate their enumerations.

The Tier-2 numeric thresholds live in `acceptance-thresholds.md` §workflow (0.8 / 50 / 3) and are
**consumed from config**, never restated numerically here.

---

## §tiers — risk-tier definitions

Risk tier is `effectiveRisk` — computed **deterministically** by `policies.effectiveRisk` from
`operation type × target note type × scope × config` (Task 4.3). The model's `proposedRisk` is
advisory only and **never gates** (a grep-guard test asserts no other module reads `proposedRisk` for
control flow).

### Broker-authoritative recomputation (the CLI tier is advisory to the broker)

The CLI's `policies.effectiveRisk`, the validator's `tier2Eligible`, the confidence inputs, and the
evidence/trust state that the CLI carries in the run manifest are **inputs the broker does not
trust**. Before **any** protected-ref advancement (`advanceProtectedRef`, `integrateSourceCapture`,
`git approve`'s FF-CAS, or `purge`'s §12.2 replacement), the **broker independently re-derives from
the candidate tree** — not from the manifest — the four gating facts:

1. **risk** — re-parses the tree, recomputes `effectiveRisk` from `operation × target type × scope ×
   config`, and matches it against `intendedEffect.changePlanDigest` / the manifest's claimed tier;
2. **policy** — re-evaluates the §mutation-policy cell for every op × target type in the plan (a
   `review`/`immutable`/`reserved`/`append-only`-violating op cannot be relabeled `auto` by the CLI);
3. **trust** — re-reads each contributing source's trust level from `refs/trust/ledger` (not the
   manifest), rejecting any untrusted-derived Tier-2 claim;
4. **evidence validity** — re-checks that every anchored evidence item is `valid` (never
   `stale`/`pending`/`failed`) against canonical Markdown.

If **any** re-derived fact **differs** from what the manifest asserts, the broker **refuses** the
advancement and the run **escalates to Tier-3** (`review-pending`, exit `6`) — a CLI that under-reports
risk, forges `tier2Eligible`, backdates trust, or claims valid evidence can never obtain a
fast-forward. The mismatch is surfaced with the broker's `authz.*` drift catalog
(`security-broker-contract.md` §7.3); it is **never** silently downgraded to the CLI's claim. An
**adversarial-manifest test** (Task 4.5, `broker-recompute.adversarial.test`) constructs manifests
that under-report tier, mislabel a policy cell, assert trust on an untrusted source, and claim `valid`
on `pending` evidence, and asserts the broker refuses/escalates each rather than advancing the
protected ref.

| Tier | Definition | Integration path |
|---|---|---|
| **Tier-0** | Read-only or projection-only run (no vault/canonical mutation). | No integration; emits `run.readonly`/`run.projection` only. |
| **Tier-1** | Deterministic, reversible, **key-accepting** mutation (e.g. Tier-1 source capture). Not model-authored. | CAS auto-integrate via `advanceProtectedRef` (or `integrateSourceCapture` for capture). |
| **Tier-2** | Model-authored mutation **within all three** `acceptance-thresholds.md` §workflow bounds (confidence, changed-lines, sections-of-a-single-note), on **trusted, `valid`-evidence-grounded** inputs. | CAS auto-integrate via `advanceProtectedRef`. |
| **Tier-3** | Model-authored mutation **exceeding any** threshold; **or** any destructive proposal (delete/replace, `maintain` destructive ops); **or** any mutation derived from **untrusted** or **non-`valid`** evidence (`stale`/`pending`/`failed`); **or** an operation the mutation-policy table marks review-only for the target type. | Stop at `review-pending`, exit `6`; requires `git approve`. |

Tier is **monotonic upward**: any single Tier-3 trigger forces Tier-3 regardless of the other inputs.
Escalation triggers (each independently forces Tier-3):

- confidence `< 0.8`, or changed-lines `> 50`, or sections `> 3`, or the change spans more than one
  note (`acceptance-thresholds.md` §workflow);
- destructive operation class (removal/replacement of existing content);
- untrusted-derived input, or evidence in `stale`/`pending`/`failed` (trust/verification gating,
  Tasks 4.7/4.8);
- a mutation-policy cell marked `review` or `reject` for the operation × target type below.

## §mutation-policy — per-type mutation-policy table (`policies` inputs)

`policies.mutationPolicyFor(type)` returns the policy row for a target note type; the pipeline (Task
4.5) and validation (Task 4.4) consume it. Cell values:

- **auto** — permitted; tier then determined by `effectiveRisk` (may still be Tier-3 by threshold).
- **review** — permitted but **always Tier-3** (never auto-commits regardless of thresholds).
- **append-only** — permitted only as an append (new section/claim/link); in-place replacement of
  existing content is **reject**.
- **immutable** — the operation is **rejected** with a policy violation (fail-closed).
- **reserved** — the operation's schema exists but is **rejected** in V1 (stable code
  `reserved-operation`).

The operation column is **exactly** the `@atlas/contracts` `CHANGE_PLAN_OPS` set (the SSOT of op
discriminants — the finalized 15 ops: 13 active + the 2 reserved task ops), one row per op. It does
**not** invent op names: the frontmatter op is `SetFrontmatterField` (not `Add/UpdateFrontmatterField`),
the link op is `SetLink` (not `Add/RemoveLink`), and the structural-proposal ops `ProposeMerge`,
`ProposeRename`, `ProposeArchive` are enumerated explicitly. The two trust ops (`PromoteTrust`,
`RevokeTrust`) were retired in v2 (contract demolition) — trust tiers no longer exist.
`CreateTask`/`UpdateTaskState` are reserved forward-compatible surface (§Scope). A bijection test
(`contract-lint`, "mutation-policy ⇄ CHANGE_PLAN_OPS") asserts this table's op set **equals**
`CHANGE_PLAN_OPS`, so Task 4.3 can generate every op×type case with no missing/stray row.

| operation \ target type | concept | person | project | research | decision | source | task (reserved) |
|---|---|---|---|---|---|---|---|
| `CreateNote` | auto | auto | auto | auto | review | immutable | reserved |
| `UpdateSection` | auto | auto | auto | auto | append-only | immutable | reserved |
| `AppendSection` | auto | auto | auto | auto | append-only | immutable | reserved |
| `SetFrontmatterField` | auto | auto | auto | auto | append-only | immutable | reserved |
| `AddAlias` | auto | auto | auto | auto | auto | immutable | reserved |
| `SetLink` | auto | auto | auto | auto | append-only | immutable | reserved |
| `CreateRelationship` | auto | auto | auto | auto | append-only | immutable | reserved |
| `ProposeMerge` | review | review | review | review | immutable | immutable | reserved |
| `ProposeRename` | review | review | review | review | immutable | immutable | reserved |
| `ProposeArchive` | review | review | review | review | immutable | immutable | reserved |
| `CreateTask` | reserved | reserved | reserved | reserved | reserved | reserved | reserved |
| `UpdateTaskState` | reserved | reserved | reserved | reserved | reserved | reserved | reserved |

The same table, machine-readable — the bijection test parses this block and asserts `ops[].op` equals
`CHANGE_PLAN_OPS`, every cell is a legal policy value, and every op maps every target type:

```json mutationPolicy
{
  "version": 1,
  "targetTypes": ["concept", "person", "project", "research", "decision", "source", "task"],
  "policyValues": ["auto", "review", "append-only", "immutable", "reserved"],
  "ops": [
    { "op": "CreateNote", "policy": { "concept": "auto", "person": "auto", "project": "auto", "research": "auto", "decision": "review", "source": "immutable", "task": "reserved" } },
    { "op": "UpdateSection", "policy": { "concept": "auto", "person": "auto", "project": "auto", "research": "auto", "decision": "append-only", "source": "immutable", "task": "reserved" } },
    { "op": "AppendSection", "policy": { "concept": "auto", "person": "auto", "project": "auto", "research": "auto", "decision": "append-only", "source": "immutable", "task": "reserved" } },
    { "op": "SetFrontmatterField", "policy": { "concept": "auto", "person": "auto", "project": "auto", "research": "auto", "decision": "append-only", "source": "immutable", "task": "reserved" } },
    { "op": "AddAlias", "policy": { "concept": "auto", "person": "auto", "project": "auto", "research": "auto", "decision": "auto", "source": "immutable", "task": "reserved" } },
    { "op": "SetLink", "policy": { "concept": "auto", "person": "auto", "project": "auto", "research": "auto", "decision": "append-only", "source": "immutable", "task": "reserved" } },
    { "op": "CreateRelationship", "policy": { "concept": "auto", "person": "auto", "project": "auto", "research": "auto", "decision": "append-only", "source": "immutable", "task": "reserved" } },
    { "op": "ProposeMerge", "policy": { "concept": "review", "person": "review", "project": "review", "research": "review", "decision": "immutable", "source": "immutable", "task": "reserved" } },
    { "op": "ProposeRename", "policy": { "concept": "review", "person": "review", "project": "review", "research": "review", "decision": "immutable", "source": "immutable", "task": "reserved" } },
    { "op": "ProposeArchive", "policy": { "concept": "review", "person": "review", "project": "review", "research": "review", "decision": "immutable", "source": "immutable", "task": "reserved" } },
    { "op": "CreateTask", "policy": { "concept": "reserved", "person": "reserved", "project": "reserved", "research": "reserved", "decision": "reserved", "source": "reserved", "task": "reserved" } },
    { "op": "UpdateTaskState", "policy": { "concept": "reserved", "person": "reserved", "project": "reserved", "research": "reserved", "decision": "reserved", "source": "reserved", "task": "reserved" } }
  ]
}
```

Invariants encoded above (fixed here, enforced by the Task 4.3/4.4 table-driven tests):

- **Sources are immutable.** Every operation targeting a `source` note is rejected; source content
  changes flow only through a new capture/rendition, never a mutation.
- **Decisions are append-only.** A `decision` note accepts new sections/claims/links but never
  in-place replacement; `CreateNote` of a decision is `review` (always Tier-3).
- **Destructive/structural proposals are never auto.** `ProposeMerge`/`ProposeRename`/`ProposeArchive`
  are `review` (Tier-3) where the type allows structural change at all, and `immutable` for
  `source`/`decision`.
- **No trust ChangePlan ops.** The v2 contract demolition retired `PromoteTrust`/`RevokeTrust`
  (trust tiers no longer exist) — the mutation-policy table therefore carries no trust rows.
- **Reserved surface cannot be driven.** `CreateTask`/`UpdateTaskState` (and any op on a `task` note)
  are rejected `reserved-operation` — schema-present, execution-denied (fail-closed).

## §cas — CAS integration semantics (Tier-1 / Tier-2 auto-commit)

Auto-integration advances the protected canonical ref under **compare-and-swap** through the broker
(`advanceProtectedRef` / `integrateSourceCapture`, `security-broker-contract.md`); the agent never
writes a protected ref. The ledger side follows the §2.8 cross-store ordering and the
`recovery-state-machine.md` `integrated` checkpoint — this contract does not restate those steps.

- **Broker-authoritative gate (precondition).** Before the CAS, the broker performs the
  §tiers *Broker-authoritative recomputation* — re-deriving risk, policy, trust, and evidence validity
  from the candidate tree and refusing/escalating on any mismatch with the manifest. The CAS is
  attempted **only** on a run whose manifest the broker's own recomputation confirms; a mismatch never
  reaches the fast-forward.
- **Expected-old guard.** The request carries `expectedOld` = the canonical head the run based on and
  validated against. The broker fast-forwards **only** if canonical still equals `expectedOld`
  (FF-only; no merge, no rebase by the broker).
- **CAS miss (canonical moved).** The broker refuses with the contract's stable code; the pipeline
  **rebases → regenerates → revalidates** on the new base and retries the CAS. A CAS miss never
  produces a lost update or a duplicate commit (`concurrent-integration.test`, Task 4.5).
- **Correctness fence.** The CAS additionally guards `content_hash-unchanged` for the target note(s):
  if the underlying content changed since validation, the run regenerates rather than integrating a
  stale patch.
- **Idempotency.** Integration is idempotent on `(runId, seq)` (broker append) and on the
  integration-hash anchor (ledger), so a crash-retry converges to a single `integrated` state and a
  single `run.integrated` audit event.
- **Tier-3 never auto-integrates.** A Tier-3 run stops at `review-pending` (exit `6`) and is advanced
  only by `git approve` (privileged, challenge-bound, FF-only CAS of the exact signed commit; stale
  base ⇒ `refresh-required`, exit `6`).

## §refresh — refresh semantics (Tier-3 review loop)

`git refresh` regenerates a review-pending run against current canonical without leaving the review
gate:

- **Key-accepting identity.** `refresh` is key-accepting: a repeat with the same run + intent is a
  no-op returning the existing superseding commit (idempotent per the spec).
- **New commit + supersession.** Refresh produces a **new** agent commit + manifest and records a
  **supersession** relationship (new commit supersedes the prior review-pending commit); the run
  returns to `review-pending`. The superseded commit is retained for the audit trail, never
  fast-forwarded onto canonical.
- **Re-validation, but no gate escape.** The refreshed plan is re-validated (Task 4.4) and re-tiered.
  Re-tiering **never** removes the run from the review gate: a refreshed commit **always remains
  `review-pending` and always requires a fresh approval signature**, regardless of its recomputed
  tier. A refresh that now recomputes *within* Tier-2 bounds does **not** auto-integrate and does
  **not** downgrade to auto-commit — the prior approval (if any) is invalidated by the supersession, so
  a **new** `git approve` (new challenge, new broker-authoritative recomputation, new signature over
  the new commit) is mandatory. Refresh can only ever *raise* scrutiny (a lower-tier recompute stays
  gated); it can never let a run escape review by re-tiering.
- **Stale-base approval.** `git approve` on a run whose base moved returns the stable
  `refresh-required` (exit `6`) rather than rebasing; the operator runs `git refresh` and re-approves.
  Approval **never** rebases (it FF-integrates the exact signed commit or refuses).

---

## Consumed contracts (single source of truth — not restated)

- `recovery-state-machine.md` (0.1) — the workflow state set, per-state atomic writes, `integrated`
  checkpoint, and recovery actions.
- `security-broker-contract.md` (0.3) — protected-ref set, challenge/response schemas, privileged-op
  authorization, drift-rejection error catalog.
- `acceptance-thresholds.md` §workflow — the Tier-2 numeric thresholds (config-consumed).
- Plan §2.5/§2.6 — global constraints, exit codes, lock order, D-registry privilege ownership.

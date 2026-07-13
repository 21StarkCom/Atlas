# Acceptance thresholds

Normative acceptance thresholds for Atlas V1. This document is a **contract that conforms to the
plan** (`docs/plans/atlas-v1-implementation-2026-07-12.md`) — the plan §2.5 global constraints are the
single source of truth for every constant here. A literal-comparison test
(`tools/contract-lint.test.ts`, "Phase-4 acceptance thresholds") asserts the machine-readable values
below **equal** the plan §2.5 constants, so the two can never drift.

Sections are authored per phase:

- **§workflow** — Phase 4 (Task 4.0): the Tier-2 auto-commit thresholds, the consolidated
  `doctor`/`db verify`/`git verify` check inventories, and the per-command failure exit codes for the
  Phase-4 mutation surface.
- **§retrieval + §scale** — added by Phase 5 (Task 5.0): retrieval eval (recall@10, MRR) and scale
  gates. Not authored here.

---

## §workflow

### Tier-2 auto-commit thresholds (verbatim from plan §2.5)

A synthesis run auto-commits at **Tier-2** (no human review gate) **only** when **all** of the
following hold; any run exceeding a bound is **Tier-3** (review-pending) instead:

- **confidence ≥ 0.8**, AND
- **patch ≤ 50 changed lines**, AND
- the change spans **≤ 3 sections** **of a single note**.

> Larger ⇒ Tier-3. These three numeric bounds — `0.8`, `50`, `3` — are the §2.5 constants; they are
> **consumed from config** by `policies` (Task 4.3) via this document, never re-hardcoded, and are
> asserted equal to both the plan §2.5 constants **and** the `policies` config defaults
> (`apps/cli/src/config/schema.ts`) by the literal-comparison test.

#### Two independently-typed confidence inputs (fail-closed)

The single `confidence ≥ 0.8` gate is evaluated over **two independently-typed confidence inputs**,
each of which must **independently** clear the same `minConfidence` bound — the design SSOT requires a
**model-authored** confidence and a **validation** confidence to be tracked and gated separately:

- **`modelConfidence`** — the generation model's self-reported confidence in the proposed ChangePlan.
- **`validationConfidence`** — the deterministic validator's (Task 4.4) confidence that the plan is
  grounded, schema-valid, and evidence-anchored.

The effective gate is a **minimum-reduction**: `effectiveConfidence = min(modelConfidence,
validationConfidence)`, and Tier-2 requires `effectiveConfidence ≥ minConfidence` — i.e. **both**
inputs must reach `0.8`. The reduction is **fail-closed**: if either input is **missing**,
**malformed** (out of `[0,1]`, non-numeric), or the two **conflict** in a way the validator flags
(e.g. the model asserts high confidence on evidence the validator marks non-`valid`), the run is
treated as **below threshold** and forced to **Tier-3** — a missing/ambiguous confidence never
auto-commits.

The tier taxonomy this feeds (full definitions in `workflow-risk-contract.md` §tiers):

| Tier | Meaning | Gate |
|---|---|---|
| Tier-0 | read-only / projection-only run | no mutation |
| Tier-1 | deterministic, reversible, key-accepting capture/mutation | CAS auto-integrate |
| Tier-2 | model-authored mutation **within** all three thresholds above | CAS auto-integrate |
| Tier-3 | model-authored mutation **exceeding** any threshold, destructive, or untrusted-derived | stop at `review-pending`, exit `6` |

The machine-readable form (parsed by the literal-comparison test):

```json workflowThresholds
{
  "version": 1,
  "tier2AutoCommit": {
    "minConfidence": 0.8,
    "maxChangedLines": 50,
    "maxSections": 3,
    "singleNote": true,
    "largerImplies": "tier-3",
    "confidenceInputs": {
      "model": { "key": "modelConfidence", "min": 0.8 },
      "validation": { "key": "validationConfidence", "min": 0.8 },
      "reduction": "min",
      "failClosed": true,
      "failClosedOn": ["missing", "malformed", "conflicting"]
    }
  },
  "configKeys": {
    "minConfidence": "policies.tier2_min_confidence",
    "maxChangedLines": "policies.tier2_max_changed_lines",
    "maxSections": "policies.tier2_max_sections"
  }
}
```

### Consolidated check inventories

The health/verification surface is owned by three commands. Every check below reports one of
`ok` / `degraded` / `action-required`; an `action-required` result maps to exit `6` for `doctor`
and to exit `1` for the `verify` commands (per the per-command exit-code table).

#### `doctor` check inventory (system health)

| id | title | phase | remediation |
|---|---|---|---|
| `modes-permissions` | Filesystem modes & permissions (protected-ref layout + key ACLs per `security-broker-contract.md`) | 1 | — |
| `lock-liveness` | Lock liveness across every named scope (`vault-maintenance ⊐ ledger-maintenance ⊐ jobs-runner ⊐ canonical-integration`); dead-pid locks reclaimable | 1 | `--reclaim-locks` |
| `backup-watermark` | Backup watermark health (`backup_watermark.seq` vs latest ledger seq; the `backup-unhealthy` blocking state) | 1 | `db backup` |
| `audit-anchor` | Audit-head anchor check (`refs/audit/runs` head + monotonic event count vs the external WORM anchor, D8; anti-truncation) | 1 | — |

Authoritative source: `docs/specs/cli-contract/doctor.schema.json` (`x-atlas-contract.checks`). This
table is the consolidated view; the schema is normative.

#### `db verify` invariant inventory (store integrity)

`db verify` runs the SQLite invariant queries defined in `sqlite-data-dictionary.md` §invariants
(FK-orphan absence, unique-index integrity, composite-identifier consistency, retention/ON-DELETE
conformance, needs-index/generation-fence consistency). With `--backup <ref>` it additionally verifies
a backup bundle (decryptability, content hash, schema compatibility). Any failed invariant ⇒ exit `1`.

Authoritative source: `docs/specs/cli-contract/db-verify.schema.json` +
`sqlite-data-dictionary.md` §invariants.

#### `git verify` convergence inventory (workflow integrity)

`git verify` performs manifest↔index convergent repair and anchor validation over the open-run and
audit surface: agent-branch/manifest agreement, `audit_intents`↔`refs/audit/runs` cross-store
convergence (§2.8), watermark coverage, and WORM-anchor head/count agreement. Divergences it can
repair are repaired; unrepairable divergences ⇒ exit `1`.

Authoritative source: `docs/specs/cli-contract/git-verify.schema.json`.

### Per-command failure exit codes (Phase-4 mutation surface)

Exit-code set (§2.5): `0` ok · `1` validation · `2` config/vault · `3` secret-scan · `4` internal ·
`5` user/usage · `6` action-required. Every Phase-4 command also emits `5` (usage) and `4` (internal);
the table lists the **distinctive** failure codes each command adds beyond those two.

| command | privilege | success | distinctive failure exit codes |
|---|---|---|---|
| `enrich` | shared | `0` (preview/applied) · `6` (Tier-3 ⇒ review-pending) | `1` validation · `2` config/vault, `locked:*`, `backup-unhealthy` · `3` secret-scan |
| `reconcile` | shared | `0` · `6` (Tier-3) | `1` · `2` · `3` |
| `maintain` | shared | `0` · `6` (Tier-3; destructive proposals always Tier-3) | `1` · `2` · `3` |
| `validate` | shared | `0` (report emitted) | `1` (findings present / plan invalid) · `2` |
| `evidence review` | shared | `0` | `1` · `2` |
| `evidence resolve` | shared | `0` | `1` · `2` |
| `evidence retry` | shared | `0` | `1` · `2` |
| `git review` | shared | `0` | `1` (run not reviewable) · `2` |
| `git refresh` | privileged | `0` (new commit ⇒ review-pending) | `1` (`run-not-found`, broker signature/signer/replay/payload/schema) · `2` (`config-invalid`, `locked:*`) · `6` (`authorization-required`, broker drift/expiry/presence) |
| `git approve` | privileged | `0` (FF integrate) | `1` (`run-not-found`, broker signature/signer/replay/payload/schema) · `2` (`locked:*`) · `6` (`authorization-required`, `refresh-required` on stale base, broker drift/expiry/presence) |
| `git reject` | shared | `0` (terminal; commit **retained** for audit, worktree removed) | `1` (`run-not-found`, `not-rejectable`) · `2` |
| `git rollback` | privileged | `0` (revert + reconcile; distinct rollback-run linked by `rollbackOf`) | `1` (`has-dependents`, `run-not-found`, broker signature/signer/replay/payload/schema) · `2` (`locked:*`) · `6` (`authorization-required`, broker `revert_mismatch`/drift/expiry/presence) |
| `git verify` | shared | `0` (convergent) | `1` (unrepairable divergence) · `2` |
| `purge` | privileged | `0` (preview inventory, or erased + verified on `--apply`) | `1` (`selector-empty`) · `2` (`locked:vault-maintenance`) · `5` (selector not exactly-one-of, or `--dry-run` with `--apply`) · `6` (`authorization-required`, broker drift/expiry/presence) |
| `source trust promote` | privileged | `0` | `1` (`source-not-found`, broker signature/signer/replay/payload/schema) · `2` · `6` (`authorization-required`, broker `trust_level_mismatch`/expiry/presence) |
| `source trust revoke` | privileged | `0` | `1` (`source-not-found`, broker signature/signer/replay/payload/schema) · `2` · `6` (`authorization-required`, broker `trust_level_mismatch`/expiry/presence) |

Notes:

- Privileged ops (`git approve|refresh|rollback`, `purge`, `source trust promote|revoke`) are
  authorized **only** by an OS-mediated presence assertion bound to the broker challenge **or** the
  non-interactive `--export-challenge` → sign → `--authorization` flow; **`--yes` never authorizes**
  (§2.5). Without an authorization they exit `6` (action-required) and, with `--export-challenge`,
  emit an `AuthorizationChallenge`.
- **Broker authorization outcomes preserve the `security-broker-contract.md` §7.3 catalog verbatim**
  — this surface does **not** flatten them into a single `authorization-invalid` exit `2`. Drift /
  expiry / presence codes (`authz.canonical_moved`, `authz.target_mismatch`, `authz.revert_mismatch`,
  `authz.trust_level_mismatch`, `authz.nonce_expired`, `authz.presence_unverified`) map to exit `6`;
  signature / signer / replay / payload / schema codes (`authz.signature_invalid`,
  `authz.payload_mismatch`, `authz.signer_unknown|revoked|not_permitted`, `authz.nonce_unknown`,
  `authz.nonce_replayed`, `authz.schema_invalid`, `authz.canonicalization_unsupported`) map to exit
  `1`. Each privileged command's schema carries the exact `driftCodes` of its `authzContract` §7.5 op
  with those exits (asserted by the contract-lint per-command-exit test).
- The fail-closed backup watermark (`backup-unhealthy`, exit `2`) blocks every ledger-writing command
  in this surface until backup coverage is restored.

# Spec-to-Plan review record — 2026-07-11-atlas-v1-design.md

**Run:** `stark-spec-to-plan` (lead `claude` / wing `codex`, gpt-5.5-pro reviews), 2026-07-12,
5 rounds, 2720s — **final verdict `max_rounds_unresolved`**. The plan at
`2026-07-11-atlas-v1-plan.md` was then **hand-written** from a review of all five rounds; this file
is the audit trail.

## Why the loop failed

The wing's executability bar (exact signatures, runnable verification, executable rollback,
file-path specificity — all legitimate) drove the lead's drafts from 2 KB → 79 KB → 98 KB → 125 KB;
round 5 blew the lead's output budget and emitted a 10 KB mid-sentence fragment. **The architecture
converged; the document didn't survive.** The round-5 tail proves rounds 2–4's blockers were
already architecturally resolved when truncation hit.

## Round-by-round

| Round | Draft | Verdict | Blockers | Contribution kept |
|---|---|---|---|---|
| 1 | 2 KB | revise | 15 | Established the gap classes: consume-before-produce, placeholder signatures, prose verification, unowned capabilities, unmapped commands. |
| 2 | 79 KB | revise | 10 | Host/CI provisioning as a first-class task; ledger fail-closed threading through **every** writer; per-command registry discipline; deterministic single-branch rollbacks. |
| 3 | 98 KB | revise | 11 | Ref read/write permission split; external WORM anchor; per-key ACLs; component-column rendition identifiers; cross-store audit ordering with intents; retained-harness rollback rule. |
| 4 | 125 KB | revise | 6 | Full coverage achieved; remaining: broker↔ledger cycle, missing egress identity, scanner ordering, premature evidence test, PR-boundary contradiction, missing fixture in inventory. |
| 5 | 10 KB (truncated) | revise | 2 | Tail shows all six round-4 fixes in place (acyclic seam, `atlas-egress`, scanner-first, two-PR split, `cli-surface.fixture.txt`) + one real bug (`cd atlas` double-descend). |

## Disposition of the open findings in the hand-written plan

| Finding | Fix in the plan |
|---|---|
| R4-F1 broker↔ledger circular dependency | §Overview + Tasks 1.6/1.7: broker git-primitives never import sqlite-store; `finalizeLedgerWrite` is the sole orchestrator; direction ledger→broker; `broker.no-ledger-dep.test`. |
| R4-F2 egress identity unprovisioned | Task 1.0 provisions `atlas-egress` (user, group, key ACL, launcher, network grant, teardown) + `provisioning.separation.test` covers both identities. |
| R4-F3 scanner after persistence | Task 2.2 lands the guard before 2.4/2.6; `normalize`/`captureSource` take `PrePersistenceGuard` as required dependency; `normalize.scans-before-return` + `capture.scans-before-persist`. |
| R4-F4 premature evidence-staleness test | Task 2.6 tests provenance only; the staleness assertion lives in Task 4.7 with the `0004_claims` schema. |
| R4-F5 Phase-2 rollback PR contradiction | Two-PR discipline: PR-A (retained `0003_provenance` + fold, Task 2.1) never reverted; PR-B carries features. Same pattern for Phase 4 (`0004_claims`, Task 4.1). |
| R4-F6 missing retained fixture in inventory | `cli-surface.fixture.txt` is an explicit Task 0.0 file; the plan also adds `fixtures/inputs/*` so every verification path exists in an inventory. |
| R5-F1 truncated document | Structural: the hand-written plan controls altitude — contract docs own long-tail enumerations, tasks consume them (single source of truth), keeping the full document complete and finite (1,576 lines). |
| R5-F2 `cd atlas` double-descend | §5 Testing Strategy: aggregate gate is `pnpm -r build && pnpm -r test` with working directory = repo root. |

Also folded in: the two round-4 non-blocking suggestions (seq allocation inside the intent txn —
§2.8; `refs/agent/` ownership/modes — Task 0.3) and red-team finding rt1 (the plan mandates two
distinct broker OS identities rather than the spec's permitted shared identity).

## Residual risks to watch at plan-review time

- The plan **adds** `graduation`/`quarantine` command groups (the spec's Phase-5 prose implies
  operator commands but the CLI-surface list omits them) — registry-first, derived docs regenerate;
  the spec's prose inventory should be regenerated in the Phase-0 PR.
- `jobs-runner` lock scope and the D6 audit mapping for `db backup/restore` are plan-level decisions
  (D5/D6) the spec left open — flagged for explicit approval in `/stark-review-plan`.

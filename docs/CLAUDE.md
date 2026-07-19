# docs/ — CLAUDE.md

`docs/` is Atlas's **normative contract layer + decision trail**, not narrative documentation. The specs are the authoritative SSOT the code is built to satisfy; several are **machine-checked against code** (`tools/contract-lint.test.ts`, `tools/gen-cli-contract.ts --check`, `tools/gen-failpoints.ts`). Editing a spec constant without its code/plan counterpart fails CI. This file is a **map + conventions guide** — it does not restate spec content; follow the links.

## Layout & naming

Folder-per-type: `adr/` `specs/` `plans/` `retros/`. The CLI contract lives in `specs/cli-contract/`; graduation migration test data in `specs/fixtures/bootstrap-migration/` (distinct from the repo-root `fixtures/`, which has its own CLAUDE.md).

- **Design specs / feature plans / retros** carry a front `YYYY-MM-DD-<topic>-<type>.md` date (`specs/2026-07-11-atlas-v1-design.md`, `plans/2026-07-17-open-type-system-plan.md`, `retros/2026-07-18-search-index-live-drive-retro.md`).
- **Exception 1:** the V1 plan is `plans/atlas-v1-implementation-2026-07-12.md` — date **suffix**, not prefix. Don't "fix" it.
- **Exception 2:** normative **contract** specs are **un-dated topic names** (`jobs-contract.md`, `sandbox-contract.md`, `sqlite-data-dictionary.md`, …) — living contracts, not dated artifacts.
- **ADRs** are monotonic `NNNN-<topic>.md`, MADR-lite, **immutable — supersede, don't edit**. Only `0001` exists (`Status: accepted`).
- **Review companions** sit next to the doc they review, sharing its basename: `.red-team.md` (adversarial pass), `.review-analytics.md` (process telemetry), `.s2p-review.md` (spec→plan audit), `.plan-review.md` (plan-review audit). Historical trail — preserve, don't prune.

## Doc map

| Doc | Role | Status / consumers |
|---|---|---|
| `specs/2026-07-11-atlas-v1-design.md` | V1 capability + architecture SSOT (2148 lines) | `approved-pending-review` — **not `final`** (grew 1706→2149 over 5 non-converging review rounds) |
| `plans/atlas-v1-implementation-2026-07-12.md` | **executable authority** (hand-written; replaces the failed s2p output) | §2.5 = every constant · §2.7 = migration-ownership · §7 = command→task/package map |
| `adr/0001-egress-response-scan-released-bytes.md` | egress response scan on RELEASED bytes | accepted, #146/#148 |
| `specs/*.md` (contract specs) | one gates each build phase, consumed verbatim by named tasks | anti-drift lint-gated (below) |
| `specs/cli-contract/commands.json` | **sole SSOT of command membership** | `gen-cli-contract.ts --check` gates surface drift |
| `specs/2026-07-16-open-type-system-spec.md` + `plans/2026-07-17-open-type-system-plan.md` | open type system (#151 → landed #152, fix #153) | **supersedes** bootstrap-migration's `unknown-type`/`unsupported-schema-version` refusals |
| `plans/2026-07-17-search-index-live-build-plan.md` | full-corpus index + `index eval` gate (#155) | **Task 5 runbook superseded by the retro** (below) |
| `retros/2026-07-18-search-index-live-drive-retro.md` | authoritative live-drive gotcha source | six runbook corrections; FTS #156 → resolved #159 |
| `specs/2026-07-19-live-vault-adoption-sync-spec.md` + `plans/2026-07-19-live-vault-adoption-sync-plan.md` | live-vault adoption (60-A) + continuous `brain sync` (60-B) — #60 | plan §0 is the **normative OQ#5 divergence policy** (REJECT halt + operator-authorized `sync reset`); decomposed into phase issues #263–#268 |

For the spec → implementing-package map, use plan **§7** (`atlas-v1-implementation-2026-07-12.md`), not a copy here.

## Generated — never hand-edit

- `specs/cli-contract/commands-overview.md` → regen `node tools/gen-cli-contract.ts --write` (source: `commands.json`).
- `specs/cli-contract/failpoints.generated.md` → regen `node tools/gen-failpoints.ts --write` (source: the `stateTable` JSON block in `specs/recovery-state-machine.md`).
- Per-command `<cmd>.md` refs + contract-test fixtures derive from `<cmd>.schema.json` (schema authoritative).

**Anti-drift is machine-enforced** — literal-comparison tests bind `acceptance-thresholds.md` to plan §2.5; `contract-lint` binds the data-dictionary table set to §2.7, `stateTable` completeness to the state set, `mutationPolicy` to `CHANGE_PLAN_OPS`, the retrieval digest to D4/D7, and registry↔fixture↔schema. Many specs carry a fenced ```` ```json <name> ```` block a test parses (`workflowThresholds`, `retrievalContract`, `sandboxContract`, `stateTable`, …). Contracts **Consume/Produce** (cross-reference), never restate each other's enumerations.

## Gotchas & sharp edges

- **Dead-link trap — four cited contracts DO NOT EXIST.** The design spec (lines 421/606/1117/1681/1700–1701) cites `specs/config-schema.md`, `specs/state-inventory.md`, `specs/vault-format.md`, `specs/broker-deployment.md` as "landing before Phase 1/2." **None were authored.** Config lives in `apps/cli/src/config/schema.ts`; state/restore material folded into `specs/ledger-backup-contract.md`. **Never add these to a doc index or relative link — they resolve nowhere.**
- **`bootstrap-migration.md` prose is partly stale.** It describes closed-type graduation with `unknown-type`/`unsupported-schema-version` refusals that #151/#152 removed. Its §9 states **fixtures are authoritative over prose** (3 known-open reconciliations, Phase-5 tracker #8). Don't cite its refusal categories as current.
- **The search-index plan's Task-5 runbook is wrong for live drives** — six factual errors (own vault-repo + fresh anchor, `.bootstrap-backup` removal, `db migrate` before `db rebuild`, `ATLAS_EGRESS_CAPABILITY_KEY`, broker-startup ordering, nonce TTL). Use the **retro**, not the plan.
- **Plans are point-in-time snapshots; code diverged where noted** — e.g. `strictBackup` dropped from `runReadAudit` (`948c45c`, #155) though the plan's `index-eval.ts` listing still shows `{ strictBackup: true, runId }`.
- **`retrieval-index-contract.md` §6 carries a dated UPDATE banner** — FTS default flipped twice (immature at drive time #156 → resolved #159; hybrid now default, 0.911/0.830). Read the banner, not just the older prose above it.
- **Exit-code set is `0–7` per the design SSOT**, but plan §2.5 and the Phase-4/5 tables (`acceptance-thresholds.md`, `security-broker-contract.md` §7.3) enumerate only `0–6`. Genuine tension — quote the SSOT for the set, note the 0–6 tables when quoting the plan.

## Open

- **#8** (Phase-5 tracker) — 3 unresolved prose↔fixture reconciliations in `bootstrap-migration.md`; until rewritten, **fixtures win**.
- **Mutation-policy reconciliation** (open-type non-goal) — `workflow-risk-contract.md` §mutation-policy / `POLICY_TARGET_TYPES` don't yet model the vault's `repo/cloud/tool/team/meeting/conversation/memory` types; unmodeled types default to `review`. Needs its own spec before Atlas mutates such a note.

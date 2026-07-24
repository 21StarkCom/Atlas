# docs/ — CLAUDE.md

`docs/` is Atlas's **normative contract layer + decision trail**, not narrative documentation. The **v2 pivot** ([`adr/0003-retire-security-architecture.md`](adr/0003-retire-security-architecture.md)) retired the entire security architecture: `brain` is now a single process, git is the only safety mechanism, and the command surface dropped 55 → 24. Many specs here are therefore **historical** — they describe subsystems that no longer ship. The live contracts are still **machine-checked against code** (`tools/contract-lint.test.ts`, `tools/gen-cli-contract.ts --check`, `tools/gen-failpoints.ts`); editing a live spec constant without its code/plan counterpart fails CI. This file is a **map + conventions guide** — it does not restate spec content; follow the links, and check the status column before trusting a spec as current.

## Layout & naming

Folder-per-type: `adr/` `specs/` `plans/` `retros/`. The CLI contract lives in `specs/cli-contract/`; graduation migration test data in `specs/fixtures/bootstrap-migration/` (historical — graduation is retired; distinct from the repo-root `fixtures/`, which has its own CLAUDE.md).

- **Design specs / feature plans / retros** carry a front `YYYY-MM-DD-<topic>-<type>.md` date (`specs/2026-07-21-atlas-v2-single-process-simplification-spec.md`, `plans/2026-07-17-open-type-system-plan.md`, `retros/2026-07-18-search-index-live-drive-retro.md`).
- **Exception 1:** the V1 plan is `plans/atlas-v1-implementation-2026-07-12.md` — date **suffix**, not prefix. Don't "fix" it.
- **Exception 2:** normative **contract** specs are **un-dated topic names** (`jobs-contract.md`, `sqlite-data-dictionary.md`, `retrieval-index-contract.md`, …) — living contracts, not dated artifacts.
- **ADRs** are monotonic `NNNN-<topic>.md`, MADR-lite, **immutable — supersede, don't edit**. Four exist: `0001` (egress scan) and `0002` (P-256/SE signer) are **superseded by `0003`**; `0003` (`Status: accepted`) is the v2 pivot and is current; `0004` (`Status: accepted`, persistent desktop surface + engine-access doctrine) is current and **extends `0003` without weakening it**.
- **Review companions** sit next to the doc they review, sharing its basename: `.red-team.md` (adversarial pass), `.review-analytics.md` (process telemetry), `.s2p-review.md` (spec→plan audit), `.plan-review.md` (plan-review audit). Historical trail — preserve, don't prune.

## Doc map

**Current authority (v2):**

| Doc | Role | Status / consumers |
|---|---|---|
| `adr/0003-retire-security-architecture.md` | **the v2 pivot** — retire the whole security arc; one process, git-only safety, `v1-fortress` revival tag | **accepted** 2026-07-22; supersedes ADR-0001 + ADR-0002 |
| `specs/2026-07-21-atlas-v2-single-process-simplification-spec.md` + `plans/2026-07-21-atlas-v2-single-process-simplification-plan.md` | **v2 SSOT** — the shipped engine: single process, 55→24 commands, git-only safety, destructive `0013`/`0014`/`0015` migrations, the `v1-fortress` tag | current design + implementation authority |
| `adr/0004-persistent-desktop-surface-and-engine-access.md` | **desktop doctrine** — a persistent macOS menubar app (`@atlas/desktop`) that is a **pure `brain status` client**: no direct read/write of Atlas-managed state, CLI-spawn for state, config-file writes explicitly outside that boundary; one writer + one readiness reader survive | **accepted** 2026-07-24; extends ADR-0003 |
| `specs/2026-07-24-atlas-desktop-app-spec.md` + `plans/2026-07-24-atlas-desktop-app-plan.md` | **desktop v1 SSOT** — 4 capabilities (indicator / restart / config / launch-at-login), app-owned `CHECK_SEVERITY` over the CLI's 5 binary checks, `@atlas/models`-owned credential set/replace, 6-phase delivery | current design + implementation authority (not yet built — `apps/desktop` lands per the plan) |
| `specs/cli-contract/commands.json` | **sole SSOT of command membership** — version 2, **24 commands** (the #333 survivor set, all `implemented:true`) | `gen-cli-contract.ts --check` gates surface drift |
| `specs/retrieval-index-contract.md` | chunk → embed → FTS + vector retrieval + RRF fusion | **live** — lint-bound (D4 chunker, RRF weights, FTS fallback); read the §6 dated banner |
| `specs/sqlite-data-dictionary.md` | the SQLite projection table set | **live** — lint-bound to plan §2.7 |
| `specs/acceptance-thresholds.md` | workflow + retrieval + scale thresholds | **live** — literal-bound to plan §2.5 (`workflowThresholds`, `retrievalThresholds`, `scaleThresholds`) |
| `specs/jobs-contract.md` · `specs/normalization-contract.md` | jobs-queue state machine · md/txt/pdf/html media tokens (in-process `normalize()`) | **live** — lint-bound |
| `retros/2026-07-18-search-index-live-drive-retro.md` | authoritative search-index live-drive gotchas | index build survives; broker/anchor/egress-key/graduation/nonce steps are retired |

**Historical / superseded (kept in-tree as the immutable record; the subsystems they describe are gone):**

| Doc | Was | Superseded by |
|---|---|---|
| `specs/2026-07-11-atlas-v1-design.md` | V1 design SSOT (2149 lines) | v2 spec + ADR-0003 — its In/Out-of-V1 lists no longer describe shipped Atlas (`approved-pending-review`, never `final`) |
| `plans/atlas-v1-implementation-2026-07-12.md` | V1 executable plan | v2 plan for the engine; **still the source** of the surviving §2.5 constants + §2.7 table ownership that contract-lint binds |
| `adr/0001-egress-response-scan-released-bytes.md` · `adr/0002-p256-secure-enclave-authorization-signer.md` | egress response scan · alg-agile P-256/SE signer | ADR-0003 (immutable — not edited) |
| `specs/security-broker-contract.md` · `specs/ledger-backup-contract.md` | privilege boundary / brokers / authorization challenges · signed audit ledger + AEAD backup/restore/watermark | ADR-0003 — retired entirely |
| `specs/sandbox-contract.md` · `specs/provider-interface.md` | parser jail · egress-broker provider framing | ADR-0003 — `normalize()` parses in-process; the Gemini adapter is a direct in-process client (provider-interface already carries a SUPERSEDED banner, #312) |
| `specs/recovery-state-machine.md` | the §2.8 ledger-write / audit-stream crash-recovery SSOT | ADR-0003 for its ledger narrative — v2 crash-safety is the preimage-restore path in `apps/cli/src/workflows/mutation-order.ts`. **Its `stateTable` still gates the failpoint matrix** and its §2.5 state set is still lint-checked, so the file stays live-in-tree even though its recovery prose is retired |
| `specs/workflow-risk-contract.md` · `specs/retention-matrix.md` | trust/risk-tier + review-park runtime · purge/tombstone/backup retention | ADR-0003 — the runtime is retired; the mutation-policy op×type table is still lint-bound to `CHANGE_PLAN_OPS` |
| `specs/bootstrap-migration.md` | the graduation pipeline contract | ADR-0003 — graduation is retired |
| `specs/2026-07-19-live-vault-adoption-sync-spec.md` + its plan | 60-B absorb-cycle sync, canonical-ref indirection, privileged `sync reset` | ADR-0003 — canonical IS `refs/heads/main` (no indirection); `sync` survives as a plain reconcile (working tree vs projection) |
| `specs/2026-07-16-open-type-system-spec.md` + `plans/2026-07-17-open-type-system-plan.md` | open note-type system | partly current — flexible note types survive; the graduation `unknown-type` framing is retired with graduation |
| `plans/2026-07-17-search-index-live-build-plan.md` | full-corpus index + `index eval` gate | eval gate + recall@10/MRR thresholds survive; **Task-5 runbook superseded by the retro** and by ADR-0003 |
| `retros/2026-07-20-atlas-signer-live-drive-retro.md` · console specs/plans (`2026-07-18/19-console-*`) · `plans/2026-07-20-atlas-signer-plan.md` | SP-2 Console + SP-3 `atlas-signer`/`brain watch` arc | ADR-0003 — Console + signer + `brain watch` retired (a new UI comes later) |

For the spec → implementing-package map, use plan **§7** (`atlas-v1-implementation-2026-07-12.md`) — still accurate for the survivor packages; the retired-package rows (broker/scan) are dead.

## Generated — never hand-edit

- `specs/cli-contract/commands-overview.md` → regen `node tools/gen-cli-contract.ts --write` (source: `commands.json`).
- `specs/cli-contract/failpoints.generated.md` → regen `node tools/gen-failpoints.ts --write` (source: the `stateTable` JSON block in `specs/recovery-state-machine.md`). **Still generated + gated** (`pnpm failpoints:check`) — the failpoint rows still name the retired §2.8 protocol, because the stateTable was not rewritten for v2; treat the generated recovery prose as historical, the mutation-order preimage-restore path as current.
- Per-command `<cmd>.md` refs + contract-test fixtures derive from `<cmd>.schema.json` (schema authoritative).

**Anti-drift is machine-enforced** — `contract-lint` binds the **live** contracts: registry ↔ fixture ↔ schema bijection, the data-dictionary table set ↔ plan §2.7, `stateTable` completeness ↔ the §2.5 state set, `retrievalContract` ↔ D4/RRF/FTS-fallback, the workflow mutation-policy op set ↔ `CHANGE_PLAN_OPS`, and literal-compares `acceptance-thresholds.md` to plan §2.5. It also adds the **v2 privilege-collapse gate** (ADR-0003/#333): the registry must hold **zero** privileged rows — every command is `shared`. Superseded specs stay byte-stable and their fenced ```` ```json ```` example blocks (`sandboxContract`, `mutationPolicy`, the security/broker + provider-interface examples, …) still must parse — a structural gate on files whose subsystems are retired. Contracts **Consume/Produce** (cross-reference), never restate each other's enumerations.

## Gotchas & sharp edges

- **Check the status column before trusting a spec.** Roughly half the `specs/*.md` files describe retired subsystems (brokers, scan, ledger, backup, quarantine, trust tiers, graduation, sandbox, signer). They are kept as the immutable record and several are still lint-parsed, but **do not cite them as current behavior**.
- **Dead-link trap — four cited contracts DO NOT EXIST.** The design spec (lines 421/606/1117/1681/1700–1701) cites `specs/config-schema.md`, `specs/state-inventory.md`, `specs/vault-format.md`, `specs/broker-deployment.md` as "landing before Phase 1/2." **None were authored** (and the last names a retired subsystem regardless). Config lives in `apps/cli/src/config/schema.ts`. **Never add these to a doc index or relative link — they resolve nowhere.**
- **The search-index live-build Task-5 runbook is mostly retired.** Of its six drive corrections only **`db migrate` before `db rebuild`** survives; the own-anchor, `.bootstrap-backup` removal, egress capability key, broker-startup ordering, and authorization-nonce steps all name subsystems ADR-0003 retired. Read the retro for the index build; ignore the security machinery.
- **Plans are point-in-time snapshots; code diverged where noted** — e.g. the V1 plan's `index-eval.ts` listing still shows a `strictBackup` flag dropped from `runReadAudit` (`948c45c`, #155), and the plan's broker/ledger flows are gone entirely in v2.
- **`retrieval-index-contract.md` §6 carries a dated UPDATE banner** — FTS default flipped twice (immature at drive time #156 → resolved #159; hybrid now default, 0.911/0.830). Read the banner, not just the older prose above it.
- **Exit-code set is `{0, 1, 2, 4, 5}`** (ok / validation / config-vault-lock / internal / usage); **`7`** (provider-retryable) is the `jobs run` batch **aggregate** only. The former secret-scan (`3`) and action-required (`6`) codes are **retired** (ADR-0003) — the V1 design SSOT's `0–7` set and the retired security/ledger tables' `0–6` are historical.

## Open

- **Stale recovery/ledger comments in surviving code.** `apps/cli/src/workflows/{checkpoints,reconciler,engine}.ts` and `retrieval/layers.ts` still name `finalizeLedgerWrite` / §2.8 / `recovery-state-machine.md` in comments (excluded from the retired-reference gate). Doc-truth debt, not behavior — the mutation-order preimage-restore path is what actually runs.
- The V1 doc-open items (bootstrap-migration prose↔fixture reconciliation; mutation-policy tier modeling) are **closed by retirement** — graduation and the risk-tier runtime no longer ship.

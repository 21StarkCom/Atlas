# tools/ — the CLI-contract harness

The **drift-proof CLI-contract harness**: Phase-0 bootstrap scaffolding that outlived Phase 0 and is declared **"NEVER reverted"** (`cli-contract.ts:11`, `gen-cli-contract.ts:2`). Not shipped code — it is the machinery that keeps the design SSOT, prose contracts, JSON schemas, the SQLite data dictionary, the recovery state machine, and the broker authz contract from silently diverging. The contract data it guards lives in `docs/specs/cli-contract/`; the specs it cross-checks live in `docs/specs/*.md`.

Throwaway tooling here earns its keep or graduates: the retrieval-eval harness (`retrieval-eval.ts` + `.test.ts`) was **removed** in #155 once its logic became the shipped `brain index eval` command. `tools/` holds only what stays anti-drift infrastructure.

## Fits in the monorepo

- **Package:** `@atlas/cli-contract-tools`, private, ESM, `noEmit` (`tsconfig.json` extends `../tsconfig.base.json`, `allowImportingTsExtensions` — imports use explicit `.ts`).
- **Depends on built workspace packages:** `test-signer.ts` imports `@atlas/broker` (`parsePrivateKeyFlexible`, `signBytes`); `contract-lint.test.ts` imports `@atlas/contracts`. **CI's `pnpm -r build` MUST precede `pnpm -r test`** or the tests can't resolve those imports.
- **Dependents:** CI (`.github/workflows/ci.yml`) and the repo-root scripts. `apps/cli` command handlers are what the registry/schemas describe; the broker READS registry `privilege` and never re-classifies it.
- **Root scripts mirror both generators:** `contract:check`/`contract:write`, `failpoints:check`/`failpoints:write` (repo `package.json`).

## Key files

| File | Role |
|---|---|
| `cli-contract.ts` (675 lines) | Shared library — ALL parse/validate logic. Consumed by both the generator CLI and the vitest gate so they can't diverge. Exports registry types (`CommandRow`, `Registry`), enums (`PHASES=[0..5]`, `IDEMPOTENCY`, `PRIVILEGE`, `EXIT_CODES=[0..6]`), recovery constants (`RECOVERY_CHECKPOINTS`×7, `RECOVERY_TERMINALS`×5, `FAILABLE_CHECKPOINTS`×5), `MIGRATION_OWNERSHIP`/`sqlite27Tables()`, and loaders/checkers (`loadRegistry`, `parseFixture`, `validateRegistry`, `checkFixtureConsistency`, `checkImplementedSchemas`, `checkTableInventory`, `checkStateTableCompleteness`, `checkAuthzContractCompleteness`, `renderOverview`, `lintAll`). |
| `gen-cli-contract.ts` (75 lines) | The generator CLI. `--check` = `lintAll` + committed `commands-overview.md` must byte-equal `renderOverview(registry)`; `--write` regenerates. **The only harness tool CI invokes as an explicit step** (`ci.yml:45-46`). |
| `gen-failpoints.ts` (194 lines) | Task 4.11 crash-recovery failpoint generator (#127). Reads the `stateTable` from `recovery-state-machine.md`, emits `failpoints.generated.md` (29 rows), same `--check`/`--write` discipline. Import-guarded (side-effect-free import). |
| `contract-lint.test.ts` (1968 lines / 99 KB) | The **mega-gate** — de-facto contract regression suite, not just a lint. Runs under vitest. Executes real DDL against `node:sqlite` `DatabaseSync`. |
| `test-signer.ts` (63 lines) | Fixture authorization signer (Task 1.6, D20). |
| `build-artifact.sh` | Builds the privileged daemon artifact for `provisioning/install-artifact.sh` (D16): esbuild-bundles `@atlas/broker`'s two bins into single-file CJS executables + sha256 manifests in `dist-artifact/` (gitignored). CJS because the extension-less artifacts resolve module type from the nearest package.json — the install dir has none. |
| `provisioning-acl.test.ts` (92 lines) | Non-sudo ACL-matrix contract for `provisioning/keys.acl.json` (Task 1.0/#16). |
| `cli-schemas.test.ts` (98 lines) | Task 0.5/#14: schemas are valid draft-2020-12, validate their embedded `examples`, cover every Phase-1 row. |

### The contract data — `docs/specs/cli-contract/`

- **`commands.json`** — registry SSOT (`version:1`, **55 rows**, sorted by name). Row `{ name, schemaRef, phase, idempotency, privilege, implemented }`. Sole owner of command membership/phase/privilege/idempotency.
- **`cli-surface.fixture.txt`** — prose CLI-surface inventory; must be a bijection with `commands.json`. Parse rule: a command line **begins with a backtick**, name = first backtick pair; all else ignored (`parseFixture`, `cli-contract.ts:291`).
- **`commands-overview.md`** — GENERATED (`renderOverview`), sorted by **`(phase, name)`** — a different order than `commands.json` (name only). Never hand-edit (banner says so).
- **`failpoints.generated.md`** — GENERATED (`gen-failpoints.ts`), 29 failpoints. Never hand-edit.
- **56 `*.schema.json`** — 55 command schemas (name spaces→hyphens) + `error-envelope.schema.json`. Each carries an `x-atlas-contract` block validated against its registry row.

## Invariants & guardrails

- **One SSOT, many derived views.** `commands.json` is the sole owner; the fixture is a bijection with it; the two generated docs must never be hand-edited. Broker reads `privilege`, never re-derives.
- **`schemaRef` is mechanical** — must equal `docs/specs/cli-contract/<name spaces→hyphens>.schema.json` (`expectedSchemaRef`, `cli-contract.ts:270`). `validateRegistry` rejects any deviation.
- **`implemented:true` ⇒ schema file exists** (`checkImplementedSchemas`).
- **Generate-then-verify determinism.** Both generators produce a clean `--check` immediately after `--write`; committed derived docs are byte-compared.
- **Normative sets are transcribed verbatim and pinned in both directions.** `RECOVERY_CHECKPOINTS`/`RECOVERY_TERMINALS`/`FAILABLE_CHECKPOINTS` (§2.5), `MIGRATION_OWNERSHIP` (§2.7), `EXIT_CODES` (0..6). Widening a set silently would mask a missing state/table downstream — the lint refuses.
- **Privileged commands ⇔ authzContract.** `checkAuthzContractCompleteness` asserts a bijection between registry `privilege:"privileged"` and the security/broker `authzContract.privilegedOps` (non-variant); every op names mechanism + non-empty challenge/verification/drift arrays; every `driftCode` maps to an exit in 0..6. Privileged *variants* of shared commands (e.g. `db backup --force-unblock`) set `variant:true` — exempt from the bijection but must reference a real command.
- **DDL inventory is parsed from executable `CREATE TABLE` inside ```sql``` fences** (comments stripped) and every fence executes clean against `node:sqlite` — prose/commented-out DDL cannot satisfy the gate.
- **stateTable → failpoint matrix must be complete.** `assertRecoveryContract` (`gen-failpoints.ts:67`) refuses to emit for any row missing `atomicWrite`/`idempotencyCheck`/`recoveryAction`/`retainedArtifacts`/`worktreeCleanup` (and `nextStates` for checkpoints). `auditEmission` is optional (only `planned`/`integrated` emit `run.*`, D6). `expectedFailpointCount()` = checkpoints×2 + terminals + failable×2 = **7×2 + 5 + 5×2 = 29**.
- **D20 test-mode guard.** `test-signer.ts` signs `challenge.signingPayload` **verbatim** (§8.2) with the `atlas-test-approver` Ed25519 key; keysDir from `ATLAS_TEST_KEYS_DIR`→`ATLAS_BROKER_KEYS_DIR`→cwd (or `--keys-dir`). It can NEVER produce a production authorization — the broker hard-rejects `atlas-test-approver` unless `ATLAS_TEST_MODE=1` (`packages/broker/src/authorize.ts`). Accepts native `ed25519:` PKCS#8 OR OpenSSL PEM. Usage: `node tools/test-signer.ts --key atlas-test-approver < challenge.json > authorization.json`.

## Add / rename / implement a command

- **Add:** insert one name-sorted row into `commands.json`, add a matching `` `name` — desc `` line under the right phase heading in `cli-surface.fixture.txt`, create the schema at the derived `schemaRef` path, set `implemented`. Run `pnpm contract:write`. The bijection/naming/presence gates enforce the rest.
- **Rename:** a **one-row diff** — change the row `name`, rename the fixture line, rename the schema file to the new derived path; regenerate. `validateRegistry`'s `schemaRef != expected` check catches a forgotten file rename.
- **Implement:** flip `implemented:false→true` once the schema exists; `checkImplementedSchemas` gates it. Per-phase `x-atlas-contract` checks then bind the schema's `command`/phase/privilege/idempotency to the row.

## Gotchas & sharp edges

- **CI runs ONLY `gen-cli-contract.ts --check` as an explicit step** (`ci.yml:45-46`). `gen-failpoints.ts --check` is **not** a CI step — failpoints-doc drift is caught only by the vitest `apps/cli/test/crash-recovery.failpoints.test.ts` (byte-compares the committed doc) via `pnpm -r test`. `pnpm failpoints:check` exists but you must remember it, or rely on vitest.
- **`lintAll` (the fast `--check`) composes FIVE checks** — `validateRegistry` + `checkFixtureConsistency` + `checkImplementedSchemas` + `checkTableInventory` + `checkAuthzContractCompleteness`. It does **NOT** include `checkStateTableCompleteness`; that (and failpoints) is gated by vitest only.
- **Overview vs registry ordering differ** — `commands-overview.md` sorts by `(phase, name)`, `commands.json` by name. Don't expect them to match.
- **`EXIT_CODES` stops at 6.** Exit `7` (provider-retryable) is a runtime outcome, NOT a valid `x-atlas-contract` exitCode or authz drift exit — a schema declaring exit 7 fails the per-phase lint. (Design SSOT defines 0..7; the harness/plan tables cap at 0..6 — real tension, see `docs/CLAUDE.md`.)
- **`contract-lint.test.ts` executes real DDL** against `node:sqlite` — requires **Node ≥ 24**; CI uses Node 26.
- **`provisioning-acl.test.ts` is deliberately non-sudo** — checks the ACL matrix + script `+x` bits only. Live OS-user separation/integrity suites land with the broker (#22) and gate on `ATLAS_PROVISIONED`.
- **`--check`/`--write` are mutually exclusive** — both or neither → usage error, **exit 5**; any lint failure → **exit 1**.
- **The mega-gate is one 99 KB file** — grew phase-by-phase; each phase appended its contract block.

## History (real PRs)

- **#61 (Phase 0)** — scaffold + retained harness landed whole (`cli-contract.ts`, `contract-lint.test.ts`, `gen-cli-contract.ts`, `cli-schemas.test.ts`). Declared "never reverted."
- **#63** — `provisioning-acl.test.ts` (Task 1.0/#16). **#66** — `test-signer.ts` added; `package.json` gained `@atlas/broker` + `@atlas/contracts`.
- **#67/#68/#69/#70** — the Phase-2/3/4/5 contract gates, each appending a large block to `contract-lint.test.ts` (jobs/sandbox/normalization/provider; retrieval/index; acceptance thresholds + workflow-risk; bootstrap-migration executable fixtures + retrieval/scale thresholds).
- **#127** — `gen-failpoints.ts`; matrix generated from the `stateTable`. **#137** — fixed stale `implemented` flags. **#152** — bootstrap fixtures assert an unregistered note `type` validates (#151 open type system).
- **#85 → #155** — `tools/retrieval-eval.ts` + `.test.ts` **added then removed** (−197 lines) once the logic graduated into the `brain index eval` command; the registry (`commands.json`) gained the `index eval` Phase-5 row. **The clearest signal of the harness's intent: throwaway tooling migrates into shipped commands once it earns a contract.**

## Open items

- **`gen-failpoints --check` has no dedicated CI step** — drift protection rides on `pnpm -r test`. If that suite is ever narrowed, add `node tools/gen-failpoints.ts --check` alongside the existing step in `ci.yml`.
- **`tools/scale-bench.ts` is unbuilt (#60)** — the `acceptance-thresholds.md` §scale profiles (5k/50k) are spec'd but unbenchmarked; still owed, with the stable regression subset to be wired into nightly CI.
- The harness's authz/table/threshold gates are the guardrails **#60** (graduation E2E real-copy) and **#65** (ledger/backup hardening residuals) must stay inside.

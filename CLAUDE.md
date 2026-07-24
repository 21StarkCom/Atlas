# CLAUDE.md — Atlas

Atlas is an **LLM-native second-brain wiki engine**: a pnpm/TypeScript monorepo whose CLI binary is **`brain`**. Markdown is the memory; SQLite is the operational + derived projection; LanceDB is the retrieval projection; **git is the only safety mechanism**; the LLM is a reasoning component, never the database.

**Atlas v2 is a single process.** `brain <cmd>` opens the vault working tree, the SQLite projection, and the LanceDB index; mutates notes; commits to git; exits. **One commit per applied ChangePlan on `refs/heads/main` is the audit trail *and* the undo** (`git revert <sha>` + `brain sync`). No brokers, no daemons, no OS identities, no privilege boundary except git itself.

v2 is a **deliberate in-place demolition** of the v1 security architecture — the pivot is **[ADR-0003](docs/adr/0003-retire-security-architecture.md)**. V1 was built security-first, contract-first, fail-closed over six PR-gated phases (privilege-separated brokers, scan-before-persist, a signed audit ledger, trust tiers, graduation); that fortress guarded a single-operator, single-machine playground against a threat model that does not exist here, and it blocked the agentic layer it was meant to protect. Every retired subsystem is revivable **only** from the **`v1-fortress`** annotated tag (which peels to `main` just before the first demolition PR) — code + provisioning, **not** migrated data.

This file is the constitution — read it, then reach for the directory's own `CLAUDE.md` (every surviving package has one) before guessing.

## Monorepo map

`apps/*` + `packages/*` + `tools` are the pnpm workspaces (`pnpm-workspace.yaml`). Every child below carries operational truth the code can't show — read it before working in that tree.

| Path | What it is / reach for it when… |
|------|--------------------------------|
| [`apps/cli/CLAUDE.md`](apps/cli/CLAUDE.md) | `@atlas/cli` — the single app, the `brain` binary. Router, config, render, errors, diag, and every command handler + the synthesis / evidence / retrieval / sync engine. |
| [`packages/contracts/CLAUDE.md`](packages/contracts/CLAUDE.md) | `@atlas/contracts` — zero-dep-besides-zod **leaf**. Stable IDs, `atlas-jcs-v1` canonical serialization, the identity-key algorithm, the **12-op ChangePlan** (`CHANGE_PLAN_OPS` SSOT, incl. `CreateRelationship`/`SetLink`), shared DTOs. |
| [`packages/sources/CLAUDE.md`](packages/sources/CLAUDE.md) | `@atlas/sources` — the md/txt/pdf/html normalizers. v2 (#334): the sandbox jail + scan guard are retired; `normalize()` parses **in-process**. |
| [`packages/sqlite-store/CLAUDE.md`](packages/sqlite-store/CLAUDE.md) | `@atlas/sqlite-store` — persistence core. Migration runner (through **0015**), projection rebuild from the vault, `db migrate`/`db rebuild`. Plain SQLite — no ledger, no backup/restore. |
| [`packages/lancedb-index/CLAUDE.md`](packages/lancedb-index/CLAUDE.md) | `@atlas/lancedb-index` — chunk → embed → write; FTS + vector retrieval layers; staleness/rebuild; the recall@10 + MRR eval harness. |
| [`packages/models/CLAUDE.md`](packages/models/CLAUDE.md) | `@atlas/models` — the **direct in-process Gemini client** (v2): lazy env→Keychain key resolution (`ATLAS_GEMINI_API_KEY` else the `atlas-gemini-api-key` Keychain item), `model_calls` persistence, the prompt registry. No egress broker, no capability. |
| [`packages/git/CLAUDE.md`](packages/git/CLAUDE.md) | `@atlas/git` — plain typed git plumbing. `commitPaths` writes one ChangePlan per commit **directly onto `refs/heads/main`** (v2 has no privilege boundary — the v1 unexported-`runGit` impossibility property is moot). |
| [`packages/jobs/CLAUDE.md`](packages/jobs/CLAUDE.md) | `@atlas/jobs` — the minimal SQLite-backed queue; sole owner of `jobs`/`job_attempts` + their migrations. The `jobs run` aggregate is the only path to exit `7`. |
| [`packages/testing/CLAUDE.md`](packages/testing/CLAUDE.md) | `@atlas/testing` — the `withFixtureVault` harness (copy a fixture into a throwaway git repo, tear down on exit). The fixture-vault-in-a-git-repo *is* the v2 shape. |
| [`tools/CLAUDE.md`](tools/CLAUDE.md) | The retained **CLI-contract harness** — registry SSOT, drift generators, the mega-gate `contract-lint.test.ts`, plus the v2 `no-retired-reference.test.ts` + `deprovision-allowlist.test.ts` gates. |
| [`provisioning/CLAUDE.md`](provisioning/CLAUDE.md) | The one human-run, `sudo`-requiring step that survives: **`deprovision-macos.sh` + `deprovision-allowlist.txt`** — deletes retired v1 host state (`atlas-*` users/groups, sockets, launchd services, the anchor dir, retired Keychain items) and **preserves `atlas-gemini-api-key`**. |
| [`docs/CLAUDE.md`](docs/CLAUDE.md) | The doc map + conventions — where each spec/plan/ADR/retro lives and which are generated. |
| [`fixtures/CLAUDE.md`](fixtures/CLAUDE.md) | The committed test corpus — which fixture exercises what, which tests consume it. |

Public face: [`README.md`](README.md).

## Build & test

```bash
pnpm install                              # Node ≥ 24, pnpm 11.15.0
pnpm -r build                             # tsc per package (strict / ESM / NodeNext)
pnpm -r test                              # vitest per package
node tools/gen-cli-contract.ts --check    # CLI-contract determinism gate (also `pnpm contract:check`)
```

- Deps are pinned **once** in the `catalog:` of `pnpm-workspace.yaml`; packages reference them as `"zod": "catalog:"`. Never add a floating version in a package.
- **CI** (`.github/workflows/ci.yml`): **zero-provisioning, daemon-free**. `ubuntu-latest` + `macos-15` matrix, Node 26 → `pnpm install --frozen-lockfile` → `pnpm -r build` → `pnpm -r test` → `node tools/gen-cli-contract.ts --check`. **macOS is the only supported target** (the Gemini key is read from the Keychain; env-var override elsewhere); the ubuntu leg is a portability canary for the platform-neutral suite. No two-UID / daemon / key-custody setup exists — the v1 provisioned-only suites are **deleted, not skipped**.
- `pnpm failpoints:check` gates the mutation-order crash-recovery matrix (rides `pnpm -r test`, not a separate CI step).
- **Key resolution (no launcher):** at process start `brain` reads `ATLAS_GEMINI_API_KEY` if set (the CI/test override), **else** reads the Keychain item `atlas-gemini-api-key` directly (`security find-generic-password -s atlas-gemini-api-key -w`). Held in-process only — never on disk, in logs, or in git.
- The `brain` binary is `apps/cli` `bin.brain → dist/bin.js`. Root resolution walks up for `docs/specs/cli-contract/commands.json`; a packaged install off the repo layout needs `ATLAS_ROOT` set.

## Conventions

- **TypeScript strict / ESM / NodeNext** (`tsconfig.base.json`: `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`, `verbatimModuleSyntax`, `isolatedModules`). Compile with `tsc` — no runtime type-stripping in prod. Narrow types over `any`. Bash: `set -euo pipefail`, lowercase-with-dashes filenames.
- **Exit codes** — the binary's `EXIT` set (`apps/cli/src/errors/envelope.ts`) is:

  | code | meaning |
  |---|---|
  | `0` | ok |
  | `1` | validation (incl. grounding failure — a dirty edited note) |
  | `2` | config / vault / lock |
  | `4` | internal |
  | `5` | usage |

  **`3` (secret-scan) and `6` (action-required) are retired** — no command emits them. The **only** path to `7` (provider-retryable) is the `jobs run` batch aggregate (`runner.ts` `aggregateExit` maps a transient-but-exhausted item to `7`); batch commands (`jobs run`) are also the sole exception to the single error envelope — they emit `{items[], aggregate}`. Otherwise retryability rides `retryable: true` + `retryAfterMs` on the error envelope at exit `4`.
- **Commits authored `Aryeh Stark <aryeh@21stark.com>`** (set per-repo; never let an `evinced.com` identity land here). **Branch + PR for everything — no direct-to-main, ever.** Every review finding gets posted on the PR (inline or summary) — nothing silently dropped.
- **Playground, not product.** No semver (`version 0.0.0`, `private: true` everywhere), no rollout ceremony — merge to main when the PR is green. Docs are honest about that posture; that is not licence to be sloppy.
- **Docs live with the code** under `docs/`, folder-per-type: `adr/` (`NNNN-<topic>.md`, immutable — supersede, don't edit), `specs/` (contracts flat; dated design specs `YYYY-MM-DD-<topic>-…`), `plans/`, `retros/`. **Update docs in the same change** as behavior/structure/command/env-var/ops changes.

## Safety model (git is the only boundary)

v2 has **no security boundary beyond git history — by design** (single operator, single machine, personal vault). `brain` runs as the invoking user with that user's full filesystem privileges. Full rationale + accepted residual risks: **[ADR-0003](docs/adr/0003-retire-security-architecture.md)**.

- **git is the audit trail *and* the undo.** Every applied ChangePlan is exactly one commit on `refs/heads/main`, touching only that plan's paths. `git log`/`git blame` is the audit; **`git revert <sha>` + `brain sync`** is the remediation (the revert restores the tree; the sync refolds the projection + index — a git-only revert leaves the derived stores stale by design).
- **The canonical mutation order** (`apps/cli/src/workflows/mutation-order.ts` `runMutation` — every mutating handler wraps it): take the vault lock (advisory `flock`) → assert `HEAD == refs/heads/main` → validate the ChangePlan (`@atlas/contracts`) → ground against the projection → dirty-vault check → capture the touched-path preimage → apply to the working tree → `commitPaths` (pathspec-scoped, touched paths only) → refresh **LanceDB then the SQLite projection** (`content_hash` IS the sync cursor) → release. A thrown apply/commit restores the preimage. Canonical ref **is** `refs/heads/main` — no indirection.
- **Dirty-vault doctrine.** Reads + `sync` treat a dirty tree as normal input. A mutating command tolerates **unrelated** dirt but fails grounding (exit `1`) if any note it edits/names is dirty — dirty being (on-disk hash ≠ projection `content_hash`) OR (an uncommitted git diff vs HEAD). A pre-existing external git `index.lock` ⇒ exit `2`.
- **Accepted residual risks** (ADR-0003, both owner-chosen — **do not re-add the retired machinery to "close" them**): (1) agents write **directly** into the real brain; git history is the only undo (one-commit-per-ChangePlan keeps reverts surgical). (2) Ingest is **unsandboxed + unscanned** — externally-sourced PDF/HTML bytes are parsed in-process with the operator's privileges and the in-process Gemini key reachable; the only control is the operator choosing what to `ingest`.

**Retired entirely — do NOT describe any of these as live** (revive only from the `v1-fortress` tag): the integration + egress brokers; all three OS identities + their provisioning daemons; `@atlas/scan` + scan-before-persist + quarantine; trust tiers + taint; the signed audit ledger + the four-step cross-store write protocol + AEAD backup/restore/watermark; the graduation pipeline; authorization challenges + capabilities + per-run budgets; the absorb-cycle sync + canonical-ref indirection; the Atlas Console + `atlas-signer` + `brain watch`. Packages `@atlas/broker` + `@atlas/scan` are deleted.

## CLI-contract workflow

The command surface is **data-driven and drift-proof**. `docs/specs/cli-contract/commands.json` (**version 2, 24 commands, all `implemented:true`** — the v2 survivor set, **55 → 24**) is the sole owner of command membership / phase / privilege / idempotency. Handlers register at import time. See [`tools/CLAUDE.md`](tools/CLAUDE.md) for the full harness.

**Folds:** `status` absorbs `doctor` + `db status` + `index status` + `sync status` (a `checks[]` of `vault-reachable`, `git-healthy`, `provider-key-present`, `index-not-stale`); `sync` = `reconcile()` (working tree vs projection, `content_hash` the cursor, no HEAD marker); `index rebuild` absorbs `index repair|status|verify`. **`link` is the one new command** — typed relationships live in the source note's frontmatter `related:` list (`CreateRelationship`, `--predicate`), plain links are body `[[wikilinks]]` (`SetLink`).

- **Add a command:** insert one name-sorted row in `commands.json`, add the matching `` `name` — desc `` line in `cli-surface.fixture.txt` under its phase heading, create `docs/specs/cli-contract/<name-with-spaces→hyphens>.schema.json`, set `implemented`, then `pnpm contract:write`. The registry↔fixture↔schema bijection gates enforce the rest.
- **Rename:** a one-row diff — change the row `name`, rename the fixture line, rename the schema file to the derived path, regenerate.
- **Implement:** flip `implemented:false→true` once the schema exists **and** the handler is registered (a barrel import + `registerCommand`). `command-registration.test.ts` guards the `not-implemented`-at-live-drive failure class (#145); `contract-lint.test.ts` binds each schema's `command`/phase/privilege/idempotency to its row.

## Current state & open work

Six v1 phases shipped; then the v2 pivot (**ADR-0003**) demolished the security architecture in place across phased PRs: the canonical mutation order + dirty-vault doctrine + canonical-ref removal (#325), the trust-tier / scan-gate / artifact-guard retirement (#326), the v2 reconcile `sync` engine (#329), markdown-derived typed relationships (#331), the shrunk 24-command surface (#333), the in-process source normalizers (#334), the flat vault-derived evidence model (#336/#337), the ledger + AEAD-backup strip (#338), the v2 `source` registry (#339/#340), and Phase-5 config-at-real-vault (#343) + `deprovision-macos.sh` + the allowlist gate (#344). Full-corpus retrieval still clears the normative gate (recall@10 ≥ 0.85 / MRR ≥ 0.70; default hybrid **0.911 / 0.830**).

**Persistence shape (v2):** migrations through **0015**. `evidence` = a flat **vault-derived** projection folded from note frontmatter `evidence:` (0014); `source` = an operational registry (0015); `note_links` v2 with a nullable predicate (0013). `db rebuild` regenerates the vault-derived projections (`notes`/`note_identity_keys`/`note_links`/`evidence`) and **never** touches the operational tables (`agent_runs`, `model_calls`, `jobs`, `source`, `retrieval_*`, `change_plans`, `patches`, `git_operations`). `agent_runs`/`model_calls` are plain operational tables — no ledger, no backup, no cross-store write protocol.

**Human-led remainder** (the "test live" rule; both owner-run on the live Mac):
- **#345** — the v2 live drive on the real `main-vault` (go/no-go for deprovision).
- **#346** — the live-Mac deprovision run (`deprovision-macos.sh --confirm`, `sudo`, never CI): removes retired v1 host state, preserves `atlas-gemini-api-key`.

**Closed as retired** (ADR-0003 + the `v1-fortress` tag are the sole revival path):
- **#60** — the live-vault-adoption-sync arc. The absorb-cycle + canonical-ref indirection are gone; `sync` is now a plain working-tree↔projection reconcile.
- **#65** — the ledger/backup DR hardening residuals. There is no ledger and no backup to harden.
- **#297** — SP-3 signer/doctor polish. The signer is gone; `doctor` folded into `status`.
- **#298** — the Console-cannot-reach-broker decision. The Console and the broker are both gone.

**Process gotchas (still load-bearing):**
- **pnpm pin: 11.15.0.** 11.12.0 was a broken release (`pnpm -r test` exited 127/1). If pnpm misbehaves, check the pin *first*; the global shim at `~/Library/pnpm/.pnpm/**/@pnpm/exe/pnpm` has also been observed literally blank.
- **Reviewer must prove it can run the suite before round 1** — a harness that can't execute `pnpm -r test` reviews blind and never converges.
- **Hard cap: 2 review rounds per step.** Round 3 = escalate with the open findings, not another pass.
- **Ceremony tier:** Atlas is a real product the owner wants, but process stays lean — spec *or* plan review (not spec→review→plan→review chains); decompose to phases (~6 issues), not tasks.
- **Lead-agent 900s timeout with zero files ⇒ kill and relaunch immediately**, don't wait it out.

## Pointers (SSOT)

- **Pivot decision:** [`docs/adr/0003-retire-security-architecture.md`](docs/adr/0003-retire-security-architecture.md) (accepted; supersedes ADR-0001 egress-scan + ADR-0002 P-256 signer).
- **v2 spec:** [`docs/specs/2026-07-21-atlas-v2-single-process-simplification-spec.md`](docs/specs/2026-07-21-atlas-v2-single-process-simplification-spec.md) — the finalized demolition + kept-core contract (`link`/`sync`/`status` schemas, exit-code set, mutation order).
- **v2 plan:** [`docs/plans/2026-07-21-atlas-v2-single-process-simplification-plan.md`](docs/plans/2026-07-21-atlas-v2-single-process-simplification-plan.md) — the 6-phase delivery.
- **Canonical mutation order:** `apps/cli/src/workflows/mutation-order.ts` (`runMutation`).
- **Command surface:** `docs/specs/cli-contract/commands.json` + [`tools/CLAUDE.md`](tools/CLAUDE.md); don't hand-edit the generated `commands-overview.md` / `failpoints.generated.md`.
- **v1 design + plan (superseded by ADR-0003 — revival reference only):** [`docs/specs/2026-07-11-atlas-v1-design.md`](docs/specs/2026-07-11-atlas-v1-design.md), [`docs/plans/atlas-v1-implementation-2026-07-12.md`](docs/plans/atlas-v1-implementation-2026-07-12.md).

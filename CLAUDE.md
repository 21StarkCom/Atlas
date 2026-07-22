# CLAUDE.md — Atlas

Atlas is an **LLM-native second-brain wiki engine**: a pnpm/TypeScript monorepo whose CLI binary is **`brain`**. Markdown is the memory; SQLite is the operational projection; LanceDB is the retrieval projection; Git is the safety/audit mechanism; the LLM is a reasoning component, never the database. It was built in **six PR-gated phases** (~96 commits, issues/PRs #1–#161) against one design SSOT, each phase opening with a *contracts gate* that lands the normative spec/schema before any feature code. The defining trait is **security-first, contract-first, fail-closed** construction — privilege-separated brokers, scan-before-persist, a WORM audit anchor, and machine-checked SSOT registries.

This file is the constitution — read it, then reach for the directory's own `CLAUDE.md` (every package has one) before guessing.

## Monorepo map

`apps/*` + `packages/*` + `tools` are the pnpm workspaces (`pnpm-workspace.yaml`). Every child below carries operational truth the code can't show — read it before working in that tree.

| Path | What it is / reach for it when… |
|------|--------------------------------|
| [`apps/cli/CLAUDE.md`](apps/cli/CLAUDE.md) | `@atlas/cli` — the single app, the `brain` binary. Router, config, render, errors, diag, and every command handler + the workflow/graduation/quarantine/trust/retrieval engine. |
| [`packages/contracts/CLAUDE.md`](packages/contracts/CLAUDE.md) | `@atlas/contracts` — zero-dep-besides-zod **leaf**. Stable IDs, `atlas-jcs-v1` canonical serialization, identity-key algorithm, the 17-op ChangePlan, audit/authorization Zod mirrors, shared DTOs. Byte-identity across the CLI↔broker seam. |
| [`packages/scan/CLAUDE.md`](packages/scan/CLAUDE.md) | `@atlas/scan` — the fail-closed secret detector (leaf). One versioned engine, two guards (`PrePersistenceGuard`, `GeneratedArtifactGuard`), quarantine-before-throw. |
| [`packages/sources/CLAUDE.md`](packages/sources/CLAUDE.md) | `@atlas/sources` — the sandboxed parser worker (macOS Seatbelt / Linux userns+seccomp+cgroup) + md/txt/pdf/html normalizers. Scan-before-persist inside the jail (D15). |
| [`packages/sqlite-store/CLAUDE.md`](packages/sqlite-store/CLAUDE.md) | `@atlas/sqlite-store` — persistence core. Migration runner, projection rebuild, the §2.8 ledger write protocol, AEAD backup/restore, `db verify`. |
| [`packages/lancedb-index/CLAUDE.md`](packages/lancedb-index/CLAUDE.md) | `@atlas/lancedb-index` — chunk → embed → fenced write; FTS + vector retrieval layers; staleness/verify/repair/rebuild; the recall@10 + MRR eval harness. |
| [`packages/models/CLAUDE.md`](packages/models/CLAUDE.md) | `@atlas/models` — the CLI-side typed IPC client for the egress broker. Capability minting + `model_calls` ledger persistence. Holds **no** credential or network. |
| [`packages/broker/CLAUDE.md`](packages/broker/CLAUDE.md) | `@atlas/broker` — the security kernel. Integration broker (`atlas-broker`) + egress broker (`atlas-egress`), two OS identities, two socket daemons. Sole protected-ref mutator + sole credential/network holder. |
| [`packages/git/CLAUDE.md`](packages/git/CLAUDE.md) | `@atlas/git` — typed git plumbing for the **agent side only**; protected-ref writes are structurally impossible (`runGit` unexported). |
| [`packages/jobs/CLAUDE.md`](packages/jobs/CLAUDE.md) | `@atlas/jobs` — the SQLite-backed durable queue; sole owner of `jobs`/`job_attempts` + their migrations. |
| [`packages/testing/CLAUDE.md`](packages/testing/CLAUDE.md) | `@atlas/testing` — the `withFixtureVault` harness (copy a fixture into a throwaway git repo, tear down on exit). |
| [`tools/CLAUDE.md`](tools/CLAUDE.md) | The retained **CLI-contract harness** — registry SSOT, drift generators, the mega-gate `contract-lint.test.ts`, the fixture authorization signer. Never reverted. |
| [`provisioning/CLAUDE.md`](provisioning/CLAUDE.md) | The one human-led, `sudo`-requiring step: OS identities, groups, key custody, WORM anchor, sockets, sandbox prerequisites. |
| [`docs/CLAUDE.md`](docs/CLAUDE.md) | The doc map + conventions — where each spec/plan/ADR/retro lives and which are generated. |
| [`fixtures/CLAUDE.md`](fixtures/CLAUDE.md) | The committed test corpus — which fixture exercises what, which tests consume it. |
| [`console/CLAUDE.md`](console/CLAUDE.md) | Atlas Console (SP-2) — a SwiftUI macOS app, **outside the pnpm workspace** (its own `swift build`/`swift test`). Pure read-face over `brain watch --json` + privileged-flow driver; opens no broker socket, imports no atlas internal package. |
| [`console/signer/CLAUDE.md`](console/signer/CLAUDE.md) | `atlas-signer` (SP-3) — the standalone Secure-Enclave P-256 authorization signer. Separate SwiftPM package, ad-hoc-built, **outside the pnpm workspace + not built in CI**. The one component that touches the SE approver key; re-derives + refuses on payload mismatch; its own exit table. |

Public face + runbook: [`README.md`](README.md) and [`docs/install.md`](docs/install.md) (provision → verify).

## Build & test

```bash
pnpm install                              # Node ≥ 24, pnpm ≥ 11
pnpm -r build                             # tsc per package (strict / ESM / NodeNext)
pnpm -r test                              # vitest per package
node tools/gen-cli-contract.ts --check    # CLI-contract determinism gate (also `pnpm contract:check`)
```

- Deps are pinned **once** in the `catalog:` of `pnpm-workspace.yaml`; packages reference them as `"zod": "catalog:"`. Never add a floating version in a package.
- **CI** (`.github/workflows/ci.yml`): **zero-provisioning, daemon-free** (phase-2-in-process-cutover, #312). `ubuntu-latest` + `macos-15` matrix, Node 26 → `pnpm install --frozen-lockfile` → `pnpm -r build` → `pnpm -r test` (`ATLAS_PROVISIONED` unset — no two-UID / daemon / key-custody setup) → `node tools/gen-cli-contract.ts --check`. The ubuntu leg is retained purely as a portability canary for the platform-neutral suite. (`provisioning/ci/setup.sh` is a retired no-op stub; the provisioned-only suites are deleted, not skipped, in Phase 3.)
- **`ATLAS_PROVISIONED=1`** unlocks the real two-UID / key-custody / WORM suites for a **local/manual** provisioned host. With it unset (CI, and local by default), tests run their daemon-free in-process subset (in-process `BrokerService` + local fixture vault). `pnpm failpoints:check` gates the crash-recovery matrix (rides `pnpm -r test`, not a separate CI step).
- The `brain` binary is `apps/cli` `bin.brain → dist/bin.js`. Root resolution walks up for `docs/specs/cli-contract/commands.json`; a packaged install off the repo layout needs `ATLAS_ROOT` set. Full runbook (provision, keys, live drive) in [`docs/install.md`](docs/install.md).

## Conventions

- **TypeScript strict / ESM / NodeNext** (`tsconfig.base.json`: `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`, `verbatimModuleSyntax`, `isolatedModules`). Compile with `tsc` — no runtime type-stripping in prod. Narrow types over `any`. Bash: `set -euo pipefail`, lowercase-with-dashes filenames.
- **Exit codes** — the binary's `EXIT` set caps at **6**:

  | code | meaning | | code | meaning |
  |---|---|---|---|---|
  | `0` | ok | | `4` | internal |
  | `1` | validation | | `5` | usage |
  | `2` | config / vault / lock | | `6` | action-required |
  | `3` | secret-scan | | | |

  The design SSOT names a nominal **`7` (provider-retryable)**; no single-error-envelope command emits it — retryability rides `retryable: true` + `retryAfterMs` on the error envelope at exit 4 or 6. The **one** process path that returns 7 is the `jobs run` batch aggregate (`runner.ts` `aggregateExit` maps a transient-but-exhausted item to 7; the jobs-run schema's `exitCode` enumerates it). Batch commands (`jobs run|retry|cancel`) are also the sole exception to the single error envelope — they emit `{items[], aggregate}`.
- **Commits authored `Aryeh Stark <aryeh@21stark.com>`** (set per-repo; never let an `evinced.com` identity land here). **Branch + PR for everything — no direct-to-main, ever.** Every review finding gets posted on the PR (inline or summary) — nothing silently dropped.
- **Playground, not product.** No semver (`version 0.0.0`, `private: true` everywhere), no rollout ceremony — merge to main when the PR is green. Docs are honest about that posture; that is not licence to be sloppy.
- **Docs live with the code** under `docs/`, folder-per-type: `adr/` (`NNNN-<topic>.md`, immutable — supersede, don't edit), `specs/` (contracts flat; dated design specs `YYYY-MM-DD-<topic>-…`), `plans/`, `retros/`. **Update docs in the same change** as behavior/structure/command/env-var/ops changes.

## Security model (in brief)

The privilege boundary is the reason this repo exists. Full contract: [`docs/specs/security-broker-contract.md`](docs/specs/security-broker-contract.md).

- **Two brokers, two OS identities** (plan decision D13). `atlas-broker` is the **sole** protected-ref mutator (canonical `refs/heads/main`, `refs/audit/runs`, trust ledger), the sole audit-append signer, and the WORM-anchor holder. `atlas-egress` is the **sole** provider-credential holder + sole outbound-network process, with **no vault/DB access** (excluded from the `atlas-git` group, D18). The CLI runs as unprivileged `atlas-agent` — network-denied at the UID (D17), never holds the attestation key, never writes a protected ref (`@atlas/git`'s `runGit` is unexported).
- **Egress quarantine + fail-closed scan.** Every boundary runs the *same* `@atlas/scan` engine; a dirty verdict quarantines the bytes (ciphertext-only, sealed to the CLI) **before** it throws (exit 3). Egress verifies a run-bound capability + per-run byte/token/cost budget, scans request bytes raw and the released response bytes (ADR-0001 — Gemini's `thoughtSignature` made the raw envelope unscanable). Nothing reaches a durable sink before the scan clears it.
- **Trust tiers + taint.** Trust resolution is fail-closed (default untrusted); taint takes the **floor**, never the average; empty inputs ⇒ untrusted. Risk is **deterministic + monotonic-up** (Tier-3 = review-required); the proposer's advisory tier is never read.
- **Privileged mutations are broker-authorized, never `--yes`.** `db restore`, `purge`, `graduation migrate --apply/--rollback`, `git approve/rollback`, `source trust promote/revoke`, `quarantine resolve` follow `--export-challenge` → sign → `--authorization <path>`; no authorization ⇒ exit 6. `--yes` explicitly never authorizes.
- **Graduation** is the fail-closed pipeline that brings a **real** vault onto Atlas: scan (working-tree + full git-history blob scan) → audit → deterministic, byte-exact, resumable migrate/rollback. A history-only credential hard-fails migrate even with a clean working-tree handshake.
- **Ledger integrity.** `refs/audit/runs` is signed-only, gapless-seq, chained, WORM-anchored; the §2.8 four-step cross-store write (intent → git append → ledger commit → backup+watermark) is crash-safe both directions; a degraded backup **blocks** all ledger-writing runs (`backup-unhealthy`, exit 2) until the watermark catches up (`db restore` stays available).

## CLI-contract workflow

The command surface is **data-driven and drift-proof**. `docs/specs/cli-contract/commands.json` (version 1, **55 commands, all `implemented:true`**) is the sole owner of command membership / phase / privilege / idempotency. Handlers register at import time; the broker *reads* `privilege`, never re-classifies. See [`tools/CLAUDE.md`](tools/CLAUDE.md) for the full harness.

- **Add a command:** insert one name-sorted row in `commands.json`, add the matching `` `name` — desc `` line in `cli-surface.fixture.txt` under its phase heading, create `docs/specs/cli-contract/<name-with-spaces→hyphens>.schema.json`, set `implemented`, then `pnpm contract:write`. The registry↔fixture↔schema bijection gates enforce the rest.
- **Rename:** a one-row diff — change the row `name`, rename the fixture line, rename the schema file to the derived path, regenerate.
- **Implement:** flip `implemented:false→true` once the schema exists **and** the handler is registered (a barrel import + `registerCommand`). `command-registration.test.ts` guards the `not-implemented`-at-live-drive failure class (#145); `contract-lint.test.ts` binds each schema's `command`/phase/privilege/idempotency to its row.

## Current state & open work

Six phases done; the full-corpus live drive is done (2026-07-17: 210 notes graduated, 0 refused; `index eval` passed the gate at **recall@10 0.878 / MRR 0.784** on the vector-only fallback — post-#159 the default hybrid config scores **0.911 / 0.830**; thresholds ≥ 0.85 / ≥ 0.70). **SP-2 Atlas Console shipped** (2026-07-20, PR #273 — all 6 console phases + the #257 live drive; the SP-3-gated Touch-ID round trip + manual GUI/VoiceOver passes are the human-led remainder, #286). **SP-3 `atlas-signer` shipped + driven live** (2026-07-20, PR #292 merged `adc7c85`, epic #290 — alg-agile P-256/Secure-Enclave authorization: broker p256 verify + D20-set + presence gate, the `atlas-signer` Swift CLI, `enroll-signer.sh` + R2 doctor check, the `security-broker-contract.md` amendment; #272 re-anchored). **P6 signer half done; #286 stays OPEN for the Console/a11y half** — the prod broker was upgraded to SP-3 and a real Secure-Enclave key (`approver-se-<host>-v1`, `alg p256` + `presence`) authorized a live `source trust promote`→`revoke` round trip via Touch ID (the broker verified a genuine SE p256 signature and applied the effect; vault restored) ([`docs/retros/2026-07-20-atlas-signer-live-drive-retro.md`](docs/retros/2026-07-20-atlas-signer-live-drive-retro.md) — **read it before any signer/Console drive**). The SP-3 signer/broker mechanism needs nothing further; **#286's remainder is the Console GUI round trip (blocked by #298) + the #254 VoiceOver/Full-Keyboard-Access checklist**. The drive surfaced two open findings (#297 signer/doctor polish, #298 below) and left the `--presence` quarantine grant enrolled but never exercised live; a third (#296, trust read surface) was **retracted** — already fixed on main by #218, a stale feature-branch drive binary caused the false symptom. Open issues:

- **#298** — the **Console cannot reach the broker on a spec-compliant install**: the cockpit spec runs it as the *operator*, but `atlas-git` is normatively `atlas-agent` + `atlas-broker` only. Needs a decision (operator in the group / provisioned privilege-drop launcher / explicit "run brain as" setting / re-scope).
- **#297** — SP-3 polish: `atlas-signer` discards the actionable `LAError` detail (a closed laptop lid reads as "Authentication canceled"); `doctor`'s `signer-registry` reports a vacuous `ok`; `doctor` and `db status` disagree on backup health.

- **#60** — the live-vault-adoption-sync arc (60-A/60-B, plan `docs/plans/2026-07-19-live-vault-adoption-sync-plan.md`): Phases 1–3 merged (#274/#277/#278 — config-driven canonical ref, `sync_cursors`, scoped reconcile + incremental fold, `index:reconcile` job kind); Phase 4 (#266, merged) adds `sync` + `sync status` + the absorb-cycle engine; Phase 5 (#267, merged) adds `sync reset` — the privileged, broker-authorized tree-reconcile recovery from a divergence/exit-3 halt (accepts an audited history gap; reuses git approve's authorized FF advance, one-line broker change); Phase 6 (#268) closes the ingest→index auto-hook — `com.atlas.sync` (300 s launchd timer, `atlas-agent`) runs `atlas-sync-wrapper.sh` = `brain sync --json` then `brain jobs run --all --json`, with the capability secret fetched from the Keychain and handed to the drain on **fd 3** (never on disk, never in an environment) and the timer installed **disabled** behind a five-gate `services.sh enable-sync` probe. Still owed: the Phase-6 live drive on the real vault, then the deferred slices (60-C purge E2E, 60-D `tools/scale-bench.ts`, 60-E workflow runs on the migrated copy — the real-copy apply stays **human-gated**, D20).
- **#65** — Ledger/backup DR hardening residuals from the #23 review (seq-allocator rewind on older-cut restore, universal-startup interrupted-restore recovery, deleted/corrupt-live-DB restore, `markCovered` clearing a block early, unhonored retry backoff, `--force-unblock` wrongly needing the AEAD key). Real, not phase-blocking.

**Live-drive gotchas** (from [`docs/retros/2026-07-18-search-index-live-drive-retro.md`](docs/retros/2026-07-18-search-index-live-drive-retro.md), the authoritative source): a drive broker needs its **own** fresh clone of the graduation copy + fresh anchor (grad-copy carries graduation's `refs/audit/runs`, so a fresh ledger's seq 0 collides); commit the migration before cloning and `git rm -r .bootstrap-backup`; a fresh ledger needs `db migrate` before `db rebuild`; export `ATLAS_EGRESS_CAPABILITY_KEY` for every mint-bearing command (`index rebuild`/`index eval`/`query`); the apply challenge nonce has a short TTL — sign + apply promptly.

**Process gotchas (from the 2026-07-18 SP-1 step-1 run — 12h for one step; don't repeat):**
- **pnpm pin:** `packageManager` was pinned to **11.12.0, a broken release** — every `pnpm -r test` exited 127/1. Now pinned **11.15.0**. If pnpm misbehaves, check the pin *first*; the global shim at `~/Library/pnpm/.pnpm/**/@pnpm/exe/pnpm` has also been observed literally blank.
- **Reviewer must prove it can run the suite before round 1.** A review harness that can't execute `pnpm -r test` reviews blind and never converges (5 rounds → `max_rounds_unresolved`, ~2h lost). Broken harness ⇒ abort and fix, never "review on `tsc --noEmit` only".
- **Hard cap: 2 review rounds per step.** Round 3 = escalate to Aryeh with the open findings, not another pass.
- **Ceremony tier:** this repo is a real product Aryeh wants (decided 2026-07-18), but process stays lean — spec *or* plan review, not spec→spec-review→plan→plan-review chains; decompose to phases (~6 issues), not tasks (26).
- **Lead-agent 900s timeout with zero files ⇒ kill and relaunch immediately**, don't wait it out.

## Pointers (SSOT)

- **Design SSOT:** [`docs/specs/2026-07-11-atlas-v1-design.md`](docs/specs/2026-07-11-atlas-v1-design.md) (V1 capability + architecture; the "In V1 / Out of V1" list is normative).
- **Implementation plan:** [`docs/plans/atlas-v1-implementation-2026-07-12.md`](docs/plans/atlas-v1-implementation-2026-07-12.md) (§2.5 global constants, §2.6 decisions D1–D20, §2.7 migration ownership, §2.8 write protocol).
- **The one ADR:** [`docs/adr/0001-egress-response-scan-released-bytes.md`](docs/adr/0001-egress-response-scan-released-bytes.md).
- **Contract specs** (each gates a phase, machine-checked against code) live flat in `docs/specs/` — see [`docs/CLAUDE.md`](docs/CLAUDE.md) for the map. Don't hand-edit the generated `commands-overview.md` / `failpoints.generated.md`.

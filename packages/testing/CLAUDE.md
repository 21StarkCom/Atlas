# `@atlas/testing` — the fixture-vault harness

Single-purpose workspace package (`v0.0.0`, private, ESM). It exposes **one runtime helper — `withFixtureVault`** — plus three types. That is the entire public surface. This is **not** a general test-utils grab bag; the substantive test seams (provisioning gates, e2e harnesses, `ATLAS_TEST_MODE`) live in the packages that own them (see [Repo-wide test topology](#repo-wide-test-topology)).

`withFixtureVault(name, fn)` copies a committed `fixtures/<name>/` vault into a throwaway temp dir, wraps it in a **fresh real git repo**, hands the callback an isolated working copy + a tiny git handle, and always tears the temp dir down. The point is **isolation**: a test mutates a copy, never the committed `fixtures/` tree. The corpus itself is documented in [`../../fixtures/CLAUDE.md`](../../fixtures/CLAUDE.md).

## Key files

- `src/fixture.ts` — the whole implementation (~120 lines): `withFixtureVault` + `git()` handle factory + the `FixtureName` union + the two context interfaces.
- `src/index.ts` — barrel: re-exports `withFixtureVault` + `FixtureName`/`FixtureVaultContext`/`SimpleGitHandle`.
- `test/fixture.test.ts` — tests the harness **and** doubles as a **fixture-integrity guard** (see Invariants).
- `package.json` — deps are only `@types/node`/`typescript`/`vitest` (all `catalog:`). Test script: `vitest run --passWithNoTests`.

## `withFixtureVault` mechanics (`src/fixture.ts:82`)

1. Resolve `fixtures/<name>` against `FIXTURES_ROOT = resolve(dir-of-this-module, "../../../fixtures")` — three levels up. This resolves correctly whether vitest runs the **TS source** (`src/`) or a **built `dist/`** artifact (both sit 3 levels below repo root). Missing source ⇒ `throw new Error("fixture vault not found: …")`.
2. `mkdtemp(tmpdir(), "atlas-fixture-<name>-")` → temp dir; `cp(source, vaultDir, {recursive})` copies the fixture **contents**.
3. `git init -q -b main`; set a **deterministic self-contained identity** `user.name=Atlas Fixture` / `user.email=fixtures@atlas.local` / `commit.gpgsign=false` (never touches the caller's global git config); `git add -A`; one commit `fixture: <name>` (identity re-passed via `-c` on the commit, belt-and-suspenders).
4. `await fn({ vaultDir, git })`, then `finally { rm(vaultDir, {recursive, force}) }` — torn down **even when the callback throws**.

Git is driven **directly through `node:child_process` `execFileSync`** — no git library, per the task contract. Contrast: the production `@atlas/git` package wraps git; this harness deliberately does not depend on it.

`SimpleGitHandle` = `{ dir; run(args) → trimmed stdout; head(); status(); isClean() }` (`isClean()` ⇔ `git status --porcelain` empty).

## Public surface & the sync rule

`FixtureName` is a **hand-synced** 7-member union (`src/fixture.ts:21`): `empty`, `small-valid`, `broken-links`, `duplicate-ids`, `conflicting-claims`, `source-heavy`, `schema-v1`. Adding a fixture vault dir requires editing **both** the union and the `ALL_FIXTURES` mirror in `test/fixture.test.ts:11`. **Nothing enforces this automatically** (unlike the CLI-contract lint in `tools/`).

`fixtures/` also holds two siblings **deliberately NOT in the union** — `fixtures/inputs/` and `fixtures/retrieval-eval/`. They are not vaults; tests read them by direct path, never via `withFixtureVault`.

## Invariants (all pinned by `test/fixture.test.ts`)

- **No leakage into `fixtures/`** — the load-bearing invariant. `:55-77` mutates + adds files in the copy and asserts the committed `small-valid/project-meridian.md` is byte-identical and the dir gained no files.
- **Fresh git repo per copy ⇒ clean working tree** (`:26-53`, all 7 fixtures: `vaultDir !== fixtures/<name>`, `isClean()`, `head()` matches `/^[0-9a-f]{40}$/`).
- **Teardown on throw** (`:79-89`). **Unknown name rejected** at runtime + compile-time via `@ts-expect-error` (`:123-128`).
- **`fixture.test.ts` is also a fixture-content guard**, not just a harness test:
  - `duplicate-ids` really shares an `id:` across ≥2 notes (`:91-106`).
  - `fixtures/inputs/adversarial-ansi.md` preserves **raw C1 CSI bytes**: exact `0x9b 33 31 6d` (set) + `0x9b 30 6d` (reset), and guards against an **earlier bug** where a literal `0x22` quote followed `0x9b` (`:108-121`). This ties the package to the scan/ANSI adversarial corpus — an editor that "helpfully" rewrites `0x9b` to `ESC [` or inserts a quote silently breaks the scan corpus, and this test is the tripwire.

## Gotchas & sharp edges

- **The `fixture.ts` docstring overstates reach.** It claims "Every E2E/integration test consumes `withFixtureVault`" (`src/fixture.ts:3`). **False.** Only `apps/cli/test/vault.test.ts:18` imports it. Every e2e/broker/models/ledger harness rolls its own temp git vault (`cpSync` or inline seeding). Grep the imports; don't trust the comment.
- **Vestigial `@atlas/testing` devDeps** in `packages/broker/package.json:29` and `packages/models/package.json:26` — declared `workspace:*`, **never imported** (zero `from "@atlas/testing"` in their test trees). `apps/cli` is the only real consumer.
- **Identity mismatch (cosmetic, not uniform):** this harness commits as `Atlas Fixture <fixtures@atlas.local>`; the broker/ledger/phase2 harnesses commit as `Aryeh Stark <aryeh@21stark.com>` (the repo commit-author rule); the models harness uses a throwaway `A <a@b.c>`.
- **No automated `FixtureName` ⇄ `fixtures/` drift check** exists. A small test enumerating `fixtures/` dirs and asserting the union covers the vault dirs (excluding `inputs`/`retrieval-eval`) would close the gap.

## Repo-wide test topology

Material the code can't show, for anyone reasoning about "the testing area" (the seams themselves are owned by other packages — cross-link, don't edit here):

- **Runner:** vitest. Per-package `test` = `vitest run`; CI runs `pnpm -r test` (each package runs its own). Root `vitest.workspace.ts` is a convenience aggregate (`packages`/`apps`/`tools`, all `passWithNoTests: true`). Only `packages/sources` carries its own `vitest.config.ts`. **164 `*.test.ts`** repo-wide.
- **`ATLAS_PROVISIONED=1`** gates suites needing the real two-UID identity + file-key custody + WORM-anchor layout. **CI is zero-provisioning, daemon-free** (phase-2-in-process-cutover, #312): `.github/workflows/ci.yml` leaves `ATLAS_PROVISIONED` unset and starts no daemons, so those suites run their in-process subset (in-process `BrokerService` + local git fixture vault) — the same subset as an unprovisioned local host. Set `ATLAS_PROVISIONED=1` only on a local/manual provisioned host (`provisioning/dev/setup.sh`) to exercise the real two-UID paths; the provisioned-only suites are deleted, not skipped, in Phase 3.
- **Skip idioms in use:** `describe.skipIf(!existsSync(BIN))` (needs a built `dist` bin); `SANDBOX.supported ? describe : describe.skip` (Seatbelt/seccomp); `it.skipIf(platform() !== …)`; `describe.runIf(process.env.ATLAS_LIVE_GEMINI === "1")` (**opt-in live network** — `broker/test/egress.gemini-adapter.test.ts`, `apps/cli/test/retrieval-eval.test.ts`).
- **E2E/integration suites build their OWN temp git vaults**, NOT `withFixtureVault`: `apps/cli/test/e2e/phase1.e2e.test.ts` (`cpSync` seed + real broker over a Unix socket); `apps/cli/test/e2e/phase2-support.ts` (`makePhase2Harness()` — inline-seeded notes, real `BrokerService` + `EgressService` + fake-adapter `ModelsClient`, migrated ledger, AEAD backup custody; the byte-level all-sinks release-blocking exit proof); `packages/broker/test/harness.ts`, `packages/models/test/harness.ts`, `packages/sqlite-store/test/ledger/harness.ts` (each `mkdtemp` + `git init` + inline seed, the "runs without `ATLAS_PROVISIONED`" local harnesses).

## Test-mode seams (`ATLAS_TEST_MODE`) — owned elsewhere, security-relevant

Production code carries seams honoured **only under `ATLAS_TEST_MODE=1`**, so tests exercise real provisioned code paths on an unprovisioned host. **Launchers NEVER set it** (`packages/broker/bin/atlas-broker.ts:8`); it stands between the test signer / custody override and a production install — never set it in any launcher or provisioning path.

- **Broker test-signer gate (D20):** the `atlas-test-approver` signer is **hard-rejected unless `ATLAS_TEST_MODE=1`** (`broker/src/authorize.ts`), pinned by `broker/test/broker.rejects-test-signer-in-prod.test.ts`. See [`../broker/CLAUDE.md`](../broker/CLAUDE.md).
- **Custody + quarantine-dir seams:** `apps/cli/src/quarantine/config.ts` + `commands/backup-config.ts` swap the per-OS keys/state dirs for `ATLAS_CUSTODY_TEST_DIR` **only** under `ATLAS_TEST_MODE=1`, exercising the SAME custody layout. See [`../../apps/cli/CLAUDE.md`](../../apps/cli/CLAUDE.md). The quarantine-dir seam came from **#144/#150** — fixtures with `quarantine.dir` unset wrote into the shared OS state dir, so a host carrying real sealed bundles failed `doctor`.

## History & open items

- **PR #61** (`21f8125`, "Phase 0: Scaffold + retained harness + up-front contracts") is the **only commit that has ever touched `packages/testing/`.** It landed everything in its current form; "retained harness" = carried over from a pre-Phase-0 prototype. **The package has not changed since.**
- The rest of the "testing area" evolved with its owning packages (e.g. `phase2-support.ts` under #36; `graduation.e2e` under #60; the quarantine-dir seam under #144/#150), not here.
- Open follow-ups (small, unowned): fix/delete the false docstring claim; prune the vestigial broker/models devDeps (or route their harnesses through the package); add the `FixtureName` ⇄ `fixtures/` drift check. Open **#60** (graduation E2E) and **#65** (ledger/backup DR hardening) exercise the provisioning-gated + `ATLAS_TEST_MODE` surface most heavily.

# `@atlas/testing` — the fixture-vault harness

Single-purpose workspace package (`v0.0.0`, private, ESM). It exposes **one runtime helper — `withFixtureVault`** — plus three types. That is the entire public surface. This is **not** a general test-utils grab bag; the substantive test seams (`ATLAS_TEST_MODE`, e2e harnesses) live in the packages that own them (see [Repo-wide test topology](#repo-wide-test-topology)).

`withFixtureVault(name, fn)` copies a committed `fixtures/<name>/` vault into a throwaway temp dir, wraps it in a **fresh real git repo**, hands the callback an isolated working copy + a tiny git handle, and always tears the temp dir down. The point is **isolation**: a test mutates a copy, never the committed `fixtures/` tree. The corpus itself is documented in [`../../fixtures/CLAUDE.md`](../../fixtures/CLAUDE.md).

The harness is v1-and-v2 identical — it never touched the security architecture the v2 demolition retired, so it carried through unchanged.

## Key files

- `src/fixture.ts` — the whole implementation (~120 lines): `withFixtureVault` + `git()` handle factory + the `FixtureName` union + the two context interfaces.
- `src/index.ts` — barrel: re-exports `withFixtureVault` + `FixtureName`/`FixtureVaultContext`/`SimpleGitHandle`.
- `test/fixture.test.ts` — tests the harness **and** doubles as a **fixture-integrity guard** (see Invariants).
- `package.json` — deps are only `@types/node`/`typescript`/`vitest` (all `catalog:`). Test script: `vitest run --passWithNoTests`.

## `withFixtureVault` mechanics (`src/fixture.ts:82`)

1. Resolve `fixtures/<name>` against `FIXTURES_ROOT = resolve(dir-of-this-module, "../../../fixtures")` — three levels up (`src/fixture.ts:60`). This resolves correctly whether vitest runs the **TS source** (`src/`) or a **built `dist/`** artifact (both sit 3 levels below repo root). Missing source ⇒ `throw new Error("fixture vault not found: …")` (`src/fixture.ts:87`).
2. `mkdtemp(tmpdir(), "atlas-fixture-<name>-")` → temp dir; `cp(source, vaultDir, {recursive})` copies the fixture **contents**.
3. `git init -q -b main`; set a **deterministic self-contained identity** `user.name=Atlas Fixture` / `user.email=fixtures@atlas.local` / `commit.gpgsign=false` (never touches the caller's global git config); `git add -A`; one commit `fixture: <name>` (identity re-passed via `-c` on the commit, belt-and-suspenders).
4. `await fn({ vaultDir, git })`, then `finally { rm(vaultDir, {recursive, force}) }` — torn down **even when the callback throws**.

Git is driven **directly through `node:child_process` `execFileSync`** — no git library, per the task contract. Contrast: the production `@atlas/git` package wraps git; this harness deliberately does not depend on it.

`SimpleGitHandle` = `{ dir; run(args) → trimmed stdout; head(); status(); isClean() }` (`isClean()` ⇔ `git status --porcelain` empty).

## Public surface & the hand-sync rule

`FixtureName` is a **hand-synced** 7-member union (`src/fixture.ts:21`): `empty`, `small-valid`, `broken-links`, `duplicate-ids`, `conflicting-claims`, `source-heavy`, `schema-v1`. Adding a fixture vault dir requires editing **both** the union and the `ALL_FIXTURES` mirror in `test/fixture.test.ts:11`. **Nothing enforces this automatically** (unlike the CLI-contract lint in `tools/`).

`fixtures/` also holds two siblings **deliberately NOT in the union** — `fixtures/inputs/` and `fixtures/retrieval-eval/`. They are not vaults; tests read them by direct path, never via `withFixtureVault`.

## Invariants (all pinned by `test/fixture.test.ts`)

- **No leakage into `fixtures/`** — the load-bearing invariant. `:57-79` mutates + adds files in the copy and asserts the committed `small-valid/project-meridian.md` is byte-identical and the dir gained no files.
- **Fresh git repo per copy ⇒ clean working tree** (`:29-43`, all 7 fixtures: `vaultDir !== fixtures/<name>`, `isClean()`, `head()` matches `/^[0-9a-f]{40}$/`).
- **Teardown on throw** (`:81-91`). **Unknown name rejected** at runtime + compile-time via `@ts-expect-error` (`:125-130`).
- **`fixture.test.ts` is also a fixture-content guard**, not just a harness test:
  - `duplicate-ids` really shares an `id:` across ≥2 notes (`:93-108`).
  - `fixtures/inputs/adversarial-ansi.md` preserves **raw C1 CSI bytes**: exact `0x9b 33 31 6d` (set) + `0x9b 30 6d` (reset), and guards against an **earlier bug** where a literal `0x22` quote followed `0x9b` (`:110-123`). Those raw bytes still feed the terminal renderer's ANSI-escaping tests (`apps/cli/test/renderer.test.ts`) and the source-normalizer conformance suite (`packages/sources/test/normalization-conformance.test.ts`) — this test is the byte-integrity tripwire: an editor that "helpfully" rewrites `0x9b` to `ESC [` or inserts a quote silently breaks those consumers.

## Gotchas & sharp edges

- **The `fixture.ts` docstring overstates reach.** It claims "Every E2E/integration test consumes `withFixtureVault`" (`src/fixture.ts:3`). **False.** Only `apps/cli/test/vault.test.ts:18` imports it; every other e2e/integration suite builds its own temp git vault. Grep the imports; don't trust the comment.
- **Vestigial `@atlas/testing` devDep** in `packages/models/package.json:24` — declared `workspace:*`, **never imported** (zero `from "@atlas/testing"` in its test tree). `apps/cli` is the only real consumer.
- **Identity mismatch (cosmetic):** this harness commits as `Atlas Fixture <fixtures@atlas.local>`; the models harness uses a throwaway `A <a@b.c>`. Neither matches the repo commit-author rule (`Aryeh Stark <aryeh@21stark.com>`) — irrelevant, these commits never leave a temp dir.
- **No automated `FixtureName` ⇄ `fixtures/` drift check** exists. A small test enumerating `fixtures/` dirs and asserting the union covers the vault dirs (excluding `inputs`/`retrieval-eval`) would close the gap.

## Repo-wide test topology

Material the code can't show, for anyone reasoning about "the testing area" (the seams themselves are owned by other packages — cross-link, don't edit here):

- **Runner:** vitest. Per-package `test` = `vitest run`; CI runs `pnpm -r test` (each package runs its own). Root `vitest.workspace.ts` is a convenience aggregate (`packages`/`apps`/`tools`, all `passWithNoTests: true`). Only `packages/sources` carries its own `vitest.config.ts`. **~118 `*.test.ts`** repo-wide.
- **CI is the only mode — zero-provisioning, daemon-free** (#323). Atlas v2 is a **single process**, so there is nothing to provision: no OS identities, no daemons, no key custody. `.github/workflows/ci.yml` runs `pnpm install --frozen-lockfile` → `pnpm -r build` → `pnpm -r test` → `node tools/gen-cli-contract.ts --check` on an `ubuntu-latest` + `macos-15` matrix. The old `ATLAS_PROVISIONED` two-UID gate is retired.
- **Skip idioms in use:** `describe.skipIf(!existsSync(BIN))` — needs a built `dist` bin (`apps/cli/test/bin.test.ts`, `jobs.single-runner-exclusion.test.ts`, `locks.mutation-order.test.ts`); `describe.runIf(process.env.ATLAS_LIVE_GEMINI === "1")` — **opt-in live network** (`apps/cli/test/retrieval-eval.test.ts`, `packages/models/test/gemini-adapter.direct.test.ts`).
- **E2E suites build their OWN temp git vaults**, NOT `withFixtureVault`: `apps/cli/test/agentic.e2e.test.ts` and `apps/cli/test/e2e/synthesis-apply.e2e.test.ts` (inline-seeded notes over a real git repo + the fake-provider `ModelsClient`).

## `ATLAS_TEST_MODE` seam — owned elsewhere

Production code carries seams honoured **only under `ATLAS_TEST_MODE=1`**, so tests can drive real code paths with a deterministic double. Owned by `apps/cli` + `packages/models`, cross-linked here — not restated:

- **Fake Gemini provider:** `packages/models/src/client.ts` swaps the real in-process Gemini client for a deterministic fake only when **both** `ATLAS_TEST_MODE=1` and `ATLAS_FAKE_PROVIDER=1` are set and no explicit key is present. See [`../models/CLAUDE.md`](../models/CLAUDE.md).
- **`sync` crash-safety failpoints:** `apps/cli/src/commands/sync.ts` honours `ATLAS_SYNC_FAILPOINT` (`after-purge-txn`, `before-fts`) only under `ATLAS_TEST_MODE=1`, to inject a crash between reconcile steps and assert recovery. See [`../../apps/cli/CLAUDE.md`](../../apps/cli/CLAUDE.md).
- **LanceDB mutation counting:** `sync.ts` + `commands/index-ops.ts` write a mutation count to `ATLAS_LANCE_MUTATION_COUNT_FILE` only under `ATLAS_TEST_MODE=1`, so a test can assert the index was (or was not) touched.

## History & open items

- **The harness implementation (`src/fixture.ts`) has not changed since PR #61** (`21f8125`, "Phase 0: Scaffold + retained harness + up-front contracts") — "retained harness" = carried over from a pre-Phase-0 prototype. It survived the v2 demolition untouched because it never depended on the retired architecture.
- The rest of the package moved lightly: `test/fixture.test.ts` got a 3-line edit under #266 (Phase-4 `sync`); this CLAUDE.md was touched under #162 and #323.
- Open follow-ups (small, unowned): fix/delete the false docstring claim (`src/fixture.ts:3`); prune the vestigial `@atlas/testing` devDep in `packages/models/package.json:24` (or route the models harness through the package); add the `FixtureName` ⇄ `fixtures/` drift check.

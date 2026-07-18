# fixtures/ — committed test corpus

Hand-authored, version-controlled test data consumed by E2E/integration tests across the monorepo. Three shapes live here:

1. **Fixture vaults** — small dirs standing in for a whole Atlas vault, each engineered to trip ONE reader/identity/fold behaviour. Copied into a throwaway temp git repo by `withFixtureVault()` ([`../packages/testing/src/fixture.ts`](../packages/testing/src/fixture.ts)) — tests mutate the copy, never this tree.
2. **`inputs/`** — single-file ingest inputs (per-format + two adversarial). Not vaults; read by direct path.
3. **`retrieval-eval/`** — a labeled query set. Not a vault; read by direct path.

**Disambiguation:** the byte-exact graduation-migration golden fixtures at `../docs/specs/fixtures/bootstrap-migration/` are a *different* tree — out of scope here. Don't conflate.

## The seven fixture vaults

The `FixtureName` union ([`fixture.ts:21-28`](../packages/testing/src/fixture.ts)) IS this list — **hand-synced**, nothing enforces it (mirror in [`fixture.test.ts:11-19`](../packages/testing/test/fixture.test.ts)). `inputs/` and `retrieval-eval/` are deliberately excluded (not copyable vaults).

| Vault | Plants | Primary consumer(s) |
|---|---|---|
| `empty/` (`.gitkeep`) | empty vault; also the **blank canvas** most wiki-link/identity tests write notes into at runtime | `apps/cli/test/vault.test.ts` (empty snapshot + wiki-link/collision cases) |
| `small-valid/` (3 interlinked notes) | all links resolve; parses zero errors | `apps/cli/test/vault.test.ts`; `e2e/phase1.e2e.test.ts` (`cpSync` seed) |
| `broken-links/` | one note links `[[does-not-exist]]` + a resolvable `[[anchor-note]]` | `vault.test.ts` ("surfaces broken links as typed errors, not throws") |
| `duplicate-ids/` | two notes share `id: shared-id-conflict` | `vault.test.ts` ("surfaces BOTH offenders"); `fixture.test.ts:91-106` (integrity guard) |
| `conflicting-claims/` | two `decision` notes assert Meridian launched 2025 vs 2026 | `packages/sqlite-store/test/claims-fold.test.ts` (rebuild via `0004_claims`) |
| `source-heavy/` | source manifests + raw `.txt` blobs w/ full `provenance:`/`contentId`; the retrieval-eval target corpus | `packages/sqlite-store/test/provenance-fold.test.ts` (`0003_provenance`); retrieval-eval labels |
| `schema-v1/` | one minimal `schema_version: 1` note | **under-consumed** — only `fixture.test.ts`'s all-seven smoke loop loads it (see Open items) |

**`withFixtureVault(name, fn)`:** `cp -r` fixture into `mkdtemp` → `git init -b main` w/ deterministic identity `Atlas Fixture <fixtures@atlas.local>` + `commit.gpgsign=false` → one commit → `fn({vaultDir, git})` → `finally rm` (torn down **even on throw**). `FIXTURES_ROOT` resolves 3 levels up from `src` OR `dist`, so it works on TS source and built artifact alike. Only source-level importer: `apps/cli/test/vault.test.ts`; e2e/broker/ledger harnesses roll their own temp vaults instead (see `../packages/testing/CLAUDE.md`).

## inputs/

- `sample.{md,txt,html,pdf}` — the per-format normalizer matrix (`packages/sources/test/normalization-conformance.test.ts`, `FIXTURES = ../../../fixtures/inputs/`; contract `../docs/specs/normalization-contract.md §5`). `sample.pdf` is a **real** PDF 1.4, 1 page, 609 bytes — don't regenerate casually; extraction behaviour is pinned.
- `adversarial-ansi.md` — real control/ANSI bytes for the terminal-safe renderer.
- `secret-bearing.md` — synthetic broken secret shapes for the fail-closed scanner.

## retrieval-eval/

`queries.json` (4 queries) + `labels.json` (expected note ids), `version: 1` **in lockstep**. All targets 1:1 over `source-heavy`: `q-synthesis`→`research-synthesis-accessibility`, `q-wcag`→`source-2026-07-11-wcag-notes`, `q-interview`→`source-2026-07-11-interview`, `q-analyst`→`person-analyst`. Read by direct path (`../../../fixtures/retrieval-eval/…`):

- `packages/lancedb-index/test/eval.test.ts` — **offline**: metric math + internal-consistency invariant (`:71-88` — versions equal, unique query ids, every query ≥1 label, every label key a known query id).
- `apps/cli/test/retrieval-eval.test.ts` — **LIVE** (opt-in `ATLAS_LIVE_GEMINI=1`), drives `brain query … --no-answer --json`.

Scored by `runRetrievalEval` (`packages/lancedb-index/src/eval.ts`): **recall@10** + **MRR**. This is the fixed yardstick for the `brain index eval` graduation gate — **recall@10 ≥ 0.85, MRR ≥ 0.70** (`../docs/specs/acceptance-thresholds.md §retrieval`). Per `queries.json`'s own description, it "grows on the graduation copy, never mutated in phase code."

## Invariants — do NOT "clean up"

- **No leakage into committed fixtures.** The temp-copy + always-teardown model is the whole point; proven by `fixture.test.ts:55-77`.
- **`adversarial-ansi.md` bytes ARE the fixture.** It carries a **raw `0x9b` C1 CSI introducer** (single byte, SGR params immediately following) plus OSC-8/OSC-52, C0 controls, CR-overwrite, RLO/PDF bidi. `fixture.test.ts:108-121` asserts the exact `0x9b 31m`/`0x9b 0m` sequences and guards against a **past regression** where a literal `0x22` quote followed `0x9b`. An editor that rewrites `0x9b`→`ESC [` silently breaks the scan corpus.
- **`secret-bearing.md` secrets are deliberately BROKEN.** Every value is synthetic and split with a `⟪BREAK⟫` marker so GitHub push protection (public repo) can't match it. RAW-scan proof: `packages/sources/test/normalize.scans-before-return.test.ts` — yields NO rendition, quarantines the bytes, throws `SecretDetectedError` (exit 3, quarantine-before-throw). **Live-format** secrets are NEVER committed — assembled at runtime *inline in the scan/sources tests* (`packages/scan/test/scan.engine.test.ts`, `normalize.scans-before-return.test.ts`), so neither the tree nor push protection sees a matchable credential.
- **Deterministic fold from manifests alone.** `source-heavy` manifests carry fake `contentId`/`origin`/`provenance:`; `provenance-fold.test.ts` rebuilds with only `0003_provenance`. `conflicting-claims` claim blocks rebuild via `0004_claims`. Conflict is detected downstream, not folded — both Meridian claims coexist as `active` rows after rebuild.

## Gotchas

- **`empty/` is the workhorse, not a corner case** — most wiki-link precedence / identity-collision tests start from `empty` and write purpose-built notes into the copy at runtime.
- **Fixture-path depth is level-sensitive** — consumers use `../../../fixtures/…` (3 levels up from a package `test/` dir). When the eval harness moved `tools/`→`packages/lancedb-index/`, its `new URL` paths had to change from `../fixtures/…` to `../../../fixtures/…` or vitest ENOENTs.

## History (real PRs)

- **#61** (`21f8125`, Phase 0 scaffold) — all seven vaults + `inputs/*` created up front in one shot. `withFixtureVault` was *retained* from a prior harness.
- **#64** (`3ff38fb`, retained migrations 0003/0004) — added `claims:` blocks to `conflicting-claims/*` and provenance frontmatter to `source-heavy/sources/*` — arrived *with* the fold migrations, not at scaffold.
- **#85** (`c404fc5`, retrieval eval harness) — added `retrieval-eval/{queries,labels}.json`.
- Downstream (no fixture-byte change): **#156→#159** built a real stemmed/stop-word FTS index, lifting default-hybrid retrieval on the graduated corpus from recall@10/MRR **0.878/0.673 → 0.911/0.830**, clearing the gate.

## Open items

- **`schema-v1/` barely exercised** — only the all-seven smoke loop loads it; `vault.test.ts`'s "reader refuses unsupported schema version" assertion mutates `small-valid` instead. Either pin that negative test to `schema-v1` or document why it stays smoke-only.
- **Doc drift in `secret-bearing.md`** — its body says live-format secrets are "materialized at runtime by `@atlas/testing`", but `@atlas/testing` exports only `withFixtureVault`; the assembly is inline in the scan/sources tests. Harmless, worth correcting.
- **No automated `FixtureName` ⇄ `fixtures/` drift check** (unlike the CLI-contract lint). A small test could enumerate dirs and assert the union covers them.
- **Eval set is tiny** (4 queries / 4 targets) — a larger real-corpus eval is the province of open **#60**; this fixture is the seed, not the destination.

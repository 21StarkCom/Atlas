# `@atlas/scan` — fail-closed secret-detection leaf

The single, centralized secret detector for the whole safety spine. One engine (`scanBytes`), one versioned ruleset — every boundary (ingest, in-sandbox worker, egress, graduation, generated-artifact) runs the *same* deterministic detection so there's no second-source drift (design D15). Second workspace leaf after `@atlas/contracts`; `package.json` deps = **`@atlas/contracts` only** (the D14 no-app-import invariant — see below).

Ruleset tuning rationale lives in `src/rules.ts` doc-comments + the #143 commit body; there is **no dedicated spec** under `docs/specs`. Related: `../../docs/adr/0001-egress-response-scan-released-bytes.md` (egress-boundary amendment), `../../docs/specs/2026-07-11-atlas-v1-design.md` (secret-scan design + exit-code table), `../../docs/specs/sandbox-contract.md` (`scan-before-persist` guarantee, D15), `../../docs/specs/normalization-contract.md` (accepted text encodings the BOM decode mirrors).

## Key files

| File | Role |
|---|---|
| `src/rules.ts` | Versioned ruleset: `RULESET_ID`, `RULESET_VERSION`, `STRUCTURAL_RULES`, `ENTROPY_RULE`, and v2 helpers (`shannonEntropy`, `isMixedAlphabet`, `isUrlContext`, `hasSecretLikeRun`, `tokenize`). |
| `src/engine.ts` | `scanBytes` — BOM-aware decode → structural pass → entropy pass → `normalize` (order + dedup + redact) → `ScanVerdict`. |
| `src/types.ts` | Structural surface: `PersistenceSink`, `ScanContext`, `FindingSeverity`, `SecretFinding`, `ScanVerdict`, `QuarantineSink`, `SecretDetectedError`. |
| `src/pre-persistence.ts` | `PrePersistenceGuard` — `assertClean` (scan+quarantine+throw) and `quarantineRejection` (unconditional capture for an upstream-decided refusal). |
| `src/generated-artifact.ts` | `GeneratedArtifactGuard` — scans the exact serialized artifact text bound for a `PersistenceSink`. |
| `src/index.ts` | Barrel: types + engine + both guards. |
| `test/scan.engine.test.ts` | The sole test file — 7 `describe` blocks: representative formats, BOM encodings, clean content, determinism/non-leakage, both guards, v2 FP corpus. |

## Detection pipeline (`engine.ts`)

1. **`decodeForScan`** — leading-BOM detection per the normalization contract's accepted text set (utf-8, utf-8-bom, utf-16le-bom, utf-16be-bom). UTF-16BE is byte-swapped into LE and decoded with the LE decoder (avoids the optional `utf-16be` ICU label). Anything else = lossy UTF-8 (`fatal: false` → U+FFFD; a decode error never hides a match).
2. **`structuralMatches`** — every rule run with the `d` (hasIndices) flag cloned on, narrowing each match to its sensitive capture group (`group > 0`) or, for `generic-secret-assignment` (`group: 0`), to the first captured alternation value so the preview length reflects the secret, not the `key = "…"` wrapper.
3. **`entropyMatches`** — tokenize into maximal `[A-Za-z0-9+/=_-]` runs; a token flags only if length ≥ 32 AND mixed-alphabet AND entropy ≥ 4.3 bits/char AND NOT in a URL context AND has a secret-like run AND does not overlap a structural claim.
4. **`normalize`** — sort by `(start, end, ruleId)`, dedup on `ruleId:start:end`, redact, round entropy to 3 dp.

## Public surface & consumers

- **`scanBytes({ bytes, context }): ScanVerdict`** — the pure detector. `ScanContext` is **diagnostic only** (`origin`/`boundary`/`kind`/`sink`/`sensitivity`); it does NOT change detection (`// Reserved for boundary-specific tuning; detection is context-independent today`).
- **`SecretFinding`** carries ONLY non-secret metadata — `ruleId`, `title`, `severity`, `startOffset`/`endOffset` (char offsets into the decoded text), `redactedPreview` (`‹redacted:N chars›`), optional `entropyBitsPerChar`. The raw match never leaves the engine.
- **`SecretDetectedError`** — `exitCode = 3` (const) + `boundary`/`origin`/`findings`. `apps/cli/src/main.ts` maps it to process exit 3 via `CliError.secretScan`.
- **`QuarantineSink`** — the structural seam defined in the leaf; implemented CLI-side at `../../apps/cli/src/quarantine/store.ts` (AEAD, ciphertext-only). The leaf never imports the app.

**Consumers (all import `@atlas/scan`, never the reverse):** ingest capture (`apps/cli/src/ingest/{capture,wiring}.ts` + `packages/sources/src/normalize/index.ts` REQUIRES a `PrePersistenceGuard`, scans raw + normalized bytes); in-sandbox worker (`packages/sources/src/worker/main.ts` runs `scanBytes` INSIDE the confined worker, D15); egress broker (`packages/broker/src/egress/scan.ts` `scanEgressPayload`); graduation gate (`apps/cli/src/graduation/scan.ts`); generated-artifact boundary (`apps/cli/src/workflows/{synthesis,refresh}.ts`).

## Invariants & guardrails

- **Fail-closed.** Any structural shape OR one qualifying high-entropy token ⇒ dirty verdict. No allowlist/suppression path in the engine.
- **Determinism is a contract.** Same bytes + same version ⇒ byte-identical findings (stable order, stable redaction). **Any rule change MUST bump `RULESET_VERSION`.** Every `STRUCTURAL_RULES` pattern carries the global (`g`) flag — the engine relies on `matchAll`.
- **Non-leakage.** Raw match kept only inside the engine, masked by `redact` before reaching a `SecretFinding`. Tests assert no finding ever contains the secret.
- **Quarantine-before-throw.** Guards capture the offending bytes through the sink and only THEN throw — nothing reaches the real sink.
- **Entry-time byte snapshot.** `PrePersistenceGuard.assertClean` does `a.bytes.slice()` at entry: scan is sync, sink is async, so a concurrent caller mutation of the shared `Uint8Array` can't make quarantined bytes differ from scanned bytes. Explicit regression test.
- **Mandatory non-empty quarantine artifact.** `quarantineRejection` substitutes a deterministic `EMPTY_SOURCE_SENTINEL` when captured bytes are empty (empty raw source + absent worker payload). It also SKIPS the re-scan on purpose — the raw bytes may be individually clean (a secret matchable only after normalization); the sandbox verdict is the authority. Enforced HERE (single quarantine authority) so no caller can bypass it.
- **D14 no-app-import.** Deps = `@atlas/contracts` only. The `QuarantineSink` seam is the inversion that keeps it a true leaf.

## Gotchas & sharp edges

- **`RULESET_ID` string still says `-v1`, `RULESET_VERSION` is `2`.** The id is a *stable identity* stamp that does NOT track the integer version; the version is the field that bumps on rule changes. Do NOT "fix" the id to match — it would break the reproducibility stamp on prior verdicts.
- **`context` is a no-op for detection.** Callers expecting boundary-specific tuning (e.g. laxer scanning on a trusted sink) get none. Declared "reserved for boundary-specific tuning" but never wired — future feature or dead surface.
- **Entropy heuristic will MISS a digit-less base64 secret.** A ≥24-char base64 run with no digit doesn't clear `hasSecretLikeRun` (~0.7% probability, accepted for a medium-severity backstop). Structural rules are the real net; entropy only backstops.
- **URL-context guard is contains-, not prefix-anchored** (fixed mid-#143, commit `a2d356e`). It tests the non-whitespace span *up to* the token for `https?://`, because markdown links (`](https://…`), Slack-export angle URLs (`<https://…|label>`), and quoted/parenthesized URLs join the scheme into the span. A prefix test missed 18 residual real-vault findings.
- **`generic-secret-assignment` separator is `[ \t]`, not `\s`** — deliberately does NOT cross a newline. A prose line ending `…secret:` must not swallow the next line's first word; a real `key: value` sits on one line.
- **Structural rules still fire inside URLs.** The URL guard only suppresses the *entropy* heuristic. A Slack webhook URL still trips `slack-webhook` (structural). Test asserts both directions.
- **Graduation history scan shells out to `git`** (`rev-list --all --objects`, `cat-file`) with a 256 MB `maxBuffer` in `apps/cli/src/graduation/scan.ts` — a larger blob throws. It attributes a hit to the commit that first ADDED the path (`log --diff-filter=A`), which can misattribute a deleted-then-re-added path.
- **Egress `sink: "log"` label is intentional** (`packages/broker/src/egress/scan.ts`) — the egress payload bytes never persist; the label is metadata-class only, not "writes to a log sink."
- **ADR-0001 amends the egress RESPONSE scan** to run on RELEASED bytes (parsed typed result), not the raw provider envelope — Gemini's `thoughtSignature` (opaque ~1–4 KB high-entropy blob on every response) is scan-indistinguishable from a secret and refused every `generateText`. Request direction + error/intermediate bodies still scan raw. This lives in the broker, not here, but it's why the response scan isn't `scanBytes` over raw HTTP.

## History (real PRs — only 3 commits ever touched this package)

1. **#71** (`6ca7039`) — origin. Deterministic v1 ruleset, both guards over the injected `QuarantineSink`, and (same PR, CLI-side) the AEAD quarantine store + `doctor` quarantine-security check. Established D14.
2. **#73** (`adbd65b`) — added `PrePersistenceGuard.quarantineRejection` for an upstream-decided refusal (the in-sandbox D15 scanner flagged a secret the trusted side can't re-derive). The non-empty-sentinel invariant is a round-2 review finding baked in here.
3. **#143** (`0aeb670`) — ruleset v2 precision overhaul. The entropy heuristic flagged **369/369 false positives** on a real 226-file vault (URL segments, kebab-case slugs, BigQuery table names, CamelCase chains) and generic-assignment swallowed the line after a prose `secret:`. v2 added the URL-context guard, secret-like-run guard (`split on -/_`, run ≥ 24 chars, entropy ≥ 4.3, ≥ 1 digit), newline-safe separator, and `RULESET_VERSION 1→2` → 369 → 0 entropy FPs, TP corpus fully retained. Follow-up `a2d356e` (same PR) made the URL guard contains-anchored; the real vault then scanned clean over 226 files + 998 history commits. (This is the same ruleset that turned the #60 graduation scan's 36,598 findings into `gate: clean`.)

Related but outside this package: ADR-0001 / **#146**+**#148** (egress released-bytes scan); **#149** (Gemini parse drops thought parts).

## Open items / follow-ups

- **Entropy tuning is corpus-specific.** The v2 thresholds (minLength 32, 4.3 bits/char, minRunLength 24) were measured on one real 226-file vault. A materially different corpus could reintroduce FPs or misses; there's no automated FP-corpus regression beyond the hard-coded cases in `test/scan.engine.test.ts`.
- **`ScanContext` tuning hook unused** — the "reserved for boundary-specific tuning" fields are declared but never wired.

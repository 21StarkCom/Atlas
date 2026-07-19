# console/ — CLAUDE.md

Atlas Console — a **SwiftUI macOS app** (SP-2 "Console Cockpit"), one Swift Package with three targets. It is a **pure read-face** over `brain watch --json` + the read-class `--json` surface, and a **privileged-flow driver** (render challenge → shell to `atlas-signer` → re-invoke `brain … --authorization`). It opens **no broker socket**, holds **no broker/signing credential**, imports **no atlas internal package**, and handles the egress capability key transiently. Preserve that boundary.

**Outside the pnpm workspace.** `console/` is deliberately not in `pnpm-workspace.yaml`'s globs (`apps/*`, `packages/*`, `tools`). It builds/tests independently: `cd console && swift build && swift test`. Never run `pnpm -r test` for console work; never add it to a pnpm glob.

- **Toolchain:** swift-tools 6.0, `platforms: [.macOS(.v15)]` (Swift 6 language mode / complete concurrency). Swift 6 on PATH.
- **CI:** `.github/workflows/console-ci.yml` (`macos-15`): `swift build` → `swift test` → `scripts/assemble-app.sh`, every step `working-directory: console`.

## Module graph (no back-edges)

`ConsoleCore ← ConsoleUI ← AtlasConsole`. `ConsoleCore` (all non-UI logic) is the leaf; `ConsoleUI` (SwiftUI views) depends only on it; `AtlasConsole` (the `@main` executable, Phase 6) depends on `ConsoleUI`. `ModuleAcyclicityTests` parses the resolved package dump and fails on any library→executable back-edge or a platform other than macOS 15.

## The .app is script-assembled, not xcodebuild'd

A SwiftPM executable has no application target/scheme that emits a launchable bundle, so `scripts/assemble-app.sh` builds `-c release`, lays out `.build/AtlasConsole.app/Contents/{MacOS,Resources}`, installs `Resources/Info.plist` (`CFBundleIdentifier=com.atlas.console`), writes `PkgInfo`, and ad-hoc codesigns. It `cd`s to its own package root first, so it runs correctly from the repo root **or** `console/`. Set `ATLAS_CONSOLE_SCRATCH` to relocate the SwiftPM build dir (tests use this to avoid lock contention with the outer `swift test`); the `.app` always lands at `console/.build/AtlasConsole.app`. That path is gitignored.

## Phase 1 — foundations (`ConsoleCore`)

The substrate everything downstream binds to. Constants live once in `Constants.swift` (`ConsoleConstants` + `BackoffPolicy`).

| File | What it owns |
|------|--------------|
| `ProcessRunner.swift` | The sole subprocess-launch owner. `SpawnRequest`/`SpawnResult`/`SystemProcessRunner`. One-shot `run` drains stdout+stderr **concurrently** (no pipe-capacity deadlock), enforces `timeout` via SIGTERM→SIGKILL reap (`SpawnError.timedOut`), honors cancellation. `executable[0]` MUST be absolute (`Foundation.Process` does no PATH expansion) — a non-absolute token is a typed error. |
| `StreamHandle.swift` | Long-lived reader for `brain watch`: **raw byte chunks** (framing is Phase 2), plus `completion()` → exit code + **full captured stderr** (never swallowed). |
| `SchemaValidator.swift` | Strict runtime JSON-Schema (draft 2020-12 subset) engine. Constraint values read from schema bytes at runtime — nothing hardcoded. Implements exactly the keyword set the atlas schemas use incl. applicators + `unevaluatedProperties` (annotation propagation). `implementedKeywords`/`ignoredKeywords`/`collectKeywords` back the coverage gate. `decode(_:from:)` is the validate-then-`Decodable` wrapper. |
| `ContractBundle.swift` | Binds `commands.json` + per-command `*.schema.json` + `watch`/`error-envelope` schemas from the **checkout that supplies the CLI entry** (`resolve(fromAnchor:)` walks up from `dist/bin.js`, never the `node` launcher). `executionClass` is read from each schema's `x-atlas-contract` (it is **not** on the registry row). |
| `BinaryResolution.swift` | Resolves `brain`/`signer` first-hit-wins (settings → env var → repo-layout default), resolves bare `node` to absolute via the request PATH, probes (`brain db status --json` — a pure command, never an audited read; `atlas-signer pubkey`) under a 10 s timeout, and **fails closed** (`BlockingResolutionError` naming the path + remediation, no fallthrough). V1 same-checkout signer restriction enforced: signer resolution **requires** the already-resolved brain's `contractAnchor` (`resolve(.signer, …, brainAnchor:)`) and derives the bundle/checkout exclusively from it, so a brain from checkout A can never pair with a signer/root from checkout B; the resolved signer's `contractAnchor` is that same brain anchor. Env vars: `ATLAS_ROOT`, `ATLAS_BRAIN_PATH`, `ATLAS_SIGNER_PATH`. |
| `SignerContractValidator.swift` | Transcribed §7.1/§7.2 challenge/response validator (no importable schema). Every required field incl. `schemaVersion`/`payloadCanonicalization`; signature prefix `p256:`/`ed25519:`; **recursively** checks the echoed response challenge equals the committed one. |

## Tests

`cd console && swift test`. All Phase-1 suites run in CI (no Secure Enclave, no real broker — software fixtures + a scripted-spawn harness). `TestSupport` locates the repo checkout from `#filePath` and builds throwaway fixture checkouts. Named Phase-1 suites: `ModuleAcyclicityTests`, `AppBundleIdentityTests`, `ProcessRunnerTests`, `StreamHandleTests`, `SchemaValidatorTests`, `SchemaKeywordCoverageTests`, `SchemaDecodeTests`, `ContractBundleResolutionTests`, `PathResolutionProbeTests`, `NodeResolutionTests`, `SignerContractValidatorTests`.

Normative sources: [`docs/specs/2026-07-19-console-cockpit-spec.md`](../docs/specs/2026-07-19-console-cockpit-spec.md) (contract) and [`docs/plans/2026-07-19-console-cockpit-plan.md`](../docs/plans/2026-07-19-console-cockpit-plan.md) (six-phase plan). SwiftPM's `--filter` is singular — use one regex or the unfiltered suite, never repeated `--filter` flags.

# SP-2 — Atlas Console cockpit — Implementation Plan

Slug: `docs/plans/2026-07-19-console-cockpit-plan.md`. Implements `docs/specs/2026-07-19-console-cockpit-spec.md` (the SP-2 cockpit spec, third of the Console arc). SP-1 (`brain watch --json`) and SP-3 (`atlas-signer`) are the binding upstream contracts; both are merged.

## 1. Overview

Atlas Console is a SwiftUI macOS app in `console/`, built as one Swift Package with three targets — a `ConsoleCore` library (all non-UI logic), a `ConsoleUI` library (SwiftUI views), and an `AtlasConsole` executable that assembles the `.app`. It is a **pure read-face** over `brain watch --json` + the read-class `--json` surface, and a **privileged-flow driver** that renders an authorization challenge, shells to `atlas-signer`, and re-invokes `brain … --authorization`. It opens no broker socket, holds no broker/signing credential, imports no atlas internal package, and handles the egress capability key transiently.

The plan is six phases, each landing behind the CI Swift compile job (`macos-15`):

1. **Foundations & contract binding** — package skeleton, CI job, spawn/stream primitives, the runtime JSON-Schema engine, binary resolution + probe, contract-bundle binding, signer-contract validator.
2. **Stream decode, framing, exit interpreters, observability** — the `WatchEvent` decoder, `NDJSONFramer`, the two exit-code interpreters, the error-envelope parser, the argv-sanitizing logger.
3. **Reducers** — audit (run-space-only), dashboard overlay, per-job count map, resume/replay/cursor selection.
4. **Watch supervisor & local stores** — gated backoff supervisor, `ledger_cursor` SQLite store, `Settings` store, daemon-transition handling.
5. **Privileged flow & egress** — export→sign→authorize state machine, authorizable-op discovery + schema-driven routing, egress-gated actions, drift tests, cadence guard.
6. **UI surfaces, accessibility, live drive** — dashboard/jobs/audit/model-call/privileged surfaces, the accessibility bar, and the manual live-drive checklist.

## 2. Prerequisites

- macOS 15 (Sequoia) with Xcode 16 toolchain / Swift 6; `swift build`, `swift test`, `xcodebuild` on PATH.
- A provisioned local Atlas install: `atlas-broker` + `atlas-egress` running as launchd system services (PR #206 runbook), an enrolled SE signer (SP-3 `provisioning/enroll-signer.sh`, `-vN` id), and `brain` + `atlas-signer` built from source on the same machine.
- Repo checkout supplying the bound contract artifacts: `docs/specs/cli-contract/commands.json`, the per-command `*.schema.json`, `docs/specs/cli-contract/watch.schema.json` (SP-1 SSOT, with `examples`), and `docs/specs/cli-contract/error-envelope.schema.json`.
- SP-3's `security-broker-contract.md §7.1/§7.2` (the signer challenge/response shapes, transcribed — there is no standalone `authorization-challenge.schema.json` to import).
- **SP-2 tracking issue opened at planning start** (open-questions #9 — current open repo issues are #60, #65; neither blocks SP-2).

## 3. Global Constraints

- **Two subprocess contracts only.** `brain` (SP-1 stream + read commands) and `atlas-signer` (SP-3). No broker socket, no projection-store read, no `@atlas/contracts` import, no self-rendered Touch ID prompt.
- **Strict parsing, no defensive parsing.** Every stream line and every read-command payload is validated against its published schema (`unevaluatedProperties:false` honored). Optional fields are decoded as Swift optionals — the contract omits, never nulls; a `null` where the contract says omitted must fail decode.
- **Consume registries, never re-derive.** Command membership / phase / privilege / executionClass / idempotency come from `commands.json` + schemas at runtime; event shape from `watch.schema.json`; vault location from `brain.config.yaml`; exit meaning from the two exit tables; error codes from `x-atlas-contract.errorCodes`. Three documented Console-owned exceptions, each drift-guarded (§Testing Strategy).
- **Cadence rule (load-bearing).** `brain watch` is the **only** periodically polling subprocess. No audited read (`status`, `inspect`, `graduation audit`, `query`) ever runs on a timer; read commands run only on user focus/action; probes run only on launch + settings change.
- **Two exit namespaces kept separate.** A `brain` exit code (0–6, +7 aggregate) is never read against the `atlas-signer` table (0–5) or vice-versa — two distinct Swift interpreters.
- **Retry drives off the envelope**, not the numeric exit code (`retryable` + `retryAfterMs`), with the one declared exception of the watch supervisor reading exit 2/5 as structurally terminal.
- **Fail-fast, no silent fallback.** A resolution source that hits but fails its probe becomes a blocking error state naming the path — never a fallthrough to the next source.
- **SwiftPM verification uses a single regex filter or the unfiltered suite** — never multiple `--filter` flags in one command (SwiftPM's `--filter` is singular; repeated flags do not reliably union suites).
- **Named constants live in one place.** `DB_EVENT_SEQ_BASE = 1_000_000_000_000`, `WATCH_MAX_CONSECUTIVE_FAILURES = 6`, `BackoffPolicy` (500 ms initial · ×2 · 30 s cap · ±20 % jitter), `EgressMintingCommands = {query, index eval}` — each defined once in `ConsoleCore`.
- **Commits authored `Aryeh Stark <aryeh@21stark.com>`; branch + PR for everything; every review finding posted on the PR.**

---

## Phase 1 — Foundations & contract binding

**Goal.** A buildable three-target package, a green CI compile+assemble job on `macos-15`, and the substrate everything downstream needs: spawn, raw-byte stream + exit, the runtime schema engine, binary resolution + probe, contract-bundle binding, and the signer-contract validator.

**Dependencies.** None (entry phase).

### P1-Task-1 — Package skeleton, module graph, CI compile/assemble job

Create `console/Package.swift` (swift-tools 6.0, **`platforms: [.macOS(.v15)]`** — `LSMinimumSystemVersion` in the bundle plist does not raise SwiftPM's compilation deployment target, and Phase 6 compiles SwiftUI `App`/Observation/accessibility APIs that need it) with library targets `ConsoleCore` and `ConsoleUI` (depends on `ConsoleCore`) and executable target `AtlasConsole` (depends on `ConsoleUI`), plus test targets `ConsoleCoreTests`, `ConsoleUITests`. `console/` lives outside the pnpm workspace globs. **The `.app` bundle is assembled by an explicit script, not by xcodebuild** — a SwiftPM executable has no application target/scheme that emits a launchable bundle. `console/scripts/assemble-app.sh` (`set -euo pipefail`; first `cd "$(dirname "$0")/.."` to its own package root so SwiftPM runs from `console/` regardless of caller cwd): `swift build -c release` → create `.build/AtlasConsole.app/Contents/{MacOS,Resources}` → copy the built `AtlasConsole` binary into `Contents/MacOS/` → install `Resources/Info.plist` (`CFBundleIdentifier=com.atlas.console`, `CFBundleExecutable=AtlasConsole`, `LSMinimumSystemVersion=15.0`) into `Contents/` + write `PkgInfo` (`APPL????`) → `codesign --force --sign - .build/AtlasConsole.app` (ad-hoc, matching the build-from-source posture). The bundle path `console/.build/AtlasConsole.app` is the XCUI-launchable artifact. Add `.github/workflows/console-ci.yml`: `macos-15`, Swift 6, every step under `working-directory: console` — `swift build` → `swift test` → `scripts/assemble-app.sh`.

**Interfaces:**
```
console/Package.swift                         # products: ConsoleCore, ConsoleUI, AtlasConsole
console/Sources/{ConsoleCore,ConsoleUI,AtlasConsole}/
console/Tests/{ConsoleCoreTests,ConsoleUITests}/
console/Resources/Info.plist                  # CFBundleIdentifier = com.atlas.console
console/scripts/assemble-app.sh               # swift build -c release → .app assembly → ad-hoc codesign
console/.build/AtlasConsole.app               # assembled output (gitignored)
.github/workflows/console-ci.yml              # macos-15: build → test → assemble-app.sh
```

**Test:** `ModuleAcyclicityTests` — asserts the dependency graph is exactly `ConsoleCore ← ConsoleUI ← AtlasConsole` with **no** library→executable back-edge (parses the resolved package dump) **and that the resolved package platform is `macOS 15`**. `AppBundleIdentityTests` — runs `assemble-app.sh` **from both the repo root and `console/`**, then asserts the assembled bundle exists at the declared path, its `Info.plist` carries `CFBundleIdentifier=com.atlas.console`, the executable bit is set on `Contents/MacOS/AtlasConsole`, and `codesign --verify` passes.

### P1-Task-2 — Spawn primitive (`ProcessRunner`)

A single owner of subprocess launch. One-shot `run` (collect stdout/stderr/exit) and a `stream` variant returning a `StreamHandle` (P1-Task-3). Enforces the §interfaces spawn contract: caller supplies `cwd`, `environment`, and argv; the runner never mutates env except to inject what the caller passes. stdin optional (for the signer pipe). **Executable resolution:** `SpawnRequest.executable[0]` MUST be an **absolute path** — `Foundation.Process` takes a file URL and performs no shell/PATH expansion; resolution to absolute happens upstream (P1-Task-5), and the runner rejects a non-absolute token with a typed error. **Robust one-shot semantics:** `run` drains stdout and stderr **concurrently** (a child writing more than pipe capacity to either stream must not deadlock), honors `timeout` by SIGTERM→SIGKILL escalation + child reap (surfaced as a typed `SpawnTimeout` error), and supports Swift cancellation the same way. **Swift 6 concurrency:** `SpawnRequest`/`SpawnResult`/`StreamCompletion` are `Sendable`; `ProcessRunner: Sendable`; `SystemProcessRunner`'s mutable process state lives behind an actor so one runner instance is shareable across `WatchSupervisor`/`AttachCoordinator`/`PrivilegedFlow`.

**Interfaces:**
```swift
struct SpawnRequest: Sendable {
  let executable: [String]              // [0] MUST be absolute (resolved by P1-Task-5); no PATH lookup here
  let arguments: [String]
  let cwd: URL
  let environment: [String: String]     // full env; no implicit inheritance beyond what is passed
  let stdin: Data?
  let timeout: Duration?                // one-shot runs only; nil = no timeout (streams end via exit/terminate)
}
struct SpawnResult: Sendable { let exitCode: Int32; let stdout: Data; let stderr: Data }
protocol ProcessRunner: Sendable {
  func run(_ req: SpawnRequest) async throws -> SpawnResult    // throws SpawnTimeout on expiry (child reaped)
  func stream(_ req: SpawnRequest) throws -> StreamHandle
}
struct SystemProcessRunner: ProcessRunner { /* Foundation.Process behind an actor */ }
```

**Test:** `ProcessRunnerTests` — runs a scripted fixture executable (`/bin/sh -c` via absolute path) asserting argv, `cwd`, injected env, stdin delivery, and exit-code capture round-trip; a non-zero exit is surfaced in `SpawnResult`, not thrown; a **hanging fixture** hits the timeout, the child is reaped, and `SpawnTimeout` is thrown; a fixture writing **more than pipe capacity to both streams** completes without deadlock; a non-absolute `executable[0]` is rejected with the typed error. A **Swift 6 strict-concurrency compile test** builds the real composition graph (one shared runner across the three actors) with complete checking enabled.

### P1-Task-3 — `StreamHandle` (raw-byte stream + exit completion)

Long-lived stream reader for `brain watch`. Exposes **raw byte chunks** (not lines — framing is P2-Task-1's job) and a `completion()` that resolves to the process exit code after the process exits. This separation is what lets P2's `NDJSONFramer` be unit-tested against adversarial chunking while the supervisor (P4) branches on the exit code independently.

**Interfaces:**
```swift
final class StreamHandle {
  var bytes: AsyncThrowingStream<Data, Error> { get }   // raw stdout chunks as read from the pipe
  func completion() async -> StreamCompletion            // resolves after process exit
  func terminate()                                       // SIGTERM (clean detach → exit 0)
}
struct StreamCompletion { let exitCode: Int32; let stderr: Data }  // stderr captured in full —
// the supervisor/UI surface it on the error state; watch stderr is NEVER swallowed (§behavior)
```

**Test:** `StreamHandleTests` — drives a fixture emitter that writes stdout bytes in arbitrary chunk sizes, writes to stderr, then exits with a chosen code; asserts chunks arrive in order, the stream closes on exit, `completion()` resolves exactly once with the exit code **and the captured stderr bytes**.

### P1-Task-4 — `SchemaValidator` (runtime JSON-Schema engine)

The strict validator every decoder and read-command parser runs through. Constraint values (enums, ranges, `required`, `unevaluatedProperties:false`) are read from the schema bytes at runtime — the Console hardcodes no shape. Must cover the keyword set the atlas schemas actually use, including applicator keywords.

**Interfaces:**
```swift
struct SchemaValidator {
  init(schema: Data) throws
  func validate(_ instance: Data) -> ValidationResult   // strict
}
enum ValidationResult { case valid; case invalid([ValidationError]) }
struct ValidationError { let path: String; let reason: String }
// keywords: type, required, properties, additionalProperties, unevaluatedProperties,
//   enum, const, minimum, maximum, minItems, maxItems, patternProperties,
//   items, minLength, maxLength, pattern,
//   allOf, anyOf, oneOf, not, if/then/else, $ref (local pointer)
// Completeness rule: every keyword any bound schema uses MUST be implemented — a
// keyword-inventory test walks the real contract-bundle schemas and fails on any
// keyword the validator does not implement (unknown keyword ⇒ test failure, never ignored).
```

**Test:** `SchemaValidatorTests` — positive/negative pairs per keyword **including semantic negatives for `items`, `minLength`, `maxLength`, `pattern`** (an over-long string, a pattern violation, a bad array item must each fail); `SchemaKeywordCoverageTests` — walks **every** schema in the bound contract bundle, inventories the keywords in use, and fails on any keyword the validator does not implement; also loads the applicator-heavy real schemas (`query`, `purge`, `index-repair`) and asserts `allOf/not/if/then/else` semantics hold (a conditionally-required field missing fails; a forbidden extra property under `unevaluatedProperties:false` fails). `SchemaDecodeTests` — the typed-wrapper path (validate → `Decodable`) round-trips a valid instance and rejects an invalid one before decode.

### P1-Task-5 — Contract-bundle resolution + binary path resolution + probe

Resolve `brain`/`atlas-signer` by the first-hit-wins order (settings → env var → repo-layout default), then **bind the contract bundle from the atlas checkout that supplies the CLI entry point** — for the repo-layout launcher (`node <atlasRoot>/apps/cli/dist/bin.js`) walk up from `dist/bin.js` for `docs/specs/cli-contract/commands.json`, **never** the launch executable (which may be `node`, outside the checkout); a standalone in-checkout `brain` binary is itself the anchor — never an independently-set `atlasRoot`. If the source that hit fails its probe or no bundle is discoverable, enter a **blocking error state** naming the failing path + remediation; no fallthrough.

- `brain` probe = spawn `brain db status --json` (a `pure` command — no ledger row) and require exit 0 + schema-valid output, under a **probe timeout** (10 s; `SpawnRequest.timeout`) — a hung probe becomes the blocking error state with a timeout remediation, never an indefinite `.probing`. Never probe with an audited read.
- `signer` probe = `atlas-signer pubkey` (no SE access, prints SPKI PEM) exit 0, same timeout.
- Re-probe **on launch and on settings change only**.
- Repo-layout `brain` default runs `node <atlasRoot>/apps/cli/dist/bin.js` with `ATLAS_ROOT=<atlasRoot>`. **The bare `node` token is resolved to an absolute executable during resolution** (walk the request environment's `PATH` entries; first executable hit wins; no hit ⇒ blocking error naming `node` + the searched PATH) — `Foundation.Process` performs no PATH expansion, so `ResolvedBinary.launch[0]` is always absolute by construction. Export `ATLAS_ROOT` when off the repo layout.
- **Signer-contract binding (V1 = same-checkout restriction):** the transcribed `SignerContractValidator` shapes (P1-Task-6) are anchored to the contract bundle's checkout. Resolution requires the resolved signer to come **from that same checkout** (the default `<atlasRoot>/console/signer` build product always does); a `signerPathOverride`/`ATLAS_SIGNER_PATH` pointing outside the bound checkout is a **blocking mismatch error** naming both paths — there is no cross-checkout signer support in V1 (no machine-readable signer contract version exists to negotiate; recorded follow-up: a signer `--contract-version` handshake would relax this).

**Interfaces:**
```swift
enum BinaryKind { case brain, signer }
// Dependency-free resolution inputs — Phase 1 owns this type; Phase 4's Settings maps INTO it
// (Settings.resolutionInputs()), so P1 never consumes the not-yet-built Settings store.
struct ResolutionInputs {
  let atlasRoot: String?; let brainPathOverride: String?; let signerPathOverride: String?
}
struct ResolvedBinary { let launch: [String]; let contractAnchor: URL; let baseEnv: [String: String]; let bundle: ContractBundle }   // launch = argv (may be node + bin.js); contractAnchor = the atlas checkout entry, resolved separately
struct BinaryResolution {
  static func resolve(_ kind: BinaryKind, inputs: ResolutionInputs, env: [String:String],
                      runner: ProcessRunner) async throws -> ResolvedBinary   // throws BlockingResolutionError(path, remediation)
}
struct ContractBundle {
  let commands: [CommandRow]
  func schema(for command: String) -> Data?         // per-command *.schema.json bytes
  var watchSchema: Data { get }                      // watch.schema.json
  var errorEnvelopeSchema: Data { get }              // error-envelope.schema.json (feeds ErrorEnvelopeParser; walked by SchemaKeywordCoverageTests)
  static func resolve(fromAnchor anchor: URL) throws -> ContractBundle    // walk up from the atlas CLI entry (dist/bin.js) / checkout — never the launch executable
}
struct CommandRow { let name, phase, privilege, executionClass, idempotency: String; let implemented: Bool }
```

**Test:** `ContractBundleResolutionTests` — a fixture checkout layout; a repo-layout wrapper (`node …/dist/bin.js`) binds the bundle at `dist/bin.js` (not the `node` launcher path) and probes green; an anchor whose tree has no `commands.json` throws the blocking mismatch error; a signer override outside the bound checkout throws the same-checkout mismatch. `PathResolutionProbeTests` (test-plan #12) — each source hit for both executables; missing/non-exec/probe-fail ⇒ blocking error naming the path, no fallthrough; a **hanging probe** hits the 10 s timeout and yields the blocking state (never indefinite probing); `brain` probe uses `db status` (asserts no audited-read spawn), signer probe uses `pubkey`. `NodeResolutionTests` — the repo-layout default resolves `node` to an absolute path via the request PATH **with the real `SystemProcessRunner`** (not the scripted harness); no `node` on PATH ⇒ blocking error naming the searched PATH.

### P1-Task-6 — `SignerContractValidator`

The signer challenge/response shapes have no standalone schema and cannot be imported from `@atlas/contracts` — transcribe them from `security-broker-contract.md §7.1/§7.2` + SP-3's `p256:` signature extension into a strict, negative-tested validator. Carries **every** §7.1/§7.2 required field (incl. `schemaVersion`, `payloadCanonicalization`) and **recursively validates the echoed response challenge** against the challenge shape.

**Interfaces:**
```swift
struct AuthorizationChallenge: Decodable, Equatable {
  let schemaVersion: Int; let op: String; let runId: String?; let targetCommit: String?
  let canonicalBaseCommit: String; let intendedEffect: [String: JSONValue]
  let nonce: String; let expiresAt: String; let signingPayload: String; let payloadCanonicalization: String
}
struct AuthorizationResponse: Decodable {
  let schemaVersion: Int; let challenge: AuthorizationChallenge; let signature: String /* "p256:…" */; let signerId: String
}
struct SignerContractValidator {
  func validateChallenge(_ data: Data) -> ValidationResult
  func validateResponse(_ data: Data, echoing challenge: AuthorizationChallenge) -> ValidationResult
}
```

**Test:** `SignerContractValidatorTests` — positive fixtures = the SP-3 embedded examples; negatives = missing `schemaVersion`, missing `payloadCanonicalization`, malformed `signature` prefix, and a response whose echoed `challenge` mutates a committed field (must fail the recursive check).

**Risks.** (1) The runtime schema engine under-covering a keyword the atlas schemas use → strict-parse false-passes. Mitigation: `SchemaKeywordCoverageTests` loads the real applicator-heavy schemas. (2) Contract-bundle drift if the binary and bundle came from different checkouts. Mitigation: bind from the binary's own tree (P1-Task-5), blocking error on mismatch.

**Verification.**
```
cd console && swift build
swift test --filter 'ProcessRunnerTests|StreamHandleTests|SchemaValidatorTests|SchemaKeywordCoverageTests|SchemaDecodeTests|ContractBundleResolutionTests|PathResolutionProbeTests|SignerContractValidatorTests|ModuleAcyclicityTests|AppBundleIdentityTests'
scripts/assemble-app.sh                                               # run from console/; .app assembles, bundle id com.atlas.console
```

---

## Phase 2 — Stream decode, framing, exit interpreters, observability

**Goal.** Decode all 8 SP-1 event types strictly with unknown-event tolerance, frame NDJSON correctly off the raw-byte pipe, interpret both exit namespaces + the error envelope, and log every spawn under an argv allowlist.

**Dependencies.** Phase 1 (spawn, stream, schema validator, contract bundle).

### P2-Task-1 — `WatchEvent` decoder (8 cases + `.unknown`)

Decode one NDJSON line into a `WatchEvent`. **Decode order (the unknown-event path is checked before the closed union):** (1) parse JSON; (2) validate the common envelope only — `v:1`, `event` string present, `at` RFC-3339 — against an envelope subschema extracted from `watch.schema.json`'s shared fields; (3) if `event` matches a known case, validate the full line against the schema's union member for that case and decode the typed payload; (4) if `event` is unrecognized, return `.unknown(raw:)` **without** applying the closed line-union (which would reject a future additive event). Both free-text fields (`job.lastError`, `watch.error.message`) arrive already C0/C1-escaped — decoded strings are display-safe as delivered. Optional fields decode as optionals (omitted, never null).

**Interfaces:**
```swift
enum WatchEvent {
  case hello(HelloPayload); case heartbeat(HeartbeatPayload); case watchError(WatchErrorPayload)
  case job(JobPayload); case modelCall(ModelCallPayload); case audit(AuditPayload)
  case backup(BackupPayload); case daemon(DaemonPayload); case unknown(raw: Data)
}
struct WatchEventDecoder {
  init(schema: Data)                         // watch.schema.json
  func decode(_ line: Data) throws -> WatchEvent
}
// HelloPayload: pid, ledger{attached,path}, snapshot, config{pollMs,heartbeatSeconds},
//               resume{auditHeadSeq}?, replay{sinceSeq,events}?
// JobPayload: jobId, workflow, state, attempts, maxAttempts, updatedAt, nextRunAt?, lastError?
// AuditPayload: seq, runId, eventType(14-enum), createdAt, gitHead?
// BackupPayload: watermarkSeq, healthy, updatedAt, lastBackupAt?
// DaemonPayload: daemon, socketPath, reachable, previousReachable
// ModelCallPayload: callId, runId, provider, model, operation, inputTokens, outputTokens, costMicros, createdAt
// WatchErrorPayload: source, code, message ; HeartbeatPayload: ledger, resume?
```

**Test:** `WatchEventDecoderTests` (test-plan #1) — decode ⨯ all 8 types from `watch.schema.json` `examples` (attached + detached hellos), zero decode errors; **negatives** — renamed required field, `null` where the contract omits, wrong type — must fail decode. `UnknownEventToleranceTests` (test-plan #2) — `{"v":1,"event":"watch.future","at":…}` decodes to `.unknown`, never crashes.

### P2-Task-2 — `NDJSONFramer`

Turn the raw-byte chunk stream (P1-Task-3) into `\n`-terminated UTF-8 lines: buffer partial lines across chunks, reconstruct multi-byte UTF-8 scalars split across chunk boundaries, and hand out complete lines only. The final error-envelope line (the one non-event line) is the sole line that may close a stream.

**Interfaces:**
```swift
struct NDJSONFramer {
  mutating func push(_ chunk: Data) -> [Data]   // complete lines; retains partial tail + partial UTF-8 prefix
  mutating func finish() -> Data?               // any complete trailing line without newline (defensive; SP-1 flushes per line)
}
```

**Test:** `NDJSONFramerTests` — line split across two `push`es; multiple lines in one `push`; a 3-byte UTF-8 scalar split across the boundary reassembled correctly; empty chunks tolerated.

### P2-Task-3 — Exit interpreters + error-envelope parser

Two disjoint interpreters (`brain` 0–6+7-aggregate; `atlas-signer` 0–5) and a strict `error-envelope.schema.json` parser. Retry decisions read `retryable` + `retryAfterMs`; structured `details` are read by field, never by parsing `message`. The nominal `7` is ignored for single-command envelopes (retryability rides the flags).

**Interfaces:**
```swift
enum BrainExit: Int32 { case ok=0, validation=1, config=2, secretScan=3, internalErr=4, usage=5, actionRequired=6 }
enum SignerExit: Int32 { case signed=0, internalFault=1, malformed=2, expired=3, cancelled=4, keyInvalidated=5 }
struct ErrorEnvelope: Decodable {
  let code: String; let message: String; let hint: String; let retryable: Bool
  let details: [String: JSONValue]?; let errors: [ErrorEnvelope]?
  let retryAfterMs: Int?; let runId: String?; let jobId: String?
}
struct ErrorEnvelopeParser { init(schema: Data); func parse(_ data: Data) throws -> ErrorEnvelope }
```

**Test:** `ExitInterpreterTests` — a `brain` code never resolves against the signer table and vice-versa (compile-separated + asserted). `ErrorEnvelopeTests` (test-plan #13) — branch on `retryable`+`retryAfterMs`; ignore the enumerated `7`; read `details.field`/`details.path` structured, never parse `message`.

### P2-Task-4 — Transport-framing integration test (real pipe)

Wire `SystemProcessRunner.stream` → `NDJSONFramer` → `WatchEventDecoder` and drive it through a real subprocess-pipe read path with a fixture emitter delivering NDJSON under adversarial chunking, ending with a single error-envelope line.

**Interfaces:** consumes P1-Task-3 `StreamHandle.bytes`, P2-Task-2 `NDJSONFramer`, P2-Task-1 `WatchEventDecoder`, and P2-Task-3 `ErrorEnvelopeParser` (built from `ContractBundle.errorEnvelopeSchema`). One transport result type distinguishes an event line from the sole terminal error-envelope line — a framed line carrying no `v:1`/`event` envelope is parsed via `ErrorEnvelopeParser` (never decode-failed) and surfaced to the supervisor for retryable-vs-terminal classification:
```swift
enum StreamItem { case event(WatchEvent); case terminalEnvelope(ErrorEnvelope) }
```

**Test:** `TransportFramingTests` (test-plan #22) — identical NDJSON delivered with a line split across reads, multiple lines per read, a split multi-byte scalar, and a final envelope; asserts correct line buffering, UTF-8 reconstruction, event ordering, unknown-event tolerance, and recognition of the sole final envelope line.

### P2-Task-5 — Observability logger + argv sanitization

An `os.Logger` (subsystem `com.atlas.console`) wrapper every spawn routes through. Argv is logged under an **allowlist**: binary path, command/subcommand tokens, flag names, enumerated flag values, and structural/ID operands (`jobId`, note `id`, `--limit`, `--since-seq`, `--poll-ms`, `--heartbeat-seconds`, `--config <path>`) logged intact; user-supplied free-text operands (the `query` positional — the one such operand in the V1 set) replaced with `<redacted:query len=NN>`; the egress key rides env and is redacted. The free-text redaction set is Console-owned by **semantic operand name only** — each name's concrete argv position or flag is resolved from the bound command schema at runtime, never a hardcoded index. `brain` stderr is captured (never swallowed) for surfacing on error surfaces; info for state transitions, error for probe/spawn/decode failures.

**Interfaces:**
```swift
struct ArgvClassifier {
  static let sensitiveOperands: [String: Set<String>]   // command → semantic operand NAMES to redact; e.g. "query": ["query"]. Position/flag resolved from the schema, never a hardcoded index.
  static func sanitize(command: String, argv: [String], schema: Data) -> [String]   // resolves each name's argv position/flag from the command schema
}
struct ConsoleLog {
  static func spawn(command: String, argv: [String], exitCode: Int32?)   // sanitized; env key never logged
  static func failure(_ stage: String, path: String, detail: String)     // .error level
}
```

**Test:** `ArgvSanitizationTests` (test-plan #19) — `brain query "<sensitive>"` logs the operand as `<redacted:query len=NN>` while structural argv/flags/IDs log intact; every sensitive operand **name** resolves to a unique argv position via the command schema, and a mapped name absent from that schema fails the test (stale-mapping guard); a probe/spawn/decode failure logs at `error`; `brain` stderr is captured on the result, never dropped.

**Risks.** Chunk-equals-line decoding that passes fixture-string tests but fails on the live pipe — mitigated by the real-pipe integration test (P2-Task-4) that could only pass because framing lives in `NDJSONFramer`, not in the spawn layer.

**Verification.**
```
cd console && swift build
swift test --filter 'WatchEventDecoderTests|UnknownEventToleranceTests|NDJSONFramerTests|ExitInterpreterTests|ErrorEnvelopeTests|TransportFramingTests|ArgvSanitizationTests'
```

---

## Phase 3 — Reducers

**Goal.** The run-space-only audit reducer, the dashboard snapshot+overlay, the per-job count map with the snapshot-plus-delta seed, and resume/replay/cursor selection — all pure, fixture-driven, load-bearing invariants.

**Dependencies.** Phase 2 (decoded events).

### P3-Task-1 — Audit reducer (run-space-only)

Accept an `audit` event into the timeline **iff `seq < DB_EVENT_SEQ_BASE`**. High-space events (`db.backup`, `db.restore`, `db.force_unblock`, `evidence.retry_enqueued`) are live-only signals — routed out, never into the timeline, never advancing head or cursor. Order the timeline by `seq` (not arrival); a gap in the run-space prefix is a pending intent, never pruned. Invariant: `displayedAuditHead == max contiguous run.*-space seq observed`. `incorporateHello(baselinePrefix:)` is called on **every** hello before any row: `-1` = replayAll/fresh/detached; a reported `hello.resume.auditHeadSeq` = existing-ledger live-only baseline (do **not** start the reducer at `-1` on an existing-ledger attach — that is the phantom-gap freeze).

**Interfaces:**
```swift
let DB_EVENT_SEQ_BASE = 1_000_000_000_000
struct AuditReducer {
  mutating func incorporateHello(baselinePrefix: Int)     // hello.resume?.auditHeadSeq ?? -1
  mutating func apply(_ audit: AuditPayload) -> AuditRouting  // .timeline or .highSpaceSignal(kind)
  var displayedAuditHead: Int { get }                     // max contiguous run-space seq
  var safeCheckpointSeq: Int { get }                      // contiguous-committed-prefix high-water
  var timeline: [AuditPayload] { get }                    // seq-ordered
}
enum AuditRouting { case timeline; case highSpaceSignal(HighSpaceKind) }
enum HighSpaceKind { case backup, restore, forceUnblock, evidenceRetry }
```

**Test:** `MixedSpaceReducerTests` (test-plan #3) — an NDJSON stream interleaving run-space `audit` with all four high-space kinds in adversarial orders (high-space first / interleaved / last / between a replay window and its checkpoint heartbeat); assert (a) timeline holds only run-space rows in seq order, (b) head/cursor never move on a high-space event, (c) each high-space kind routes to its signal, (d) a subsequent cursor-built resume is unaffected. `LiveOnlyExistingLedgerBaselineTests` — an existing-ledger attach seeds the reducer at the reported prefix (not `-1`), so a live `run.start` above the prefix advances head with no phantom gap.

### P3-Task-2 — Dashboard reducer (snapshot + live overlay)

The `hello.snapshot` overlaid by live events, each field with exactly one derivation: **live-updated** (`backup{watermarkSeq,healthy}` from `backup`; `audit.headSeq/head` from `displayedAuditHead`; daemon reachability from `daemon`; `openRuns` from run-space run start/terminal `eventType`s) recomputed only **after** the post-replay checkpoint heartbeat; **baseline-seeded** (`jobs{queued,failed}` via P3-Task-3); **snapshot-only** (`quarantineCount`, `backup.coveredSeq`, `audit.anchorOk/anchorSource`) held at last-`hello` value, labelled "as of `<hello.at>`", never fabricated between hellos, never on a timer. Replay-phase rows (before the checkpoint heartbeat) are already reflected in `snapshot.openRuns` and must **not** re-apply a run-state delta.

**Interfaces:**
```swift
struct DashboardState {
  var openRuns: Int?; var jobs: JobCounts?; var quarantineCount: Int?
  var backup: BackupView?; var audit: AuditView?; var daemons: DaemonView
  var snapshotAsOf: String        // hello.at, for "as of" labelling
}
struct DashboardReducer {
  mutating func rebaseline(from hello: HelloPayload)
  mutating func markCheckpointReached()             // post-replay; live overlay begins
  mutating func apply(_ event: WatchEvent)          // no-op for run-state deltas before checkpoint
}
```

**Test:** `DashboardReducerTests` (test-plan #5, #8) — the replay-double-application guard (a replayed `run.start` already in `snapshot.openRuns` does not re-apply; only genuinely-live post-replay rows move `openRuns`); the snapshot-only-vs-fabricated distinction (absent ledger-derived keys render as "as of", never `0`).

### P3-Task-3 — Per-job count map (snapshot-plus-delta seed)

Snapshot job aggregate counts carry no per-job identity, so seed a per-`jobId` state map and recompute `queued`/`failed` from it. Seed protocol: (1) **fully consume pagination** — `jobs list --json --limit 500` following `offset` until `pagination.hasMore` is false, dedup by `jobId` (order `createdAt desc` + `jobId` tiebreak makes the page walk a stable total order); (2) **buffer** live `job` events arriving during the multi-page read; (3) **merge by recency** — a buffered/streamed event overwrites its `jobId` row iff `event.updatedAt ≥ row.updatedAt`; a list row never overwrites a newer streamed state. A `job` event for an unseen `jobId` triggers a full `jobs list` re-read via the same protocol (never a synthetic insert — the event carries no `createdAt`).

**Interfaces:**
```swift
struct JobStateMap {
  mutating func seed(fromPages pages: [JobRow], buffered: [JobPayload])   // recency-merge
  mutating func apply(_ job: JobPayload) -> JobApplyResult                 // overwrite iff updatedAt >= existing; .needsReseed when jobId unseen
  var counts: JobCounts { get }                                            // {queued, failed} from map
  func contains(_ jobId: String) -> Bool
}
enum JobApplyResult { case applied; case needsReseed(String) }             // needsReseed carries the unseen jobId
struct JobsListReader {   // fully-consuming paginator
  func readAll(runner: ProcessRunner, binary: ResolvedBinary) async throws -> [JobRow]  // walks offset to hasMore:false
}
struct JobCounts { let queued: Int; let failed: Int }
// Sole owner of the seed/reseed protocol — the only component that drives JobsListReader:
actor JobStateCoordinator {
  init(reader: JobsListReader, runner: ProcessRunner, binary: ResolvedBinary)
  func apply(_ job: JobPayload) async               // .needsReseed ⇒ buffer live events, readAll, recency-merge; never a synthetic insert
  var counts: JobCounts { get }
}
```

**Test:** `CoalescingJobCountTests` (test-plan #4) — repeated `job`/`backup` for one id collapse to latest; two `audit`/`model_call` never collapse; seed a dataset **> 500 jobs** with a concurrent `job` transition during the multi-page read; assert full membership (every page consumed, deduped) and the buffered newer event wins over the stale list row (a list row never clobbers a newer streamed state); an unseen `jobId` arriving mid-pagination drives exactly one `JobStateCoordinator` reseed (buffer → readAll → recency-merge), never a synthetic insert.

### P3-Task-4 — Resume / replay / cursor selection

Choose the resume point from `Settings.resumeMode` (default `resume`): `resume` → persisted cursor `≥ 0` ⇒ `--since-seq <seq>`, else live-only; `replayAll` → `--since-seq -1`; `liveOnly` → no `--since-seq` (cursor still checkpointed). Replayed rows arrive as ordinary `audit` lines after `hello`, then a `watch.heartbeat` carries the first safe-to-persist cursor — `hello.resume.auditHeadSeq` during replay is `min(n, prefix)` and is **not** persisted until that checkpoint heartbeat. Stale cursor = cursor-above-head only: `replay.events:0` + `resume.auditHeadSeq < n` ⇒ re-baseline. Any `hello` ⇒ full re-baseline (clear reducer state, rebuild from snapshot, re-establish cursor).

**Interfaces:**
```swift
enum ResumeMode { case resume, replayAll, liveOnly }
struct ResumePlanner {
  static func plan(mode: ResumeMode, persistedCursor: Int?) -> ResumeArg    // .sinceSeq(Int) | .liveOnly
  static func isStaleCursor(replayEvents: Int, resumeHead: Int, requested: Int) -> Bool  // events==0 && resumeHead < requested
}
enum ResumeArg { case sinceSeq(Int); case liveOnly }
```

**Test:** `ResumeReplayTests` (test-plan #5) — cursor selection per `resumeMode`; pre-replay `min(n,prefix)` not persisted until the checkpoint heartbeat; `--since-seq`/`--once` mutual exclusivity honored at the invocation layer; a late-arriving lower seq inserts by `seq` and the cursor never advances past a still-open gap (contiguous-prefix rule). `StaleCursorRebaselineTests` (test-plan #6) — `replay.events:0` + `resume.auditHeadSeq < n` ⇒ re-baseline (covers the same-path re-clone edge only when the replacement head stays below the stale cursor; the catch-up-past-cursor case is the accepted residual, escape `replayAll`). `RebaselineOnHelloTests` (test-plan #7) — any `hello` clears dedup/cursor state and rebuilds the snapshot.

**Risks.** (1) Persisting an unsafe cursor mid-replay → a gap on next resume. Mitigation: persist only at the checkpoint heartbeat (`ResumeReplayTests`). (2) The phantom-gap freeze from starting the reducer at `-1` on an existing-ledger attach. Mitigation: `incorporateHello(baselinePrefix:)` seeded from the reported prefix (`LiveOnlyExistingLedgerBaselineTests`). (3) Same-path re-clone catch-up-past-cursor silent skip — **declared accepted V1 residual** (open-questions #5); escape `replayAll`; not closed in Swift.

**Verification.**
```
cd console && swift build
swift test --filter 'MixedSpaceReducerTests|LiveOnlyExistingLedgerBaselineTests|DashboardReducerTests|CoalescingJobCountTests|ResumeReplayTests|StaleCursorRebaselineTests|RebaselineOnHelloTests'
```

---

## Phase 4 — Watch supervisor & local stores

**Goal.** The gated backoff supervisor, the `ledger_cursor` SQLite store (sole resume-state owner), the `Settings` store, and daemon-transition handling.

**Dependencies.** Phase 2 (exit interpreters, envelope), Phase 3 (resume planner, reducers).

### P4-Task-1 — `ledger_cursor` SQLite store

Single-writer transactional store at `~/Library/Application Support/com.atlas.console/console.sqlite`; `init` creates the `com.atlas.console` parent directory (`0700`) if absent, then the db (`0600`), one table `ledger_cursor(incarnation_key TEXT PRIMARY KEY, audit_head_seq INTEGER NOT NULL DEFAULT -1, updated_at TEXT NOT NULL)`. `incarnation_key = SHA-256(absolute ledger.path)` from the attaching `hello`. Sole owner of resume state; `checkpoint` is the post-replay heartbeat write, wrapped in a transaction; an unseen key creates a fresh row at `-1`.

**Interfaces:**
```swift
struct CursorStore {
  init(path: URL) throws                                   // create parent dir 0700 if absent, db 0600, migrate table
  func load(incarnationKey: String) throws -> Int         // -1 if unseen
  func checkpoint(incarnationKey: String, seq: Int, updatedAt: String) throws
}
enum IncarnationKey { static func derive(ledgerPath: String) -> String }   // SHA-256 of absolute path
```

**Test:** `CursorStoreTests` — upsert round-trip; unseen key returns `-1`; file mode `0600`; a first-launch path whose parent directory is absent creates it (`0700`) before opening the db. `LiveOnlyCheckpointSurvivesRestartTests` — a live-only attach still checkpoints, so a later `resume` restart reads a `≥ 0` cursor and resumes forward with no re-replay.

### P4-Task-2 — `Settings` store (`UserDefaults`)

Flat settings blob in the standard suite: `atlasRoot?`, `brainPathOverride?`, `signerPathOverride?`, `pollMs?`, `heartbeatSeconds?`, `egressCapabilityKeySource ∈ {env, keychain}`, `resumeMode ∈ {resume, replayAll, liveOnly}` (default `resume`). A `null`/absent override ⇒ use the resolution order. **Fresh install is deterministic:** `Settings.defaults` = every optional `nil`, `.env`, `.resume`; `load()` distinguishes an **absent** blob (⇒ defaults) from a **corrupt** blob (⇒ defaults + a surfaced "settings were reset" notice — never a crash, never invented values). `atlasRoot` is **optional**: absent means no repo-layout default exists, so with no override and no env var the launch lands in the **blocking setup state** prompting for it. **Watch option bounds are NOT hardcoded:** a `WatchOptionPolicy` derived from the bound watch schema's `x-atlas-contract` flag table owns the `pollMs`/`heartbeatSeconds` ranges for validation + UI bounds; an absent override **omits the flag** so the CLI owns its default (500/30 are display hints read from the same policy).

**Interfaces:**
```swift
struct Settings: Codable, Sendable {
  var atlasRoot: String?; var brainPathOverride: String?; var signerPathOverride: String?
  var pollMs: Int?; var heartbeatSeconds: Int?
  var egressCapabilityKeySource: EgressKeySource; var resumeMode: ResumeMode
  static let defaults: Settings          // fresh-install value: all optionals nil, .env, .resume
}
struct WatchOptionPolicy {                // derived from the bound watch schema flag table (SSOT)
  init(watchSchema: Data) throws
  func validatePollMs(_ v: Int) -> Bool; func validateHeartbeatSeconds(_ v: Int) -> Bool
  var defaultPollMs: Int { get }; var defaultHeartbeatSeconds: Int { get }   // display hints only
}
enum EgressKeySource: String, Codable { case env, keychain }
extension Settings {   // maps into Phase 1's dependency-free resolution input (P1-Task-5)
  func resolutionInputs() -> ResolutionInputs
}
struct SettingsStore { func load() -> Settings; func save(_ s: Settings) }
// flag emission: an absent override OMITS the flag (the CLI owns its default); a present
// override rides --poll-ms/--heartbeat-seconds after WatchOptionPolicy validation
```

**Test:** `SettingsStoreTests` — fresh-install `load()` returns `Settings.defaults`; a corrupt blob returns defaults + the reset notice (never throws); persistence round-trip; `WatchOptionPolicy` validation sourced from a fixture watch schema rejects out-of-band values and tracks a mutated fixture range (proves schema-derivation, not a copied constant); an absent override produces argv with **no** `--poll-ms`/`--heartbeat-seconds` flag.

### P4-Task-3 — Watch supervisor (gated backoff)

Spawn `brain watch --json [--poll-ms <override>] [--heartbeat-seconds <override>] [--since-seq <cursor>]` (the only periodically polling subprocess; an absent Settings override **omits the flag** so the CLI owns its default — `WatchOptionPolicy`, P4-Task-2). On process exit, classify before acting:

- **Clean detach** — exit 0 (EPIPE/SIGTERM/SIGINT): no restart, no error surface.
- **Structurally terminal** — exit **5** (usage) or exit **2** (config/vault/lock): terminal "watch failed" state naming exit + `code`/`hint`; zero restarts.
- **Any other nonzero exit — exhaustive by construction** (exit 4, and defensively 1/3/6/unknown codes the watch contract says cannot occur): classified by the final envelope. Envelope present + `retryable:true` ⇒ **retryable**; envelope present + `retryable:false` ⇒ **terminal**; expected retryable shape with no envelope (exit 4 / dropped stream) ⇒ **retryable**; **an off-contract exit code with no parseable envelope ⇒ terminal fail-fast** (a bug surface, not a retry loop). Every `(exitCode, envelope?)` pair maps to exactly one of {cleanDetach, terminal, retryable, contract-mismatch}.
- **Contract mismatch** — a framing or strict-decode failure on a stream line (surfaced from P2 while the child is still alive): the supervisor **terminates the child and awaits its exit**, then enters a terminal `contract-mismatch` state naming the offending stage (framing/decode) — never an indefinite wait on `completion()`; zero restarts.
- **Backoff** — 500 ms initial, ×2, cap 30 s, ±20 % jitter; `retryAfterMs` (when present) is a floor; delay **and** consecutive-failure counter reset **only on a proven-healthy run** — a `hello` *followed by* its first attached `heartbeat` (a sustained stream), never on a bare `hello` — so a watcher that repeatedly emits `hello` then immediately faults keeps incrementing the counter and reaches the terminal cap.
- **Terminal cap** — `WATCH_MAX_CONSECUTIVE_FAILURES = 6` counts consecutive failed runs **including the initial failed run** (≤ 5 respawns); the 6th failure spawns no further attempt and enters the terminal state.
- **User-visible retry state** — attempt count, next-retry time, last exit/`code` surfaced as a banner; the next `hello` re-baselines and clears it.

**Interfaces:**
```swift
let WATCH_MAX_CONSECUTIVE_FAILURES = 6
struct BackoffPolicy {
  let initialMs = 500; let multiplier = 2; let capMs = 30_000; let jitterFraction = 0.2
  func delay(attempt: Int, retryAfterMs: Int?, rng: inout RandomNumberGenerator) -> Int
}
actor WatchSupervisor {
  init(runner: ProcessRunner, binary: ResolvedBinary, policy: BackoffPolicy)
  func run(resumeArg: ResumeArg, pollMs: Int, heartbeatSeconds: Int) async   // spawn → classify → backoff/terminal loop; the resume plan is passed at run-time, never baked in at init
  func stop() async                                 // SIGTERM the live watch, await its exit, cease all respawns
  var state: SupervisorState { get }                // .streaming | .retrying(attempt,nextAt,lastCode) | .failed(exit,code) | .contractMismatch(stage) | .detached
  var events: AsyncStream<WatchEvent> { get }
}
enum ExitClass { case cleanDetach, terminal(Int32,String), retryable(retryAfterMs: Int?), contractMismatch(String) }  // total over (exitCode, envelope?)
```

**Test:** `WatchSupervisorTests` (test-plan #20) — a scripted spawn harness feeds exit sequences and asserts the full policy over **the exhaustive `(exitCode, envelope?)` matrix — every brain code 0–6 plus an unknown code (9), each with valid / retryable:false / absent envelope**: (a) retryable delays progress 500 → ~1 s → ~2 s → … capped at 30 s within the ±20 % band; `retryAfterMs` honored as floor; (b) attempt/next-retry/last-`code` surfaced (assert the banner state); (c) a **proven-healthy** run (`hello` + its first attached heartbeat) between two failures resets both delay-to-500 and counter-to-0 (assert the post-reset delay), while six `[hello, retryable exit]` runs with no sustained heartbeat still reach the terminal cap (a bare `hello` never clears the storm counter); (d) non-retryable exit 5/2 or exit 4 `retryable:false` ⇒ terminal, zero restarts; (e) six consecutive failed runs (initial + 5 respawns) ⇒ terminal, no 6th spawn; (f) clean exit 0 ⇒ no restart, no failure surface; (g) dropped stream with no envelope ⇒ retry path; (h) a strict framing/decode failure on a line while the fixture child stays alive ⇒ the supervisor terminates + awaits the child and enters terminal `contract-mismatch` naming the stage, never hanging on `completion()`.

### P4-Task-4 — Daemon / detach transitions

`daemon` events (transition-only, probed at heartbeat cadence + once at start) drive reachability indicators. Detached ledger at startup is not an error (stream runs detached, re-probes each tick, emits a fresh `hello` on attach). Mid-stream vault vanish → `watch.error(source:"ledger")` ⇒ transient re-attach state awaiting the fresh `hello`. Broker unreachable also surfaces as `anchorSource:"sqlite-only"`. "Service not installed" (no socket, never reachable) is a distinct empty state pointing at the PR #206 runbook. `backup-unhealthy` never blocks watch — streams as `backup{healthy:false}` and paints a banner.

**Interfaces:**
```swift
struct DaemonReachability { var broker: ReachState; var egress: ReachState }
enum ReachState { case reachable, unreachable, notInstalled }   // notInstalled = never-reachable empty state
struct TransitionRouter {
  mutating func apply(_ event: WatchEvent) -> [UISignal]        // banner/badge/empty-state signals
}
```

**Test:** `DaemonTransitionTests` (test-plan #8, #9) — `daemon` events flip reachability; `anchorSource:"sqlite-only"` degraded; detached `hello`/`heartbeat` (no `resume`, no fabricated zeros) → attached `hello`; `watch.error(ledger)` → re-attach; "service not installed" empty state distinct from a fatal error.

### P4-Task-5 — `AttachCoordinator` (once-hello → cursor → live spawn → checkpoint threading)

The one owner of the attach/cursor sequence — the seam the pieces above deliberately do not wire themselves. Sequence: (1) spawn `brain watch --json --once`, read exactly one `hello` (exit 0); (2) derive `IncarnationKey` from `hello.ledger.path` (detached hello ⇒ skip cursor, plan live-only, re-run the sequence on the next attach hello); (3) `CursorStore.load(incarnationKey:)`; (4) `ResumePlanner.plan(mode:persistedCursor:)`; (5) spawn the live stream via `WatchSupervisor` with the planned `ResumeArg` + effective poll/heartbeat flags; (6) consume the supervisor's event stream, feeding reducers, and **checkpoint** `CursorStore` only on safe attached heartbeats — the post-replay checkpoint heartbeat and later attached heartbeats carrying `resume.auditHeadSeq` (never the pre-replay `min(n, prefix)` hello value, never a detached heartbeat). On a fresh `hello` the coordinator always rebaselines the reducers, but stops and re-plans **only for an actual incarnation transition** — a detached→attached flip or a changed `ledger.path` (`IncarnationKey` mismatch). The generation's own startup `hello` (and any same-incarnation re-`hello`, e.g. after a supervisor retry) rebaselines in place, never tearing down the watcher. Generation lifecycle: the event consumer subscribes **first**, then the supervisor task is started and **retained without awaiting its terminal completion**, so a healthy watch streams indefinitely while its `hello`/replay/heartbeat events flow to the reducers. On a genuine transition the coordinator calls `supervisor.stop()` — SIGTERM the old watch, **await both its process exit and its run-loop task**, discard buffered events — invalidating the generation before it re-runs (2)–(4) for the new incarnation and starts a fresh `supervisor.run(...)`; so no heartbeat can checkpoint past the prior incarnation's cursor.

**Interfaces:**
```swift
actor AttachCoordinator {
  init(runner: ProcessRunner, binary: ResolvedBinary, cursors: CursorStore,
       settings: Settings, supervisor: WatchSupervisor)
  func start() async                       // once-hello → cursor → plan → supervisor.run(resumeArg:pollMs:heartbeatSeconds:)
  func stop() async                        // supervisor.stop() → await the live watch's exit; caller awaits before any rebuild
  var events: AsyncStream<WatchEvent> { get }   // post-coordination stream the reducers consume
}
```

**Test:** `AttachResumeCheckpointFlowTests` (named integration test) — a scripted spawn harness drives: once-hello (attached, existing cursor) ⇒ live spawn carries `--since-seq <cursor>`; the live watch's **own startup `hello`** rebaselines in place and does **not** tear down the watcher (assert exactly one live spawn remains after once-hello → startup hello → replay → heartbeat); a same-incarnation re-`hello` after a supervisor retry likewise rebaselines without teardown; replay rows then checkpoint heartbeat ⇒ exactly one `CursorStore.checkpoint` at the heartbeat (never during replay); a mid-stream fresh hello with a **different** `ledger.path` ⇒ the old watch process is `stop()`ped and awaited before the new spawn, new incarnation row consulted, reducers re-baselined; a detached once-hello ⇒ live-only spawn, no cursor read, checkpointing begins only after the first attached hello.

**Risks.** Infinite silent retry on a permanent fault, or terminating on a clean detach — both mitigated by the classification-before-restart gate and the full-policy `WatchSupervisorTests`. A checkpoint written from an unsafe hello/replay value — mitigated by the coordinator being the sole checkpoint writer, tested in `AttachResumeCheckpointFlowTests`.

**Verification.**
```
cd console && swift build
swift test --filter 'CursorStoreTests|LiveOnlyCheckpointSurvivesRestartTests|SettingsStoreTests|WatchSupervisorTests|DaemonTransitionTests|AttachResumeCheckpointFlowTests'
```

---

## Phase 5 — Privileged flow & egress

**Goal.** The export→sign→authorize state machine (incl. AuthorizeRetry + broker-restart re-export), authorizable-op discovery + schema-driven routing, egress-gated actions with transient key handling, and the drift/cadence guards.

**Dependencies.** Phase 1 (contract bundle, signer validator, spawn), Phase 2 (exit interpreters, envelope, argv sanitization), Phase 4 (supervisor state for context).

### P5-Task-1 — Authorizable-op discovery + operation descriptors + routing metadata

Build the authorizable-op set at launch by scanning the registry `privilege` field in `commands.json` — never a hardcoded list. Membership yields only the set; turn a member into a working invocation via a **schema-driven operation descriptor** derived from its `x-atlas-contract` (positional/flag operands + types, kind from the schema). Resolving operands produces a **`BoundInvocation`** — an immutable value carrying the op **and the fully-resolved operand argv** — from which **both** the export argv (`+ --export-challenge`) and the authorize argv (`+ --authorization <path>`) derive, so AuthorizeRetry's "exact same argv" guarantee holds by construction (operand-bearing ops included). A discovered op with **no** descriptor fails fast into an explicit "unsupported privileged command" surface — never a half-built invocation. Because the CLI schemas expose no operand `source` field, the focused-UI-vs-operator mapping is a Console-owned `OperandSourceMap` covering exactly the `authorizableOps` set, drift-guarded — **recorded in the spec's `ssot` exception list (amended on this PR) and retired when atlas ships an operand `source` field on `x-atlas-contract`**. There is **no** Console-owned command-membership list of any kind: the exit-6 backstop (P5-Task-3) needs no descriptor because it reuses the refused invocation's own argv.

**Interfaces:**
```swift
struct AuthorizableOpSet { static func derive(from bundle: ContractBundle) -> Set<String> }  // scan privilege
struct OperationDescriptor {
  let command: String
  let operands: [Operand]                            // from x-atlas-contract
}
struct Operand { let name: String; let kind: OperandKind; let source: OperandSource }
enum OperandKind { case positional(Int); case flag(String) }
enum OperandSource { case focusedObject(String); case operatorEntry }   // from Console-owned OperandSourceMap
struct BoundInvocation: Sendable {                    // immutable; the single argv authority for one flow
  let op: String
  let argv: [String]                                  // fully-resolved operand argv, ALWAYS including --json
                                                      // (verified: brain emits the JSON error envelope only when --json
                                                      // is sniffed — without it every authz.* branch returns human text)
  var exportArgv: [String] { argv + ["--export-challenge"] }
  func authorizeArgv(authorizationPath: URL) -> [String] { argv + ["--authorization", authorizationPath.path] }
}
struct OperationRouter {
  init(bundle: ContractBundle, operandSourceMap: [String:[String:OperandSource]])
  func descriptor(for op: String) -> OperationDescriptor?   // nil ⇒ unsupported-privileged-command surface
  func bind(_ op: String, focus: FocusContext, entry: [String:String]) throws -> BoundInvocation
}
```

**Test:** `PrivilegedOpDiscoveryRoutingTests` (test-plan #21) — a registry-fixture `commands.json` flips a `shared` row to authorization-required; the Console discovers it in the set **and** binds a valid `BoundInvocation` (export + authorize argv derived from the same operand argv, asserted byte-identical apart from the trailing flag); a descriptor-less op surfaces the explicit "unsupported privileged command" state, never a half-built invocation. `operandSourceMapCoversAuthorizableOps` — the `OperandSourceMap` covers every op in `authorizableOps`; a map entry for an op no longer in the set fails the test (stale-entry guard).

### P5-Task-2 — Privileged-flow state machine + per-flow temp dir

Each flow runs in a per-flow temp dir (`0700`) as cwd, with `--config <atlasRoot>/brain.config.yaml`. States: `Idle → Export → Display → Sign → Authorize → {Done | AuthorizeRetry | Retry | Failed}`.

- **Export** — `brain <op> --export-challenge` (exit 6) mints `<tempdir>/challenge.json`; read **once** into an immutable in-memory representation; never re-read the file.
- **Display** — validate the exported bytes once via `SignerContractValidator`, then run the **challenge↔invocation consistency gate** before anything renders: `challenge.op` MUST equal `BoundInvocation.op`; `challenge.runId`/`targetCommit` MUST match the invocation's corresponding operands when both carry them; `payloadCanonicalization` MUST be a supported value — any mismatch is a terminal `challenge-mismatch` failure that never reaches Display. (Full cryptographic binding of displayed fields → signed bytes is the **signer's** duty per SP-3 — it re-derives `signingPayload` from the displayed fields pre-prompt and refuses exit 2 on mismatch, broker recompute as second backstop; the Console adds the cheap contextual gate, not a second crypto path.) Render every committed field from that frozen representation; user confirms.
- **Sign** — pipe those exact confirmed bytes to `atlas-signer sign` on **stdin**, **no `--out`** (response is the sole stdout content); validate strict against the SP-3 response schema; branch on signer exit 0–5.
- **Authorize** — write the validated response to `<tempdir>/authorization.json` (`0600`); run `brain <op> --authorization <path>`.
- **Cleanup** — temp dir removed on **every** terminal transition (Done/Failed/cancel) and discarded-then-recreated on re-export.

**Per-stage outcome matrix (total — every stage lists its full outcome set; an unlisted combination is a plan bug, never implementer discretion):**

| stage | outcome | transition |
|---|---|---|
| Export | exit 6 + challenge minted | → Display |
| Export | spawn error / timeout / exit ∈ {1,2,4,5} / envelope `retryable:false` / missing or invalid `challenge.json` | → **Failed** (stage + code named; temp dir cleaned) |
| Export | envelope `retryable:true` | → **Failed** with a retry affordance (operator re-initiates; no auto-loop at Export) |
| Display | consistency-gate mismatch (op / context / canonicalization) | → **Failed** (`challenge-mismatch`) |
| Display | operator cancels | → Idle (cleanup) |
| Sign | exit 0 + schema-valid response echoing the frozen challenge | → Authorize |
| Sign | exit 1 (internal) / exit 2 (malformed or re-derivation refuse) / malformed stdout | → **Failed** (stage-named) |
| Sign | exit 3 (expired, checked pre-prompt) | → Export (fresh challenge) |
| Sign | exit 4 (cancel / biometry) | → Idle |
| Sign | exit 5 (key invalidated) | → **Failed** + SP-3 re-enroll runbook surface |
| Authorize | `authz.ok` (incl. `noop:true` — idempotent replay renders success) | → Done |
| Authorize | `authz.nonce_expired` / `nonce_unknown` | → Export |
| Authorize | retryable (exit 4/6 + `retryable:true`) or indeterminate (no parseable envelope after possible commit) | → AuthorizeRetry (same artifact) |
| Authorize | `authz.nonce_replayed` (exit 1 — nonce spent, op incomplete) | → **Failed** + reconciliation surface |
| Authorize | any other exit-1 `authz.*` refusal / exit 2 / exit 5 | → **Failed** (non-retryable contract refusal, stage-named) | **AuthorizeRetry** (retryable exit 4/6 with `retryable:true`, or indeterminate — `brain` died / no parseable envelope after the mutation may have committed) ⇒ resubmit the **exact same argv + authorization artifact**, `retryAfterMs` as floor: `authz.ok` (incl. `noop:true`) ⇒ Done; `authz.nonce_replayed` (exit 1, nonce spent on an incomplete op) ⇒ Failed + reconciliation surface (inspect via read commands, then explicit re-export); `authz.nonce_expired`/`nonce_unknown` ⇒ Export.

**Interfaces:**
```swift
enum PrivilegedFlowState {
  case idle, export(op:String), display(AuthorizationChallenge), sign, authorize
  case done, authorizeRetry, retry, failed(reason:String)
}
actor PrivilegedFlow {
  init(runner: ProcessRunner, brain: ResolvedBinary, signer: ResolvedBinary,
       router: OperationRouter, validator: SignerContractValidator, atlasRoot: URL)
  func begin(op: String, focus: FocusContext, entry: [String:String]) async
  func confirm() async                                  // Display → Sign with frozen bytes
  func cancel() async                                   // temp-dir cleanup
  var state: PrivilegedFlowState { get }
}
```

**Test:** `PrivilegedFlowExitTableTests` (test-plan #10) — drive export→sign→authorize with **software-P-256** fixtures; assert `brain` 0–6 and `atlas-signer` 0–5 are interpreted by the correct table; cover signer exit 3/4/5 branches and broker `authz.*` exit-6 handling. `BrokerRestartAuthorizeRetryTests` (test-plan #11) — `nonce_expired`/`nonce_unknown` ⇒ re-export (never resubmit stale); commit-then-response-loss ⇒ same-artifact resubmit returns `authz.ok`+`noop:true` ⇒ Done; `nonce_replayed` (exit 1) ⇒ reconciliation surface, no blind re-export.

### P5-Task-3 — Exit-6 backstop routing (argv reuse — no descriptor, no list)

Any broker `exit 6` (`action-required`) refusing a mutation for want of authorization ⇒ enter `Export` for that invocation — the functional route the fail-closed backstop provides for a command the Console did not pre-classify (e.g. the `git refresh` registry-vs-code drift, open-questions #1). **No descriptor and no membership list is needed:** the refused command was already invoked, so its fully-formed argv exists; the backstop wraps that argv into a `BoundInvocation` verbatim and enters the existing flow (`exportArgv` = same argv + `--export-challenge`). This works for **any** mutation returning exit 6, with no second classification authority and no Console-owned command list.

**Interfaces:** consumes P5-Task-1 `BoundInvocation` + P5-Task-2 `PrivilegedFlow`. Adds `handleExit6(refused: BoundInvocation, envelope: ErrorEnvelope)` into `PrivilegedFlow` — the caller constructs the `BoundInvocation` from the argv it just ran.

**Test:** covered within `PrivilegedOpDiscoveryRoutingTests` — an op **not** pre-classified as privileged (registry says `shared`) whose invocation returns exit 6 routes into Export reusing its exact argv, never stranding at exit 6 and never consulting a membership list.

### P5-Task-4 — Egress-gated actions + transient key handling

`query` / `index eval` behind explicit user action only (never polled), with `ATLAS_EGRESS_CAPABILITY_KEY` injected into the child env **only** for those two commands. Two operator-selected sources (both read-only to the Console): `env` (inherited from the operator's shell) and `keychain` (read via `SecItemCopyMatching` from a pre-existing operator-provisioned generic-password item — service `com.atlas.console.egress-capability-key`, account = login name; the Console never `SecItemAdd`/`Update`/`Delete`). **Keychain ACL contract (ad-hoc-signing reality):** the item is created out-of-band (`security add-generic-password`) with the default ACL; the Console is ad-hoc-signed, so its code requirement changes every rebuild and macOS re-shows the consent prompt after a rebuild — **"Always Allow" does not survive a rebuild, and that is the declared UX** (`env` stays the default source; `keychain` is opt-in). The Console never broadens the ACL; live-drive verifies the consent flow with the assembled `.app`. Plaintext held in process memory only for the spawn's lifetime, never cached, never persisted to any Console-owned store, never logged.

**Interfaces:**
```swift
let EgressMintingCommands: Set<String> = ["query", "index eval"]   // temporary mirror of apps/cli/CLAUDE.md
struct EgressKeyProvider {
  init(source: EgressKeySource)
  func withKey<T>(_ body: (String) async throws -> T) async throws -> T   // read on demand, drop after body
  // keychain path: SecItemCopyMatching only; env path: read ProcessInfo env
}
struct EgressAction {
  func query(_ text: String, runner: ProcessRunner, brain: ResolvedBinary, key: EgressKeyProvider) async throws -> QueryResult
  func indexEval(runner: ProcessRunner, brain: ResolvedBinary, key: EgressKeyProvider) async throws -> IndexEvalResult
}
```

**Sensitive-operand boundary (redaction does not stop at the Console's own log):** the `query` text unavoidably rides argv to `brain` (upstream stdin input is a recorded atlas follow-up; until then the process-table exposure is **declared** — single-operator machine, consistent with the spec's executable-trust posture). What the Console owns: (1) its unified-log argv line redacts the operand (P2-Task-5); (2) **captured stderr from an egress-minting spawn is redaction-scrubbed before any `ConsoleLog.failure(detail:)` write** — a failed CLI invocation echoing the query must not reintroduce it into a persistent sink; the scrubbed stderr may render on the transient error surface.

**Test:** `EgressKeyScopingTests` (test-plan #18) — the key is injected into the child env only for `query`/`index eval` and for **no** other spawn (drive every read/privileged command, assert absence); logged argv/env redact it; it is never written to `UserDefaults`, the cursor SQLite, or the unified log; for `keychain`, assert a read-only `SecItemCopyMatching` (no Add/Update/Delete) and plaintext dropped after the child exits. `FailingQueryRedactionTests` — a scripted `query` failure whose stderr echoes the operand: assert it appears in **no** unified-log record (scrubbed from the failure detail) while the error surface still shows the scrubbed stderr.

### P5-Task-5 — Cadence guard + egress-minting drift + read-command conformance

Assert the cadence and drift invariants that keep the Console honest.

**Interfaces:** consumes the runtime read-surface inventory (`ContractBundle.commands` filtered by `executionClass`). The 25-command read surface (17 `read` + 4 `audited-read` + 4 `pure`) is inventoried at runtime by `executionClass` — never a prose list.

**Test:** `CadenceGuardTests` (test-plan #15) — the only periodic subprocess is `brain watch`; no audited read (`status`, `inspect`, `graduation audit`, `query`) ever runs on a timer (assert via the scheduler surface — the sole registered periodic task is the watch spawn). `EgressMintingDriftTests` — the `egressMintingConstantMatchesSchemas` case: `EgressMintingCommands` matches the schemas once an authoritative `mintsEgressCapability` field exists and disagrees (fails on drift). `ReadCommandConformanceTests` (test-plan #16) — parse representative `jobs list`/`note show`/`git status` `--json` against their `schemaRef` (reuse atlas fixtures), strict.

**Risks.** (1) Reading a signer exit against the `brain` table — mitigated by compile-separated interpreters (P2-Task-3) + `PrivilegedFlowExitTableTests`. (2) Double-executing (or falsely failing) a committed op after a lost response — mitigated by AuthorizeRetry's deterministic resubmit resolution. (3) A newly-privileged command discovered but unroutable — mitigated by the fail-fast unsupported-command surface + the routable-set union.

**Verification.**
```
cd console && swift build
swift test --filter 'PrivilegedOpDiscoveryRoutingTests|operandSourceMapCoversAuthorizableOps|PrivilegedFlowExitTableTests|BrokerRestartAuthorizeRetryTests|EgressKeyScopingTests|CadenceGuardTests|EgressMintingDriftTests|ReadCommandConformanceTests'
```

---

## Phase 6 — UI surfaces, accessibility, live drive

**Goal.** Render every V1 surface from the reducers, meet the accessibility bar, wire the observability announcements, and execute the manual live-drive checklist that is the evidence for intent criteria 2–3.

**Dependencies.** Phases 3–5 (reducers, supervisor, privileged flow, egress).

### P6-Task-1 — Dashboard, jobs, audit-timeline, model-call surfaces

SwiftUI views bound to the reducers: the health cockpit (`DashboardState` — open runs, jobs {queued,failed}, quarantine count, backup {watermark,covered,healthy}, audit head + anchor, daemon reachability, snapshot-only fields labelled "as of `<hello.at>`"); the jobs list (membership + `createdAt` order from `jobs list --json`, live-overlaid by coalesced `job` events); the audit timeline (seq-ordered `run.*`-space, session-scoped, as a list/table — seq, runId, eventType, time — its primary form, no chart-only encoding); the model-call activity feed (live `model_call`, insert-only, session-scoped). Detail-on-demand read commands (`note show`, `git review`, `jobs list`, `git status`, `index status`) invoked on user focus/action, never on a timer.

**Interfaces:**
```swift
struct DashboardView: View        // binds DashboardState
struct JobsListView: View         // binds JobStateCoordinator (owns JobStateMap + JobsListReader; read-on-focus refresh)
struct AuditTimelineView: View    // binds AuditReducer.timeline; list/table primary form
struct ModelCallFeedView: View    // live model_call feed
// The ONE generic executor every read-on-focus surface goes through — the schema-bound
// gateway to the runtime-inventoried 25-command read surface:
struct ReadCommandExecutor {
  init(bundle: ContractBundle, runner: ProcessRunner, binary: ResolvedBinary)
  func run(_ command: String, args: [String]) async throws -> Data
  // 1. looks up the CommandRow; REFUSES any command whose executionClass is not
  //    read/audited-read/pure (throws NotAReadCommand — write paths can never ride this executor)
  // 2. resolves the command's schema from the bundle; spawns with --json
  // 3. exit 0 ⇒ strict-validates stdout against the schemaRef and returns it
  // 4. nonzero ⇒ strict-parses the error envelope and throws it typed
}
```

**Test:** `SurfaceRenderTests` — each view renders from a fixture reducer state; snapshot-only fields carry the "as of" label; detail-on-demand triggers a spawn only on focus (no timer), asserted against the cadence guard. `ReadCommandExecutorTests` — executes a representative command from **each** execution class (read / audited-read / pure) via the runtime inventory, strict success + error-envelope parses both asserted; a `projection-write` command name throws `NotAReadCommand`; an unknown command name throws before any spawn.

### P6-Task-2 — Banners, badges, empty states, challenge-display modal

Backup-unhealthy + restore banners, quarantine badge, evidence-retry badge, daemon-down indicators, "service not installed" empty state (→ PR #206 runbook), watch-retry banner (attempt/next-retry/last-code), watch-failed terminal state. The challenge-display modal renders the full §7 display set — `op`, `runId`/`targetCommit` when present, `canonicalBaseCommit`, every `intendedEffect` field, `expiresAt`, and the SHA-256 of `signingPayload` — from the frozen in-memory representation, **control-character-safe**: every field quoted, C0/C1/ANSI/RTL-override bytes made visible, every committed value shown **in full** (an over-long value made inspectable, never silently truncated), with no raw control byte reaching the view or its accessibility label.

**Interfaces:**
```swift
struct ChallengeDisplayView: View          // binds the frozen AuthorizationChallenge; renders full §7 set
struct ControlSafeText { static func render(_ raw: String) -> AttributedString }  // quote + make control/ANSI visible; no truncation
struct RetryBanner: View; struct WatchFailedView: View; struct ServiceNotInstalledView: View
struct QuarantineBadge: View; struct EvidenceRetryBadge: View
```

**Test:** `ChallengeRenderingTests` (test-plan #17) — feed a challenge whose displayed fields embed raw C0/C1/ANSI CSI/RTL-override glyphs and over-length strings; assert the full display set (incl. `expiresAt` + `signingPayload` SHA-256) is rendered, every field quoted and shown in full (over-length inspectable, never truncated), control/ANSI/spoofing bytes made visible — no raw control byte reaches the view or its accessibility label; and that mutating the source `challenge.json` after confirm does **not** change the bytes piped to the signer.

### P6-Task-3 — Accessibility bar + VoiceOver announcements

macOS accessibility: SwiftUI roles/traits on every control; dashboard/jobs/timeline expose heading/landmark structure; no color-only information (health/reachability/job states carry redundant icon + text); Full Keyboard Access through the privileged flow end to end; visible focus rings, focus into the challenge modal + restoration on dismiss; Dynamic Type large-text layout without truncation; reduced motion honored (`NSWorkspace.accessibilityDisplayShouldReduceMotion` + SwiftUI environment); light/dark contrast on text and non-text indicators. **Live-region announcements** for: job succeeded/failed, backup unhealthy, daemon unreachable, challenge arrival/expiry, watch-retry/watch-failed, and in-flight subprocess activity (busy/loading + completion — never a silent spinner).

**Interfaces:**
```swift
struct A11yAnnouncer { func announce(_ event: A11yEvent) }   // AccessibilityNotification.Announcement
enum A11yEvent { case jobSucceeded(String), jobFailed(String), backupUnhealthy, daemonUnreachable(String),
                 challengeArrived, challengeExpired, watchRetrying(Int), watchFailed, busy(String), completed(String) }
```

**Test:** `AccessibilityAcceptanceTests` (test-plan #23) — the in-process subset a SwiftPM `swift test` run can host without an Xcode UI-test target/scheme: accessible names/roles/traits asserted on each view's accessibility tree, no color-only encoding (redundant icon+text present), Dynamic Type large-text layout without truncation, reduced-motion honored, and light/dark contrast on text/non-text indicators — all on views instantiated in-process. The checks that genuinely need a launched app host — Full Keyboard Access driving the privileged flow end to end, modal focus entry + restoration, and the VoiceOver announcement pass (each `A11yEvent`) — are the **documented manual checklist** executed on the live drive (§Live-drive checklist step 9), since a SwiftPM package provides no XCUI host.

### P6-Task-4 — Composition root, app model, settings surface

The application assembly nothing else owns: `AtlasConsoleApp` (`@main`) and a **`@MainActor` `AppModel`**. **Launch sequence (wiring before starting — load-bearing order):** load `Settings` (fresh install ⇒ `Settings.defaults`; no `atlasRoot`/override ⇒ blocking setup state) → `BinaryResolution.resolve` both binaries (blocking "unavailable" error state on probe failure, naming path + remediation) → build `ContractBundle`-derived inventories → **construct all reducers + `TransitionRouter`, obtain `AttachCoordinator.events`, start and retain the reducer-consumption task** → only then `AttachCoordinator.start()` — so a fast child's hello/replay/checkpoint-heartbeat can never outrun its consumer; the same order applies on every settings rebuild.

**Actor → UI observability:** `WatchSupervisor` and `PrivilegedFlow` each expose an `AsyncStream` of state changes (`stateChanges`); `AppModel` consumes both on the main actor and mirrors them into `@Observable` properties — every retry/terminal/challenge/authorize transition reaches SwiftUI (banners, modals, `A11yAnnouncer`) without polling actor snapshots.

**Pending-settings protocol (probe before persist; the cutover is atomic-or-rolled-back):** `applySettings(candidate)` (1) gates on any in-flight privileged flow; (2) **probes the candidate WITHOUT saving** — a probe failure surfaces validation feedback while the persisted settings and the running coordinator stay untouched; (3) on probe success: `AttachCoordinator.stop()` + await the old watch's exit → start the replacement coordinator → **commit (save) the candidate only after the replacement's first successful spawn**; (4) if the replacement fails to start, **restore the prior coordinator and keep the prior persisted settings** (typed failure surfaced). Persisted state can never name a configuration that was not proven live.

**Action surfaces (the intent-criterion-3 entry points):** an **Actions** surface enumerates `authorizableOps` (from `AuthorizableOpSet`), collects operands per the op's descriptor (focused-object fields pre-filled from the current selection, operator-entry fields as form inputs), and calls `PrivilegedFlow.begin` — rendering every flow state from the `stateChanges` stream (Display modal, AuthorizeRetry progress, Failed + reconciliation). A **Query** surface takes the query text + explicit run action, calls `EgressAction.query` via `EgressKeyProvider`, and renders `QueryResult` (and its `model_call` event lands in the feed). Both are keyboard-drivable end to end (P6-Task-3 bar).

**Interfaces:**
```swift
@main struct AtlasConsoleApp: App                  // scene = MainWindow(AppModel)
@MainActor @Observable final class AppModel {
  var phase: AppPhase                              // .probing | .blocked | .setupNeeded | .running
  func launch() async                              // settings → resolve+probe → WIRE → start
  func applySettings(_ candidate: Settings) async  // gate → probe (no save) → stop+await → start replacement → commit | rollback
}
struct SettingsView: View                          // edits Settings; Apply drives applySettings
struct ActionsView: View                           // authorizableOps list → operand form → PrivilegedFlow.begin
struct QueryView: View                             // explicit query action → EgressAction.query → result render
enum AppPhase { case probing, blocked(reason: String, path: String, remediation: String), setupNeeded, running }
// P4/P5 actors gain: var stateChanges: AsyncStream<SupervisorState> / AsyncStream<PrivilegedFlowState>
```

**Test:** `AppLaunchProbeTests` — a failing `brain` probe lands in `.blocked` naming the path + remediation, no coordinator started; a fresh install with no atlasRoot lands in `.setupNeeded`; a passing probe reaches `.running` with the watch spawn observed. `WiringOrderTests` — a fast-emitter child whose hello/replay/heartbeat fire immediately on spawn: every event reaches the reducers (none lost pre-wiring) and no checkpoint precedes reducer consumption. `SettingsCutoverTests` — candidate probe failure ⇒ nothing saved, old coordinator untouched, validation surfaced; replacement-start failure ⇒ prior coordinator restored, prior settings retained; success ⇒ exactly one watcher, candidate committed only after the replacement spawn; an unchanged save does not re-probe. `ActionSurfaceTests` — a UI-initiated op drives `PrivilegedFlow.begin` through the real spawn boundary (scripted runner) and renders each state from the stream; the query surface invokes `EgressAction.query` only on explicit action. `ActorStateStreamTests` — a supervisor retry transition and a flow challenge transition each reach the mirrored `@Observable` properties (and fire the matching `A11yEvent`).

### P6-Task-5 — Live-drive checklist + retro

Execute the 10-step manual E2E against a real install, capturing evidence in `docs/retros/2026-07-19-console-live-drive-retro.md` — the evidence for intent criteria 2–3.

**Live-drive checklist (run in order; pass = every expected observation seen; any deviation fails at that step number):**

1. **Prerequisites** — provisioned install, daemons loaded (`provisioning/macos/services.sh status` shows both), enrolled SE signer (`-vN`), `brain` + `atlas-signer` + Console built from source; `brain db status --json` exits 0.
2. **Seed state** — a vault with ≥ 1 open run, ≥ 1 queued + ≥ 1 failed job, a quarantined item; export `ATLAS_EGRESS_CAPABILITY_KEY` (or provision the Keychain item) for step 6. **Create the scratch trust fixture and record its baseline:** `brain source list --json` → pick/ingest a scratch source (`brain source show --json <id>` recorded), then `brain source trust show --json <id>` → record its exact trust state as `<baseline>` (the step-5 op and step-10 inverse are defined against this recorded value).
3. **Surface parity** — launch the Console; compare each surface against a one-shot manual read (dashboard vs `brain status --json` run once by hand; jobs vs `brain jobs list --json`; audit tail vs the most recent run-space rows). Expected: field-for-field agreement; snapshot-only fields labelled "as of `<hello.at>`".
4. **Daemon transition** — `sudo launchctl bootout system/com.atlas.egress` → indicator flips + banner within one heartbeat, no error dialog; re-bootstrap → recovers.
5. **Privileged round trip (criterion 3)** — run `source trust promote` on the step-2 scratch source (exact operands from the recorded baseline). **From this step on, the step-10 twin-op cleanup is an unconditional `finally`: it runs on success, failure, or abort of any later step — a drive stopped at 6–9 still executes 10 before it is called failed; a cleanup failure is its own escalation, recorded in the retro.** Export → challenge display shows `op`, every `intendedEffect` field, `canonicalBaseCommit`, `expiresAt`, payload SHA-256, all quoted/full-length. Sign → exactly **one** Touch ID prompt naming the op + digest prefix. Authorize → `authz.ok`, success surface, new run-space audit row in the timeline.
6. **Egress action + model-call surface** — run one explicit `query`. Expected: result renders; a `model_call` event for this query appears in the model-call feed (provider/model/operation + token counts); no `query` on any timer; the query string appears in **no** Console log line (`log show --predicate 'subsystem == "com.atlas.console"' --last 5m`).
7. **Broker-restart re-export** — export + sign, then `sudo launchctl kickstart -k system/com.atlas.broker` **before** authorizing. Submit → `authz.nonce_expired`/`nonce_unknown` surfaces; the Console **re-exports** a fresh challenge (never resubmits); the fresh flow succeeds.
8. **Watch resilience + resume** — `kill -9` the `brain watch` process → retry banner with attempt count + next-retry time, then a fresh `hello` re-baselines and clears it. **Before quitting: generate one new run-space audit event (e.g. the step-5 flow's row suffices if it landed after the last checkpoint; otherwise run one audited read like `brain status --json` by hand), then observe the next attached checkpoint heartbeat** — the cursor must be persisted past the new row so the relaunch assertion cannot pass trivially. Quit + relaunch → resume from the persisted cursor with no re-replay of the observed rows.
9. **VoiceOver pass** — execute the P6-Task-3 manual checklist (announcements + keyboard-only privileged flow).
10. **Cleanup (unconditional — runs even when an earlier step failed or the drive was aborted after step 5)** — run the exact inverse of step 5 (`source trust revoke` on the same source, via the full signer flow), then `brain source trust show --json <id>` and **verify the state equals the recorded `<baseline>`**; confirm every per-flow temp dir is gone; re-run `brain db status --json` (exit 0). Cleanup evidence is recorded separately in the retro; a cleanup failure escalates explicitly.

**Test:** the checklist itself + `docs/retros/2026-07-19-console-live-drive-retro.md` capturing each step's observation.

**Risks.** Unlabeled controls / keyboard-trapped flow shipping while suites stay green — mitigated by `AccessibilityAcceptanceTests` + the manual VoiceOver pass. The SE and live-broker timing are the explicit CI parity gap, covered by the checklist.

**Verification.**
```
cd console && swift build
swift test --filter 'SurfaceRenderTests|ReadCommandExecutorTests|ChallengeRenderingTests|AccessibilityAcceptanceTests|AppLaunchProbeTests|SettingsReprobeTests'
swift test                         # full suite — every named suite across all six phases, unfiltered
node <atlasRoot>/tools/gen-cli-contract.ts --check   # atlas contract determinism unaffected by console/
# then execute the live-drive checklist against a real install; capture the retro
```

Intent success criteria met at completion: all 8 event types decode with unknown-event tolerance (#1); every surface renders live (#2, checklist 3/6); the export→sign→authorize round trip + broker-restart re-export pass (#3, checklist 5/7); no audited read on a timer (#4, `CadenceGuardTests`); the CI Swift compile job green on `macos-15` (#5); the accessibility acceptance pass green (#6, `AccessibilityAcceptanceTests` + checklist 9).

---

## Integration Points

- **`brain` process contract (SP-1 + SP-2 reads):** `watch --json` (NDJSON over raw byte chunks, framed by `NDJSONFramer` — P2-Task-2) + the read-class `--json` surface. Shared artifact = the bound `ContractBundle` (`commands.json` + `*.schema.json`, incl. `watch.schema.json`), resolved from the **resolved binary's own checkout** (P1-Task-5) — the one anti-drift binding. The watch process's exit code flows to the supervisor via `StreamHandle.completion()` (P1-Task-3), separate from the framed lines.
- **`atlas-signer` process contract (SP-3):** stdin `AuthorizationChallenge` → stdout `AuthorizationResponse`; channel contract (summary/diagnostics → stderr, response → stdout, `--out` file-only). The challenge/response shapes are enforced by `SignerContractValidator` (P1-Task-6 — strict, negative-tested, every §7.1/§7.2 required field incl. `schemaVersion` + `payloadCanonicalization`, recursively validating the echoed response challenge), transcribed from `security-broker-contract.md §7.1/§7.2` + SP-3's `p256:` extension, **not** from `commands.json` and **not** by importing `@atlas/contracts`. Two disjoint exit namespaces in separate Swift interpreters (P2-Task-3).
- **Broker (indirect):** never touched directly. The broker's runtime exit 6 is the fail-closed backstop routing any un-pre-classified privileged mutation into Export (P5-Task-3) — no descriptor or membership list needed: the backstop wraps the refused invocation's own argv into a `BoundInvocation` verbatim, so it works for **any** mutation returning exit 6.
- **Registries as SSOT boundaries:** command membership/privilege/executionClass (`commands.json`+schemas), event shape (`watch.schema.json`), error codes (`x-atlas-contract.errorCodes`), vault location (`brain.config.yaml`) — all consumed, never re-derived, all constraint values read from the schema bytes at runtime by `SchemaValidator` (P1-Task-4). **Three honest Console-owned exceptions, each drift-guarded and recorded in the spec's `ssot` section (amended on this PR):** `EgressMintingCommands` (pinned constant + `egressMintingConstantMatchesSchemas`, P5-Task-5); the `SignerContractValidator` challenge/response shapes (transcribed from §7.1/§7.2, fixtures = embedded examples, bound to the signer checkout); and the routing metadata `OperandSourceMap` (scoped to `authorizableOps` only, `operandSourceMapCoversAuthorizableOps` drift test — the CLI schemas expose no operand `source` field; retired when atlas ships one).
- **Atlas-side additive follow-ups (filed, not blocking):** `git refresh` privilege drift bug (open-q #1), `mintsEgressCapability` field (#2), `space` discriminator for the audit reducer (#10), anchor-genesis `hello` field (#5), model-call history read (#4), and an operand `source` field on `x-atlas-contract` (would retire `OperandSourceMap`) — the Console consumes the current contract and treats each gap as a tracked atlas PR, never a Swift workaround.

## Testing Strategy

Scope-proportional — Swift unit + contract tests in CI, one transport-framing integration test, a manual live drive for the SE/live-broker paths. No integration/E2E pyramid beyond those (single-user desktop app). **No Secure Enclave in CI** (macOS runners are Virtualization.framework VMs): SE paths use software P-256 fixtures; SwiftUI views compile and run but never exercise the SE.

- **First / gating:** the runtime schema engine (`SchemaValidatorTests`, `SchemaKeywordCoverageTests` covering `allOf/not/if/then/else` + the applicator-heavy `query`/`purge`/`index-repair` schemas), the typed wrapper (`SchemaDecodeTests`), the decoders (#1, #2), and the exit/envelope interpreters (#13) — everything downstream depends on strict, schema-owned validation. The CI compile+assemble job (P1-Task-1) stands up before any logic so every merge is gated.
- **Core correctness:** the reducers (#3–#8, incl. `LiveOnlyExistingLedgerBaselineTests`), the watch supervisor + exit classification (#20), and the checkpoint (incl. `LiveOnlyCheckpointSurvivesRestartTests`) run fully in CI against fixtures + a scripted-spawn harness — no real broker. These carry the load-bearing invariants (run-space-only audit, seeded contiguous-prefix cursor, snapshot-plus-delta job counts, gated backoff, live-only resume).
- **Security-critical:** challenge rendering (#17), egress-key scoping/redaction/no-persist (#18), argv sanitization (#19), privileged-flow exit-table separation (#10, #11), the exit-6-backstop routing (P5-Task-3), and the signer-validator negatives (incl. the `schemaVersion`/`payloadCanonicalization`/nested-challenge cases) — all CI-runnable with software P-256 fixtures.
- **Structure:** `ModuleAcyclicityTests` asserts `ConsoleCore ← ConsoleUI ← AtlasConsole` has no library→executable back-edge; `AppBundleIdentityTests` asserts the assembled `.app` carries `com.atlas.console`.
- **Transport realism:** `TransportFramingTests` (#22) drives the real subprocess-pipe read path against the raw-chunk `StreamHandle.bytes` contract (chunk-≠-line, split UTF-8 scalar) — the one integration test that catches what fixture-string tests miss, passing only because framing lives in `NDJSONFramer`, not the spawn layer.
- **Deferred to the live drive:** the SE-exercising signing, the running-daemon transitions, the broker-restart timing (open-q #7 tuning), and the host-app-requiring accessibility checks (Full Keyboard Access end to end, modal focus restoration, the VoiceOver announcement pass) — a SwiftPM package has no XCUI host. Explicitly the CI parity gap; the checklist is the evidence for intent criteria 2–3.

*No rollback section:* the Console is a laptop app a `git revert` fully undoes; the only real-world mutations happen during the live drive against the operator's scratch vault and are reverted by the checklist's step-10 twin-op cleanup. No cloud infra, shared state, or migration warrants rollback machinery.

## Ambiguities flagged for the implementer

- **Backoff constants (open-q #7):** the 500 ms/×2/30 s/±20 %/`MAX=6` values are `behavior`-owned proposed defaults, not upstream-derived. Implement as named constants in one place (`BackoffPolicy` + `WATCH_MAX_CONSECUTIVE_FAILURES`, P4-Task-3); tune on the live drive against real broker-restart timing (nonce TTL 300 s).
- **Hello-baseline seed (P3-Task-1):** `AuditReducer.incorporateHello(baselinePrefix: hello.resume?.auditHeadSeq ?? -1)` is called on **every** hello before any row; `-1` = replayAll/fresh/detached, a reported prefix = existing-ledger live-only. Do **not** start the reducer at `-1` on an existing-ledger attach — that is the phantom-gap freeze.
- **Same-path re-clone residual (open-q #5):** `incarnation_key = SHA-256(ledger.path)` cannot prove lineage continuity; the catch-up-past-cursor case is a **declared accepted V1 residual**, escape `resumeMode: replayAll`. Do **not** try to close it in Swift — the fix is the atlas-side anchor-genesis `hello` field.
- **`git refresh` privilege drift + backstop routing (open-q #1, P5-Task-3):** consume the registry `privilege` field as-is for `authorizableOps`; there is **no** Console-side list for the drift case — if `git refresh` (or anything else) returns exit 6 at runtime, the backstop reuses that invocation's own argv to enter Export. File the atlas contract-drift bug; nothing on the Console side needs retiring when atlas fixes it.
- **Operand `source` is Console-owned (P5-Task-1):** the CLI schemas carry no focused-UI-vs-operator `source` field; `OperandSourceMap` is Console routing metadata scoped to `authorizableOps`, drift-guarded by `operandSourceMapCoversAuthorizableOps`, and recorded in the spec's `ssot` exception list (amended on this PR). If atlas later ships the operand `source` field on `x-atlas-contract`, bind to it and drop the map.
- **Single watcher (open-q #8):** V1 runs one `brain watch`; detail comes from read-on-focus, not a second watcher. Confirm no detail pane needs a second stream before building one.
- **Signer contract as a transcribed exception (P1-Task-6):** the challenge/response shapes have no standalone schema and cannot be imported from `@atlas/contracts`; they are the strict `SignerContractValidator` transcribed from `security-broker-contract.md §7.1/§7.2` (all required fields incl. `schemaVersion`/`payloadCanonicalization`) + SP-3's spec, positive fixtures = the embedded examples, negatives per P1-Task-6. If atlas later ships a machine-readable `authorization-challenge.schema.json`, validate through `SchemaValidator` against it and drop the transcription.
import Foundation
import Security
import XCTest
@testable import ConsoleCore

/// A `ProcessRunner` recording each spawn's command/argv/env and returning a per-command canned result.
final class RecordingRunner: ProcessRunner, @unchecked Sendable {
    struct Rec: Sendable { let command: String?; let argv: [String]; let env: [String: String] }
    private let lock = NSLock()
    private(set) var records: [Rec] = []
    private let results: [String: SpawnResult]
    private let fallback: SpawnResult

    init(results: [String: SpawnResult], fallback: SpawnResult = SpawnResult(exitCode: 0, stdout: Data(), stderr: Data())) {
        self.results = results
        self.fallback = fallback
    }

    func run(_ req: SpawnRequest) async throws -> SpawnResult {
        lock.withLock { records.append(Rec(command: req.command, argv: req.executable + req.arguments, env: req.environment)) }
        return results[req.command ?? ""] ?? fallback
    }
    func stream(_ req: SpawnRequest) throws -> StreamHandle { fatalError("no stream") }

    var recs: [Rec] { lock.withLock { records } }
}

final class EgressKeyScopingTests: XCTestCase {
    private static let sentinel = "SENTINEL-EGRESS-KEY-XYZ"

    private func validQueryStdout() throws -> Data {
        let schema = try TestSupport.contractSchema("query.schema.json")
        let obj = try JSONSerialization.jsonObject(with: schema) as! [String: Any]
        let ex = (obj["examples"] as! [Any])[0]
        return try JSONSerialization.data(withJSONObject: ex)
    }

    private func validIndexEvalStdout() throws -> Data {
        let schema = try TestSupport.contractSchema("index-eval.schema.json")
        let obj = try JSONSerialization.jsonObject(with: schema) as! [String: Any]
        let ex = (obj["examples"] as! [Any])[0]
        return try JSONSerialization.data(withJSONObject: ex)
    }

    private func envProvider() -> EgressKeyLocation {
        .env { [EgressCapabilityEnvVar: EgressKeyScopingTests.sentinel] }
    }

    // MARK: - Key injected ONLY for the two minting commands

    func testKeyInjectedForQueryAndIndexEval() async throws {
        let runner = RecordingRunner(results: [
            "query": SpawnResult(exitCode: 0, stdout: try validQueryStdout(), stderr: Data()),
            "index eval": SpawnResult(exitCode: 0, stdout: try validIndexEvalStdout(), stderr: Data()),
        ])
        let brain = try Fx4.binary()
        let key = EgressKeyProvider(source: envProvider())
        let action = EgressAction()

        let queries = URL(fileURLWithPath: "/tmp/eval-queries.json")
        let labels = URL(fileURLWithPath: "/tmp/eval-labels.json")
        _ = try await action.query("what is atlas", runner: runner, brain: brain, key: key)
        _ = try await action.indexEval(queries: queries, labels: labels, runner: runner, brain: brain, key: key)

        let queryRec = runner.recs.first { $0.command == "query" }
        let evalRec = runner.recs.first { $0.command == "index eval" }
        XCTAssertEqual(queryRec?.env[EgressCapabilityEnvVar], Self.sentinel)
        XCTAssertEqual(evalRec?.env[EgressCapabilityEnvVar], Self.sentinel)
        // `index eval` argv is COMPLETE: the CLI-required --queries/--labels paths + --json (a bare
        // `index eval --json` always exits usage). argv[0] is the launcher; the command tokens follow.
        XCTAssertEqual(evalRec?.argv.suffix(7).map { $0 },
                       ["index", "eval", "--queries", queries.path, "--labels", labels.path, "--json"])
    }

    /// `index eval` intentionally emits its full success payload with `pass:false` at exit 1 when the
    /// metrics fall below the graduation thresholds (mirroring `index verify`). That report-bearing exit-1
    /// is a SUCCESSFUL outcome — the validated report is returned, not thrown as a failure.
    func testIndexEvalBelowThresholdExit1ReturnsReport() async throws {
        let report = try validIndexEvalStdout() // the schema example with pass:false
        let runner = RecordingRunner(results: [
            "index eval": SpawnResult(exitCode: 1, stdout: report, stderr: Data()),
        ])
        let result = try await EgressAction().indexEval(
            queries: URL(fileURLWithPath: "/tmp/q.json"), labels: URL(fileURLWithPath: "/tmp/l.json"),
            runner: runner, brain: try Fx4.binary(), key: EgressKeyProvider(source: envProvider()))
        XCTAssertEqual(result.data, report, "the schema-valid pass:false report is returned, not discarded")
    }

    /// A non-report exit 1 (an error envelope on stdout, e.g. `eval-set-invalid`) is NOT a report — it
    /// fails the schema gate and surfaces as `EgressActionError.failed`, never a fake success.
    func testIndexEvalNonReportExit1Fails() async throws {
        let runner = RecordingRunner(results: [
            "index eval": SpawnResult(exitCode: 1, stdout: PFx.envelope(code: "eval-set-invalid"), stderr: Data("bad set".utf8)),
        ])
        do {
            _ = try await EgressAction().indexEval(
                queries: URL(fileURLWithPath: "/tmp/q.json"), labels: URL(fileURLWithPath: "/tmp/l.json"),
                runner: runner, brain: try Fx4.binary(), key: EgressKeyProvider(source: envProvider()))
            XCTFail("expected failure for a non-report exit 1")
        } catch let EgressActionError.failed(command, exitCode, _, _, _, _) {
            XCTAssertEqual(command, "index eval")
            XCTAssertEqual(exitCode, 1)
        }
    }

    func testKeyAbsentFromNonMintingSpawns() async throws {
        // A privileged flow spawn (export) must never carry the egress key — only EgressAction injects it.
        let root = PrivFlowKit.flowsRoot()
        let runner = PrivRunner(export: [SpawnResult(exitCode: 6, stdout: PFx.challenge(), stderr: Data())])
        let flow = try PrivFlowKit.make(runner: runner, flowsRoot: root)
        await flow.begin(op: "git approve", focus: FocusContext(fields: ["runId": PFx.runId]), entry: [:])
        for call in runner.calls {
            XCTAssertNotEqual(call.environment[EgressCapabilityEnvVar], Self.sentinel,
                              "the egress sentinel must never reach a non-egress spawn")
        }
    }

    // MARK: - Key never persisted / never in argv

    func testKeyNeverInArgv() async throws {
        let runner = RecordingRunner(results: [
            "query": SpawnResult(exitCode: 0, stdout: try validQueryStdout(), stderr: Data()),
        ])
        let brain = try Fx4.binary()
        _ = try await EgressAction().query("hello", runner: runner, brain: brain, key: EgressKeyProvider(source: envProvider()))
        for rec in runner.recs {
            XCTAssertFalse(rec.argv.contains(where: { $0.contains(Self.sentinel) }), "key must ride env, never argv")
        }
    }

    func testKeyNeverWrittenToUserDefaults() async throws {
        let suiteName = "egress-scoping-\(UUID().uuidString)"
        let defaults = UserDefaults(suiteName: suiteName)!
        defer { defaults.removePersistentDomain(forName: suiteName) }
        let runner = RecordingRunner(results: [
            "query": SpawnResult(exitCode: 0, stdout: try validQueryStdout(), stderr: Data()),
        ])
        _ = try await EgressAction().query("hello", runner: runner, brain: try Fx4.binary(), key: EgressKeyProvider(source: envProvider()))
        // Nothing in the egress path touches UserDefaults; the suite stays empty of the key.
        for (_, value) in defaults.dictionaryRepresentation() {
            if let s = value as? String { XCTAssertNotEqual(s, Self.sentinel) }
        }
    }

    // MARK: - Real production request paths: the caller's OWN child env never carries the key

    /// A `ResolvedBinary` whose `baseEnv` (which the watch/coordinator paths forward as `inherited:`)
    /// carries the sentinel — so we prove the PRODUCTION caller strips it, not a synthetic env.
    private func binaryWithInheritedSentinel() throws -> ResolvedBinary {
        let bundle = try TestSupport.realBundle()
        return ResolvedBinary(
            launch: ["/usr/bin/true"],
            contractAnchor: bundle.checkoutRoot,
            baseEnv: ["PATH": "/usr/bin:/bin", EgressCapabilityEnvVar: Self.sentinel],
            bundle: bundle
        )
    }

    /// Drive the REAL once-watch (`--once` `runner.run`) and streaming-watch (`runner.stream`) request
    /// paths through `AttachCoordinator` + `WatchSupervisor`, with the sentinel inherited via `baseEnv`.
    /// The runner records the env each production caller built; none may carry the capability key. This
    /// detects a caller that bypasses `ChildEnvironment.nonEgress` — the previous ChildEnvironment-only
    /// test could not.
    func testOnceAndStreamingWatchStripKeyAtTheRealCaller() async throws {
        let binary = try binaryWithInheritedSentinel()
        let dir = TestSupport.tempDir()
        let runner = ScriptedSpawnRunner(
            dir: dir,
            streams: [.emitThenBlock(lines: [Fx4.hello(path: "/vault/.atlas/atlas.db"),
                                             Fx4.heartbeat(path: "/vault/.atlas/atlas.db", resumeHead: 5)])],
            onceOutputs: [Fx4.hello(path: "/vault/.atlas/atlas.db")]
        )
        let supervisor = try WatchSupervisor(runner: runner, binary: binary)
        let cursors = try CursorStore(path: dir.appendingPathComponent("console.sqlite"))
        let coord = try AttachCoordinator(runner: runner, binary: binary, cursors: cursors,
                                          settings: .defaults, supervisor: supervisor)
        try await coord.start()
        // Wait for both the once-watch run and the live stream spawn.
        let deadline = Date().addingTimeInterval(30)
        while Date() < deadline, runner.streamCallCount < 1 { try? await Task.sleep(for: .milliseconds(25)) }
        await coord.stop()

        XCTAssertGreaterThanOrEqual(runner.runCallCount, 1, "the once-watch run path must have executed")
        XCTAssertGreaterThanOrEqual(runner.streamCallCount, 1, "the streaming-watch path must have executed")
        for env in runner.runEnvs {
            XCTAssertNil(env[EgressCapabilityEnvVar], "once-watch child env must not carry the capability key")
        }
        for env in runner.streamEnvs {
            XCTAssertNil(env[EgressCapabilityEnvVar], "streaming-watch child env must not carry the capability key")
        }
    }

    /// Drive the REAL export/sign/authorize privileged request paths with the sentinel BOTH in `baseEnv`
    /// and the genuine process env, capturing the env `PrivilegedFlow` actually built. None may carry it.
    func testExportSignAuthorizeStripKeyAtTheRealCaller() async throws {
        setenv(EgressCapabilityEnvVar, Self.sentinel, 1)
        defer { unsetenv(EgressCapabilityEnvVar) }
        let root = PrivFlowKit.flowsRoot()
        let runner = PrivRunner(
            export: [SpawnResult(exitCode: 6, stdout: PFx.challenge(), stderr: Data())],
            sign: [SpawnResult(exitCode: 0, stdout: PFx.response(for: PFx.challengeDict()), stderr: Data())],
            authorize: [SpawnResult(exitCode: 0, stdout: PFx.successStdout(), stderr: Data())]
        )
        let flow = try PrivFlowKit.make(runner: runner, flowsRoot: root)
        await flow.begin(op: "git approve", focus: FocusContext(fields: ["runId": PFx.runId]), entry: [:])
        await flow.confirm()
        XCTAssertEqual(Set(runner.callRoles), [.export, .sign, .authorize])
        for call in runner.calls {
            XCTAssertNil(call.environment[EgressCapabilityEnvVar],
                         "the \(call.role) child env must not carry the capability key")
        }
    }

    // A malicious non-egress overlay carrying the key is also refused by the shared builder.
    func testOverlayCannotReintroduceKey() throws {
        XCTAssertNil(ChildEnvironment.nonEgress(inherited: [:], overlay: [EgressCapabilityEnvVar: "x"])[EgressCapabilityEnvVar])
    }

    // MARK: - A GENUINELY inherited key (in the real process env) never reaches a privileged spawn

    func testGenuinelyInheritedKeyNeverReachesPrivilegedSpawn() async throws {
        setenv(EgressCapabilityEnvVar, Self.sentinel, 1)
        defer { unsetenv(EgressCapabilityEnvVar) }
        // Sanity: the key really is in the process environment now.
        XCTAssertEqual(ProcessInfo.processInfo.environment[EgressCapabilityEnvVar], Self.sentinel)

        let root = PrivFlowKit.flowsRoot()
        let runner = PrivRunner(
            export: [SpawnResult(exitCode: 6, stdout: PFx.challenge(), stderr: Data())],
            sign: [SpawnResult(exitCode: 0, stdout: PFx.response(for: PFx.challengeDict()), stderr: Data())],
            authorize: [SpawnResult(exitCode: 0, stdout: PFx.successStdout(), stderr: Data())]
        )
        let flow = try PrivFlowKit.make(runner: runner, flowsRoot: root)
        await flow.begin(op: "git approve", focus: FocusContext(fields: ["runId": PFx.runId]), entry: [:])
        await flow.confirm()
        for call in runner.calls {
            XCTAssertNil(call.environment[EgressCapabilityEnvVar],
                         "an inherited capability key must never reach export/sign/authorize")
        }
        // But EgressAction DOES inject its own transient key even when a stale one was inherited.
        let rec = RecordingRunner(results: ["query": SpawnResult(exitCode: 0, stdout: try validQueryStdout(), stderr: Data())])
        _ = try await EgressAction().query("q", runner: rec, brain: try Fx4.binary(),
                                           key: EgressKeyProvider(source: .env { [EgressCapabilityEnvVar: "TRANSIENT-KEY"] }))
        XCTAssertEqual(rec.recs.first { $0.command == "query" }?.env[EgressCapabilityEnvVar], "TRANSIENT-KEY")
    }

    // MARK: - Keychain source is strictly read-only (SecItemCopyMatching; no Add/Update/Delete)

    func testKeychainSourceReadOnlyMissingItemThrowsNotFound() async throws {
        // A never-provisioned generic-password item: SecItemCopyMatching returns errSecItemNotFound with
        // no prompt and no mutation — the Console never adds it.
        let service = "com.atlas.console.egress-capability-key.test-\(UUID().uuidString)"
        let key = EgressKeyProvider(source: .keychain(service: service, account: NSUserName()))
        do {
            _ = try await key.withKey { _ in 1 }
            XCTFail("expected keychainItemNotFound")
        } catch let EgressKeyError.keychainItemNotFound(svc, _) {
            XCTAssertEqual(svc, service)
        } catch let EgressKeyError.keychainReadFailed(status) {
            // Some sandboxed CI keychains deny the query outright (errSecInteractionNotAllowed etc.) —
            // still a read-only failure, never a mutation.
            XCTAssertNotEqual(status, errSecSuccess)
        }
    }

    // MARK: - env-mode missing key surfaces a keychain hint

    func testEnvModeMissingKeyThrowsWithKeychainHint() async throws {
        let key = EgressKeyProvider(source: .env { [:] })
        do {
            _ = try await key.withKey { _ in 1 }
            XCTFail("expected keyUnavailableFromEnv")
        } catch let EgressKeyError.keyUnavailableFromEnv(hint) {
            XCTAssertTrue(hint.contains("keychain"))
            XCTAssertTrue(hint.contains("Finder"))
        }
    }
}

/// A `SpawnLogging` sink that captures every record's textual fields, for the leak assertion.
final class CapturingLogSink: SpawnLogging, @unchecked Sendable {
    private let lock = NSLock()
    private(set) var lines: [String] = []
    func recordSpawn(command: String, argv: [String], schema: Data?, exitCode: Int32?) {
        let s = ConsoleLog.spawnLine(command: command, argv: argv, schema: schema, exitCode: exitCode)
        lock.withLock { lines.append(s) }
    }
    func recordTermination(command: String, exitCode: Int32, stderr: Data) {
        lock.withLock { lines.append(ConsoleLog.terminationLine(command: command, exitCode: exitCode, stderr: stderr)) }
    }
    func recordFailure(stage: String, path: String, detail: String, rawOutput: Data?) {
        lock.withLock { lines.append(ConsoleLog.failureLine(stage, path: path, detail: detail, rawOutput: rawOutput)) }
    }
    var all: [String] { lock.withLock { lines } }
}

final class FailingQueryRedactionTests: XCTestCase {
    func testFailedQueryStderrScrubbedFromLogAndErrorSurface() async throws {
        let queryText = "top secret patient record 42"
        // The scripted CLI fails and ECHOES the query text on stderr.
        let inner = RecordingRunner(results: [
            "query": SpawnResult(exitCode: 1,
                                 stdout: PFx.envelope(code: "internal"),
                                 stderr: Data("query failed for: \(queryText)".utf8)),
        ])
        let sink = CapturingLogSink()
        let runner = LoggingProcessRunner(wrapping: inner, sink: sink)
        let brain = try Fx4.binary()
        let key = EgressKeyProvider(source: .env { [EgressCapabilityEnvVar: "K"] })

        do {
            _ = try await EgressAction().query(queryText, runner: runner, brain: brain, key: key)
            XCTFail("expected failure")
        } catch let EgressActionError.failed(command, exitCode, code, _, _, scrubbedStderr) {
            XCTAssertEqual(command, "query")
            XCTAssertEqual(exitCode, 1)
            // The error surface shows the SCRUBBED stderr — the operand is gone, a length marker remains.
            XCTAssertFalse(scrubbedStderr.contains(queryText))
            XCTAssertTrue(scrubbedStderr.contains("<redacted:operand"))
            // Only content-free metadata is exposed; no raw envelope that could echo the query.
            XCTAssertFalse((code ?? "").contains(queryText))
        }

        // The query text appears in NO unified-log record: argv is redacted by ArgvClassifier and stderr
        // is recorded by byte length only.
        for line in sink.all {
            XCTAssertFalse(line.contains(queryText), "query text leaked into a log record: \(line)")
        }
        XCTAssertFalse(sink.all.isEmpty, "the failing spawn must still produce log records")
    }

    /// A query with shell/regex-metacharacters and embedded newlines is scrubbed WHOLE from the error
    /// surface AND the log; and the returned metadata is content-free (no envelope message).
    func testEscapedAndMultilineQueryFullyScrubbed() async throws {
        for queryText in ["a.*b|c$ (drop table)", "line one\nSSN 123-45-6789\nline three", "emoji 🔐 secret"] {
            let inner = RecordingRunner(results: [
                "query": SpawnResult(exitCode: 1,
                                     // The CLI echoes the query into BOTH the envelope message and stderr.
                                     stdout: PFx.envelope(code: "internal", message: "failed: \(queryText)"),
                                     stderr: Data("boom: \(queryText) <<".utf8)),
            ])
            let sink = CapturingLogSink()
            let runner = LoggingProcessRunner(wrapping: inner, sink: sink)
            do {
                _ = try await EgressAction().query(queryText, runner: runner, brain: try Fx4.binary(),
                                                   key: EgressKeyProvider(source: .env { [EgressCapabilityEnvVar: "K"] }))
                XCTFail("expected failure")
            } catch let EgressActionError.failed(_, _, code, _, _, scrubbedStderr) {
                XCTAssertFalse(scrubbedStderr.contains(queryText), "operand leaked onto the error surface")
                XCTAssertFalse((code ?? "").contains(queryText), "operand leaked via the code")
            }
            for line in sink.all {
                XCTAssertFalse(line.contains(queryText), "query text leaked into a log record: \(line)")
            }
        }
    }
}

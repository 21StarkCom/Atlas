import XCTest
@testable import ConsoleCore

final class ArgvSanitizationTests: XCTestCase {
    private func querySchema() throws -> Data {
        try TestSupport.contractSchema("query.schema.json")
    }

    func testFreeTextQueryOperandRedactedStructuralIntact() throws {
        let schema = try querySchema()
        let secret = "super secret text"
        let argv = ["/usr/local/bin/brain", "query", secret, "--k", "10", "--no-answer"]
        let out = ArgvClassifier.sanitize(command: "query", argv: argv, schema: schema)

        XCTAssertEqual(out[0], "/usr/local/bin/brain", "binary path intact")
        XCTAssertEqual(out[1], "query", "command token intact")
        XCTAssertEqual(out[2], "<redacted:query len=\(secret.count)>", "free-text operand redacted with length")
        XCTAssertEqual(out[3], "--k", "flag name intact")
        XCTAssertEqual(out[4], "10", "enumerated/structural flag value intact")
        XCTAssertEqual(out[5], "--no-answer", "boolean flag intact, consumes no value")
        XCTAssertFalse(out.contains(secret), "the sensitive value never appears in the sanitized argv")
    }

    /// A free-text query spanning MULTIPLE bare argv tokens must be fully redacted — not just its first
    /// token. `brain query top secret text` is one query; redacting only `top` leaks `secret text`.
    func testMultiTokenQueryFullyRedacted() throws {
        let schema = try querySchema()
        let argv = ["/b", "query", "top", "secret", "text", "--k", "10"]
        let out = ArgvClassifier.sanitize(command: "query", argv: argv, schema: schema)
        XCTAssertFalse(out.contains("secret"), "trailing query tokens must not leak")
        XCTAssertFalse(out.contains("text"), "trailing query tokens must not leak")
        XCTAssertEqual(out[2], "<redacted:query len=3>", "first query token redacted")
        XCTAssertEqual(out[3], "<redacted:query len=6>", "second query token redacted")
        XCTAssertEqual(out[4], "<redacted:query len=4>", "third query token redacted")
        XCTAssertEqual(out[5], "--k", "flag after the query is still recognized")
        XCTAssertEqual(out[6], "10", "structural flag value intact")
    }

    /// A misplaced secret in a value-flag must NOT be logged. `--k` takes a numeric value (1..100), so
    /// a non-numeric/out-of-range value is redacted, in both split and `=` forms.
    func testInvalidFlagValueRedacted() throws {
        let schema = try querySchema()
        let equals = ArgvClassifier.sanitize(command: "query", argv: ["/b", "query", "q", "--k=sk-SECRET"], schema: schema)
        XCTAssertFalse(equals.contains { $0.contains("sk-SECRET") }, "invalid --k=value must be redacted")
        XCTAssertTrue(equals.contains { $0 == "--k=<redacted:val len=9>" }, "\(equals)")

        let split = ArgvClassifier.sanitize(command: "query", argv: ["/b", "query", "q", "--k", "sk-SECRET"], schema: schema)
        XCTAssertFalse(split.contains("sk-SECRET"), "invalid --k value (split form) must be redacted")
        XCTAssertTrue(split.contains("<redacted:val len=9>"), "\(split)")

        // An out-of-range but numeric value is still redacted (constraint 1..100).
        let oob = ArgvClassifier.sanitize(command: "query", argv: ["/b", "query", "q", "--k", "9999"], schema: schema)
        XCTAssertFalse(oob.contains("9999"), "out-of-range numeric value must be redacted")

        // A valid in-range value stays intact.
        let ok = ArgvClassifier.sanitize(command: "query", argv: ["/b", "query", "q", "--k", "42"], schema: schema)
        XCTAssertTrue(ok.contains("42"), "in-range numeric value logged intact")
    }

    /// An unclassified value-flag (no numeric constraint, no enum — e.g. `--type <noteType>`) has its
    /// VALUE redacted: fail-closed, we log only affirmatively-structural values.
    func testUnclassifiedFlagValueRedacted() throws {
        let schema = try querySchema()
        let out = ArgvClassifier.sanitize(command: "query", argv: ["/b", "query", "q", "--type", "some-note-type"], schema: schema)
        XCTAssertEqual(out[3], "--type", "flag name intact")
        XCTAssertFalse(out.contains("some-note-type"), "unclassified flag value redacted (fail-closed)")
    }

    /// A one-shot spawn that exits non-zero emits an error-severity failure record alongside the launch
    /// record — a failed probe must not be buried at info. Raw stderr is byte-length only.
    func testNonZeroRunEmitsFailureRecord() async throws {
        let sink = RecordingSink()
        let runner = LoggingProcessRunner(wrapping: StubRunner(exitCode: 3, stderr: Data("secret-stderr".utf8)), sink: sink)
        let req = SpawnRequest(executable: ["/b"], arguments: ["db", "status"], cwd: TestSupport.tempDir(), environment: [:], command: "db status")
        _ = try await runner.run(req)
        XCTAssertEqual(sink.spawns.count, 1, "one launch record")
        XCTAssertEqual(sink.failures.count, 1, "a non-zero exit also emits a failure record")
        XCTAssertEqual(sink.failures[0].detail, "exit=3")
        XCTAssertNotNil(sink.failures[0].rawOutput, "stderr passed as byte-length-only rawOutput")
    }

    /// Every sensitive operand NAME resolves to a real positional in its command schema (stale-mapping
    /// guard): a name absent from the schema would be a stale mapping and fails here.
    func testSensitiveOperandNamesResolveInSchema() throws {
        let bundle = try TestSupport.realBundle()
        for (command, names) in ArgvClassifier.sensitiveOperands {
            guard let ref = bundle.commands.first(where: { $0.name == command }) else {
                return XCTFail("sensitiveOperands references unknown command `\(command)`")
            }
            XCTAssertTrue(ref.implemented, "sensitive command `\(command)` should be implemented")
            guard let schema = bundle.schema(for: command) else {
                return XCTFail("no schema for `\(command)`")
            }
            let positionals = Set(ArgvClassifier.positionalArgNames(schema: schema))
            for name in names {
                XCTAssertTrue(positionals.contains(name),
                              "stale mapping: `\(name)` is not a positional arg of `\(command)` (has \(positionals))")
            }
        }
    }

    /// A command with no sensitive mapping leaves its positional intact.
    func testUnmappedCommandPositionalNotRedacted() throws {
        let schema = try querySchema()
        // Pretend a non-sensitive command reuses the same schema shape: its positional stays intact.
        let argv = ["/usr/local/bin/brain", "inspect", "person-alice"]
        let out = ArgvClassifier.sanitize(command: "inspect", argv: argv, schema: schema)
        XCTAssertEqual(out, argv, "no sensitiveOperands entry ⇒ nothing redacted")
    }

    func testSpawnLineRedactsAndOmitsSecret() throws {
        let schema = try querySchema()
        let secret = "my private query"
        let line = ConsoleLog.spawnLine(
            command: "query",
            argv: ["/usr/local/bin/brain", "query", secret, "--k", "5"],
            schema: schema,
            exitCode: 0
        )
        XCTAssertTrue(line.contains("<redacted:query len=\(secret.count)>"))
        XCTAssertFalse(line.contains(secret))
        XCTAssertTrue(line.contains("exit=0"))
    }

    /// With no bound schema the logger fails closed — it redacts operands rather than logging them clear.
    func testSpawnLineFailsClosedWithoutSchema() {
        let secret = "leak me"
        let line = ConsoleLog.spawnLine(
            command: "query",
            argv: ["/usr/local/bin/brain", "query", secret],
            schema: nil,
            exitCode: nil
        )
        XCTAssertFalse(line.contains(secret), "no schema ⇒ redact rather than risk leaking a free-text operand")
    }

    func testFailureLineIncludesStageAndDetail() {
        let line = ConsoleLog.failureLine("probe", path: "/usr/local/bin/brain", detail: "timed out")
        XCTAssertTrue(line.contains("stage=probe"))
        XCTAssertTrue(line.contains("/usr/local/bin/brain"))
        XCTAssertTrue(line.contains("timed out"))
    }

    /// `brain` stderr is captured on the spawn result — never swallowed — for surfacing on error surfaces.
    func testStderrCapturedNeverDropped() async throws {
        let runner = SystemProcessRunner()
        let req = SpawnRequest(
            executable: ["/bin/sh"],
            arguments: ["-c", "printf 'probe-failure-detail' 1>&2; exit 2"],
            cwd: TestSupport.tempDir(),
            environment: ["PATH": "/usr/bin:/bin"]
        )
        let result = try await runner.run(req)
        XCTAssertEqual(result.exitCode, 2)
        XCTAssertEqual(String(decoding: result.stderr, as: UTF8.self), "probe-failure-detail")
    }

    // MARK: - Fail-closed argv classification

    /// Redaction length is the UTF-8 BYTE count, not the `String.count` grapheme/scalar count.
    func testRedactionLengthIsByteCount() throws {
        let schema = try querySchema()
        let secret = "café résumé"                 // 11 chars, 13 UTF-8 bytes (two 2-byte scalars)
        XCTAssertNotEqual(secret.count, secret.utf8.count, "precondition: multibyte")
        let out = ArgvClassifier.sanitize(command: "query", argv: ["/b", "query", secret], schema: schema)
        XCTAssertEqual(out[2], "<redacted:query len=\(secret.utf8.count)>", "byte length, not String.count")
        XCTAssertFalse(out[2].contains("\(secret.count)"), "must not use the grapheme count")
    }

    /// A malformed schema (no `x-atlas-contract.args`) can't resolve the sensitive operand's position;
    /// the classifier fails closed and redacts every positional rather than leaking it.
    func testMalformedSchemaFailsClosed() throws {
        let malformed = Data(#"{"type":"object"}"#.utf8) // no x-atlas-contract at all
        let secret = "leak me via malformed schema"
        let out = ArgvClassifier.sanitize(command: "query", argv: ["/b", "query", secret], schema: malformed)
        XCTAssertFalse(out.contains(secret), "malformed schema ⇒ fail closed, redact the positional")
        XCTAssertEqual(out[2], "<redacted:query len=\(secret.utf8.count)>")
    }

    /// A dash-prefixed positional (a query that starts with `-`) is NOT a declared flag — it must be
    /// treated as a positional operand and redacted, never passed through as a flag name.
    func testDashPrefixedQueryTreatedAsPositionalAndRedacted() throws {
        let schema = try querySchema()
        let secret = "-this-looks-like-a-flag-but-is-the-query"
        let out = ArgvClassifier.sanitize(command: "query", argv: ["/b", "query", secret], schema: schema)
        XCTAssertFalse(out.contains(secret), "dash-prefixed query is not a declared flag ⇒ redacted")
        XCTAssertEqual(out[2], "<redacted:query len=\(secret.utf8.count)>")
    }

    /// `--` ends flag parsing: the following token is a positional operand (here the sensitive query),
    /// and is redacted; `--` itself is structural.
    func testDoubleDashEndsFlagParsing() throws {
        let schema = try querySchema()
        let secret = "-weird-query-after-dashdash"
        let out = ArgvClassifier.sanitize(command: "query", argv: ["/b", "query", "--", secret], schema: schema)
        XCTAssertEqual(out[2], "--", "-- passes through structurally")
        XCTAssertEqual(out[3], "<redacted:query len=\(secret.utf8.count)>", "token after -- is a positional, redacted")
        XCTAssertFalse(out.contains(secret))
    }

    /// A slash-containing query must NOT be mistaken for a path and preserved — including on the
    /// fail-closed nil-schema path.
    func testSlashContainingQueryRedactedEvenWithoutSchema() {
        let secret = "path/to/some/secret thing"
        let line = ConsoleLog.spawnLine(command: "query", argv: ["/b", "query", secret], schema: nil, exitCode: nil)
        XCTAssertFalse(line.contains(secret), "nil-schema fallback must not preserve slash-containing operands")
        XCTAssertTrue(line.contains("<redacted:query len=\(secret.utf8.count)>"))
    }

    // MARK: - Failure-log leakage (raw stderr never persisted verbatim)

    /// Raw child stderr / query text handed to the failure log as `rawOutput` is recorded by byte length
    /// only — never verbatim — so egress stderr can't enter persistent logs.
    func testFailureLineScrubsRawOutput() {
        let secret = Data("egress: api_key=sk-LEAKED-SECRET oops".utf8)
        let line = ConsoleLog.failureLine("egress-spawn", path: "/b", detail: "exit=3", rawOutput: secret)
        XCTAssertFalse(line.contains("sk-LEAKED-SECRET"), "raw stderr must be scrubbed from the persistent log")
        XCTAssertTrue(line.contains("output=<redacted len=\(secret.count)>"))
        XCTAssertTrue(line.contains("detail=exit=3"), "the content-free detail descriptor is kept")
    }

    // MARK: - LoggingProcessRunner (enforcement seam)

    /// Every spawn through the wrapped runner emits EXACTLY ONE launch record; the sensitive operand
    /// never appears in it. The decorator is command-agnostic — the command + schema ride the request,
    /// so one wrapped runner sanitizes every command.
    func testLoggingProcessRunnerEmitsExactlyOneRecordPerSpawn() async throws {
        let schema = try querySchema()
        let sink = RecordingSink()
        let runner = LoggingProcessRunner(wrapping: StubRunner(), sink: sink)
        let secret = "top secret query"
        let req = SpawnRequest(
            executable: ["/usr/local/bin/brain"],
            arguments: ["query", secret],
            cwd: TestSupport.tempDir(),
            environment: [:],
            command: "query",
            commandSchema: schema
        )

        _ = try await runner.run(req)
        XCTAssertEqual(sink.spawns.count, 1, "exactly one record per run")
        XCTAssertEqual(sink.failures.count, 0)
        XCTAssertEqual(sink.spawns[0].command, "query", "the request's command is the redaction key")
        XCTAssertEqual(sink.spawns[0].exitCode, 0, "run records the child exit code")
        XCTAssertFalse(sink.renderedSpawnLines().contains { $0.contains(secret) }, "sensitive operand never logged")

        _ = try runner.stream(req)
        XCTAssertEqual(sink.spawns.count, 2, "exactly one additional launch record per stream")
        XCTAssertNil(sink.spawns[1].exitCode, "stream launch records nil exit (arrives later via completion())")
    }

    /// A stream launch is followed by EXACTLY ONE termination record carrying the exit code and
    /// byte-length-only stderr metadata — the decorator owns the streamed process's exit log.
    func testLoggingProcessRunnerLogsStreamTerminationExactlyOnce() async throws {
        let sink = RecordingSink()
        let terminated = expectation(description: "termination record emitted")
        sink.onTermination = { terminated.fulfill() }
        let runner = LoggingProcessRunner(wrapping: StubRunner(), sink: sink)
        let req = SpawnRequest(
            executable: ["/usr/local/bin/brain"],
            arguments: ["watch"],
            cwd: TestSupport.tempDir(),
            environment: [:],
            command: "watch"
        )

        _ = try runner.stream(req)
        await fulfillment(of: [terminated], timeout: 10)
        XCTAssertEqual(sink.terminations.count, 1, "exactly one termination record per stream")
        XCTAssertEqual(sink.terminations[0].command, "watch")
        XCTAssertEqual(sink.terminations[0].exitCode, 0, "/usr/bin/true exits 0")
    }

    /// The termination LINE records the exit code but only the stderr BYTE LENGTH — raw stderr never
    /// enters the persistent log.
    func testTerminationLineScrubsStderr() {
        let stderr = Data("egress: api_key=sk-LEAKED oops".utf8)
        let line = ConsoleLog.terminationLine(command: "watch", exitCode: 3, stderr: stderr)
        XCTAssertFalse(line.contains("sk-LEAKED"), "raw stderr must be scrubbed from the termination log")
        XCTAssertTrue(line.contains("exit=3"))
        XCTAssertTrue(line.contains("stderr=<redacted len=\(stderr.count)>"))
    }

    /// A spawn-layer failure emits exactly one failure record and zero spawn records; the typed error is
    /// the detail, not raw child output.
    func testLoggingProcessRunnerRecordsFailureOnce() async {
        let sink = RecordingSink()
        let runner = LoggingProcessRunner(wrapping: StubRunner(throwOnRun: true), sink: sink)
        let req = SpawnRequest(executable: ["/nope"], arguments: [], cwd: TestSupport.tempDir(), environment: [:], command: "query")
        do {
            _ = try await runner.run(req)
            XCTFail("run should rethrow the inner failure")
        } catch {
            // expected
        }
        XCTAssertEqual(sink.spawns.count, 0)
        XCTAssertEqual(sink.failures.count, 1, "exactly one failure record")
        XCTAssertNil(sink.failures[0].rawOutput, "no raw child output on a spawn-layer failure")
    }

    /// Wiring inspection: the composition root exposes ONLY the logging-wrapped runner (typed as the
    /// protocol), never a raw `SystemProcessRunner`. A component holding `composition.runner` therefore
    /// cannot bypass the logging seam — there is no API path to the unwrapped inner runner.
    func testCompositionRootRunnerCannotBypassLogging() {
        let composition = ProcessRunnerComposition(sink: RecordingSink())
        XCTAssertTrue(composition.runner is LoggingProcessRunner,
                      "the shared runner must be the logging decorator")
        XCTAssertFalse(composition.runner is SystemProcessRunner,
                      "the composition root must never hand out the unwrapped runner")
    }
}

// MARK: - Test doubles

/// A recording `SpawnLogging` sink so wiring tests can assert exactly-one-record-per-spawn.
private final class RecordingSink: SpawnLogging, @unchecked Sendable {
    struct Spawn { let command: String; let argv: [String]; let schema: Data?; let exitCode: Int32? }
    struct Termination { let command: String; let exitCode: Int32; let stderr: Data }
    struct Failure { let stage: String; let path: String; let detail: String; let rawOutput: Data? }
    private let lock = NSLock()
    private var _spawns: [Spawn] = []
    private var _terminations: [Termination] = []
    private var _failures: [Failure] = []
    /// Fired (outside the lock) each time a termination record lands — lets a test await it.
    var onTermination: (@Sendable () -> Void)?

    var spawns: [Spawn] { lock.lock(); defer { lock.unlock() }; return _spawns }
    var terminations: [Termination] { lock.lock(); defer { lock.unlock() }; return _terminations }
    var failures: [Failure] { lock.lock(); defer { lock.unlock() }; return _failures }

    func recordSpawn(command: String, argv: [String], schema: Data?, exitCode: Int32?) {
        lock.lock(); defer { lock.unlock() }
        _spawns.append(Spawn(command: command, argv: argv, schema: schema, exitCode: exitCode))
    }
    func recordTermination(command: String, exitCode: Int32, stderr: Data) {
        lock.lock()
        _terminations.append(Termination(command: command, exitCode: exitCode, stderr: stderr))
        let cb = onTermination
        lock.unlock()
        cb?()
    }
    func recordFailure(stage: String, path: String, detail: String, rawOutput: Data?) {
        lock.lock(); defer { lock.unlock() }
        _failures.append(Failure(stage: stage, path: path, detail: detail, rawOutput: rawOutput))
    }
    /// The sanitized spawn lines as they'd be rendered — used to assert no secret leaks.
    func renderedSpawnLines() -> [String] {
        spawns.map { ConsoleLog.spawnLine(command: $0.command, argv: $0.argv, schema: $0.schema, exitCode: $0.exitCode) }
    }
}

/// An in-memory `ProcessRunner` for wiring tests — never touches the OS.
private struct StubRunner: ProcessRunner {
    var throwOnRun = false
    var exitCode: Int32 = 0
    var stderr: Data = Data()
    func run(_ req: SpawnRequest) async throws -> SpawnResult {
        if throwOnRun { throw SpawnError.launchFailed(path: req.executable.first ?? "", underlying: "stub") }
        return SpawnResult(exitCode: exitCode, stdout: Data(), stderr: stderr)
    }
    func stream(_ req: SpawnRequest) throws -> StreamHandle {
        if throwOnRun { throw SpawnError.launchFailed(path: req.executable.first ?? "", underlying: "stub") }
        // A never-launched real process would be wrong here; wiring tests only need a handle instance.
        // Use a genuine short-lived process so StreamHandle is well-formed.
        let p = Process()
        p.executableURL = URL(fileURLWithPath: "/usr/bin/true")
        let out = Pipe(); let err = Pipe()
        p.standardOutput = out; p.standardError = err
        let handle = StreamHandle(process: p, stdout: out, stderr: err)
        try p.run()
        return handle
    }
}

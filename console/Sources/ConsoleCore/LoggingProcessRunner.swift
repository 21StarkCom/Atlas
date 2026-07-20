import Foundation

/// The sink `LoggingProcessRunner` routes its per-lifecycle records through. The production sink
/// (`ConsoleLogSink`) forwards to `ConsoleLog`'s `os.Logger`; tests inject a recorder to assert that
/// exactly one sanitized record is emitted per spawn (and one per stream termination) and that raw
/// child output never leaks.
public protocol SpawnLogging: Sendable {
    /// One sanitized spawn record. `command` is the redaction key + display name; `argv` is the full
    /// launch vector; `schema` is the bound command schema (nil ⇒ `ArgvClassifier` fails closed).
    /// `exitCode` is the completed code for a one-shot `run`, and nil for a stream launch (its code
    /// arrives later via `recordTermination`).
    func recordSpawn(command: String, argv: [String], schema: Data?, exitCode: Int32?)
    /// One stream-termination record: the streamed process's exit code plus its captured stderr — the
    /// stderr is recorded by byte length only, never verbatim. Emitted exactly once per stream launch.
    func recordTermination(command: String, exitCode: Int32, stderr: Data)
    /// One failure record. `detail` is a Console-authored content-free descriptor; `rawOutput` (if any)
    /// is recorded by byte length only — never verbatim.
    func recordFailure(stage: String, path: String, detail: String, rawOutput: Data?)
}

/// The production sink: forwards to `ConsoleLog`'s `os.Logger` (subsystem `com.atlas.console`).
public struct ConsoleLogSink: SpawnLogging {
    public init() {}
    public func recordSpawn(command: String, argv: [String], schema: Data?, exitCode: Int32?) {
        ConsoleLog.spawn(command: command, argv: argv, schema: schema, exitCode: exitCode)
    }
    public func recordTermination(command: String, exitCode: Int32, stderr: Data) {
        ConsoleLog.termination(command: command, exitCode: exitCode, stderr: stderr)
    }
    public func recordFailure(stage: String, path: String, detail: String, rawOutput: Data?) {
        ConsoleLog.failure(stage, path: path, detail: detail, rawOutput: rawOutput)
    }
}

/// The enforcement seam that makes "every spawn routes through sanitized logging" structural.
///
/// `LoggingProcessRunner` is a `ProcessRunner` DECORATOR wrapping any inner runner. It owns the
/// spawn / exit / failure log calls, sanitizing argv via `ArgvClassifier` with the command + schema
/// carried by each `SpawnRequest` (so ONE wrapped runner handles every command — nothing is bound at
/// wrap time). The composition root (`ProcessRunnerComposition`) wraps the one shared
/// `SystemProcessRunner` once and hands only the wrapped runner downstream, typed as `ProcessRunner`,
/// so no component ever holds an unwrapped runner and no spawn can bypass logging. The inner runner is
/// `private` — unreachable except through this decorator's `run`/`stream`.
///
/// Lifecycle records: a one-shot `run` emits exactly one `recordSpawn` (with the child exit code). A
/// `stream` emits one `recordSpawn` at launch (exit nil) and, exactly once, one `recordTermination`
/// when the streamed process exits — carrying the exit code and byte-length-only stderr metadata.
public struct LoggingProcessRunner: ProcessRunner {
    private let inner: ProcessRunner
    private let sink: SpawnLogging

    /// - Parameters:
    ///   - inner: the runner actually spawning the process (typically `SystemProcessRunner`).
    ///   - sink: where records go (default: the `os.Logger`-backed `ConsoleLogSink`).
    public init(wrapping inner: ProcessRunner, sink: SpawnLogging = ConsoleLogSink()) {
        self.inner = inner
        self.sink = sink
    }

    public func run(_ req: SpawnRequest) async throws -> SpawnResult {
        let command = req.command ?? "<unknown>"
        let path = req.executable.first ?? ""
        do {
            let result = try await inner.run(req)
            // The launch+outcome record (info). A non-zero exit is ALSO an error surface: emit an
            // error-severity failure record so a failed probe is not buried at .info. Its stderr is
            // recorded by byte length only (never verbatim) via `rawOutput`.
            sink.recordSpawn(command: command, argv: req.executable + req.arguments, schema: req.commandSchema, exitCode: result.exitCode)
            if result.exitCode != 0 {
                sink.recordFailure(stage: "exit", path: path, detail: "exit=\(result.exitCode)", rawOutput: result.stderr)
            }
            return result
        } catch {
            // A spawn-layer failure (typed `SpawnError`, not child output) — safe as `detail`. Model
            // timeout/cancellation as distinct terminal outcomes so they log at error with a token,
            // never as a clean spawn.
            let detail: String
            switch error {
            case SpawnError.timedOut(let d): detail = "timed-out=\(d)"
            case is CancellationError: detail = "cancelled"
            default: detail = "\(error)"
            }
            sink.recordFailure(stage: "spawn", path: path, detail: detail, rawOutput: nil)
            throw error
        }
    }

    public func stream(_ req: SpawnRequest) throws -> StreamHandle {
        let command = req.command ?? "<unknown>"
        let handle: StreamHandle
        do {
            handle = try inner.stream(req)
        } catch {
            sink.recordFailure(stage: "spawn", path: req.executable.first ?? "", detail: "\(error)", rawOutput: nil)
            throw error
        }
        // One record at launch; the exit code + captured stderr arrive later via `completion()`.
        sink.recordSpawn(command: command, argv: req.executable + req.arguments, schema: req.commandSchema, exitCode: nil)
        // Own the streamed process's exit log: await completion once and emit exactly one termination
        // record with the exit code and byte-length-only stderr metadata (never the raw bytes).
        let sink = self.sink
        Task {
            let completion = await handle.completion()
            sink.recordTermination(command: command, exitCode: completion.exitCode, stderr: completion.stderr)
        }
        return handle
    }
}

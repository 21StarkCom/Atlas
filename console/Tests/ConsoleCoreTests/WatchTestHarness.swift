import Foundation
@testable import ConsoleCore

// MARK: - Phase-4 fixture lines (schema-valid NDJSON, one JSON object per Data)

/// Builds schema-valid `watch.schema.json` event lines for the supervisor / coordinator tests. Lines are
/// derived from the schema's own `examples` (proven-decodable) and mutated only where a test needs to
/// vary a field (ledger path, resume seq, attach state). Decoding correctness itself is proven in
/// `WatchEventDecoderTests`; here we only need bytes the production `WatchTransport` accepts.
enum Fx4 {
    private static func example(event: String, attached: Bool?, file: StaticString = #filePath) -> [String: Any] {
        let schema = try! TestSupport.contractSchema("watch.schema.json", file: file)
        let obj = try! JSONSerialization.jsonObject(with: schema) as! [String: Any]
        let examples = obj["examples"] as! [[String: Any]]
        return examples.first { ex in
            guard ex["event"] as? String == event else { return false }
            guard let attached else { return true }
            let ledger = ex["ledger"] as? [String: Any]
            return (ledger?["attached"] as? Bool) == attached
        }!
    }

    private static func line(_ dict: [String: Any]) -> Data {
        try! JSONSerialization.data(withJSONObject: dict)
    }

    /// An attached hello for a given ledger path, with an optional resume head + replay descriptor.
    static func hello(path: String, resumeHead: Int? = 811, replayEvents: Int? = nil,
                      at: String = "2026-07-18T10:00:00.000Z") -> Data {
        var e = example(event: "watch.hello", attached: true)
        e["at"] = at
        e["ledger"] = ["attached": true, "path": path]
        if let resumeHead { e["resume"] = ["auditHeadSeq": resumeHead] } else { e.removeValue(forKey: "resume") }
        if let replayEvents { e["replay"] = ["sinceSeq": (resumeHead ?? -1), "events": replayEvents] }
        else { e.removeValue(forKey: "replay") }
        return line(e)
    }

    /// A detached hello (no ledger-derived snapshot keys).
    static func detachedHello(path: String = "/vault/.atlas/atlas.db",
                              at: String = "2026-07-18T10:00:00.000Z") -> Data {
        var e = example(event: "watch.hello", attached: false)
        e["at"] = at
        e["ledger"] = ["attached": false, "path": path]
        return line(e)
    }

    /// An attached heartbeat carrying a resume head (the safe checkpoint value).
    static func heartbeat(path: String = "/vault/.atlas/atlas.db", resumeHead: Int?,
                          attached: Bool = true, at: String = "2026-07-18T10:00:30.000Z") -> Data {
        var e = example(event: "watch.heartbeat", attached: nil)
        e["at"] = at
        e["ledger"] = ["attached": attached, "path": path]
        if let resumeHead { e["resume"] = ["auditHeadSeq": resumeHead] } else { e.removeValue(forKey: "resume") }
        return line(e)
    }

    /// A run-space audit line (replay row).
    static func audit(seq: Int, at: String = "2026-07-18T10:00:10.000Z") -> Data {
        var e = example(event: "audit", attached: nil)
        e["at"] = at
        e["seq"] = seq
        return line(e)
    }

    /// A terminal error envelope line (the sole non-event line).
    static func envelope(code: String, retryable: Bool, retryAfterMs: Int? = nil) -> Data {
        var dict: [String: Any] = ["code": code, "message": "mid-stream fault", "hint": "", "retryable": retryable]
        if let retryAfterMs { dict["retryAfterMs"] = retryAfterMs }
        return try! JSONSerialization.data(withJSONObject: dict)
    }

    /// A `ResolvedBinary` bound to the real repo contract bundle. `launch` is a placeholder — the scripted
    /// runner ignores it and launches its own emitter scripts.
    static func binary(file: StaticString = #filePath) throws -> ResolvedBinary {
        let bundle = try TestSupport.realBundle(file: file)
        return ResolvedBinary(
            launch: ["/usr/bin/true"],
            contractAnchor: bundle.checkoutRoot,
            baseEnv: ["PATH": "/usr/bin:/bin"],
            bundle: bundle
        )
    }
}

// MARK: - Scripted spawn runner

/// A `ProcessRunner` that scripts watch runs deterministically. `run(--once)` returns canned stdout with
/// no subprocess; `stream` pops the next scripted behavior, generates a tiny emitter shell script, and
/// delegates to a real `SystemProcessRunner` so the supervisor consumes a REAL `StreamHandle` + pipe
/// (framing/exit behave exactly as in production). Per-`stream()` argv is recorded for assertions.
final class ScriptedSpawnRunner: ProcessRunner, @unchecked Sendable {
    /// A scripted stream behavior.
    enum Stream {
        /// Emit `lines` then optionally a terminal `envelope`, then exit with `exit`.
        case emitThenExit(lines: [Data], envelope: Data?, exit: Int32)
        /// Emit `lines`, write `stderr` to the child's STDERR (never stdout), then exit with `exit` — so the
        /// captured-stderr carry onto the terminal error surface can be asserted.
        case emitThenExitWithStderr(lines: [Data], stderr: String, exit: Int32)
        /// Emit `lines` then block, trapping SIGTERM → exit 0 (a healthy sustained stream / clean detach).
        case emitThenBlock(lines: [Data])
        /// Emit `lines` then block, IGNORING SIGTERM entirely — only SIGKILL can reap it. Exercises the
        /// bounded SIGTERM→SIGKILL escalation (the never-hang guarantee) on a TERM-resistant child.
        case emitThenIgnoreTerm(lines: [Data])
    }

    private let inner = SystemProcessRunner()
    private let dir: URL
    private let lock = NSLock()
    private var streams: [Stream]
    private var onceOutputs: [Data]
    private var _streamCalls = 0
    private var _runCalls = 0
    private var _streamArgv: [[String]] = []
    /// The environments the PRODUCTION caller (WatchSupervisor / AttachCoordinator) built and passed on
    /// each SpawnRequest — recorded BEFORE this runner substitutes its own emitter env, so a scoping test
    /// can prove the real caller's child env never carries the egress capability key.
    private var _runEnvs: [[String: String]] = []
    private var _streamEnvs: [[String: String]] = []
    private var scriptSeq = 0

    init(dir: URL, streams: [Stream], onceOutputs: [Data] = []) {
        self.dir = dir
        self.streams = streams
        self.onceOutputs = onceOutputs
    }

    var streamCallCount: Int { lock.withLock { _streamCalls } }
    var runCallCount: Int { lock.withLock { _runCalls } }
    var streamArgv: [[String]] { lock.withLock { _streamArgv } }
    var runEnvs: [[String: String]] { lock.withLock { _runEnvs } }
    var streamEnvs: [[String: String]] { lock.withLock { _streamEnvs } }

    func run(_ req: SpawnRequest) async throws -> SpawnResult {
        let out: Data = lock.withLock {
            _runCalls += 1
            _runEnvs.append(req.environment)
            return onceOutputs.isEmpty ? Data() : onceOutputs.removeFirst()
        }
        return SpawnResult(exitCode: 0, stdout: out, stderr: Data())
    }

    func stream(_ req: SpawnRequest) throws -> StreamHandle {
        let behavior: Stream = try lock.withLock {
            _streamCalls += 1
            _streamArgv.append(req.arguments)
            _streamEnvs.append(req.environment)
            guard !streams.isEmpty else { throw ScriptExhausted() }
            return streams.removeFirst()
        }
        let scriptPath = try writeEmitter(behavior)
        let scriptReq = SpawnRequest(
            executable: [scriptPath],
            arguments: [],
            cwd: dir,
            environment: ["PATH": "/usr/bin:/bin"]
        )
        return try inner.stream(scriptReq)
    }

    struct ScriptExhausted: Error {}

    // MARK: - Script generation

    private func writeEmitter(_ behavior: Stream) throws -> String {
        let seq = lock.withLock { () -> Int in scriptSeq += 1; return scriptSeq }
        switch behavior {
        case .emitThenExit(let lines, let envelope, let exit):
            var payload = Data()
            for l in lines { payload.append(l); payload.append(0x0A) }
            if let envelope { payload.append(envelope); payload.append(0x0A) }
            let body = Self.octalEmit(payload) + "exit \(exit)\n"
            return try TestSupport.writeScript(dir, name: "watch-\(seq).sh", body: body)
        case .emitThenExitWithStderr(let lines, let stderr, let exit):
            var payload = Data()
            for l in lines { payload.append(l); payload.append(0x0A) }
            // Emit stdout lines, then write the diagnostic to fd 2 (stderr), then exit.
            let escaped = [UInt8](Data(stderr.utf8)).map { String(format: "\\0%03o", $0) }.joined()
            let stderrEmit = "printf '%b' '\(escaped)' 1>&2\n"
            let body = Self.octalEmit(payload) + stderrEmit + "exit \(exit)\n"
            return try TestSupport.writeScript(dir, name: "watch-\(seq).sh", body: body)
        case .emitThenBlock(let lines):
            var payload = Data()
            for l in lines { payload.append(l); payload.append(0x0A) }
            // Emit, then trap SIGTERM→exit 0 and idle so the pipe stays open (a sustained stream).
            let body = "trap 'exit 0' TERM INT\n" + Self.octalEmit(payload)
                + "while true; do sleep 0.02; done\n"
            return try TestSupport.writeScript(dir, name: "watch-\(seq).sh", body: body)
        case .emitThenIgnoreTerm(let lines):
            var payload = Data()
            for l in lines { payload.append(l); payload.append(0x0A) }
            // Ignore SIGTERM/SIGINT outright (trap ''), so only SIGKILL can reap this child.
            let body = "trap '' TERM INT\n" + Self.octalEmit(payload)
                + "while true; do sleep 0.02; done\n"
            return try TestSupport.writeScript(dir, name: "watch-\(seq).sh", body: body)
        }
    }

    /// `printf '%b'` octal escapes so arbitrary bytes survive shell quoting (matches TransportFramingTests).
    private static func octalEmit(_ payload: Data) -> String {
        guard !payload.isEmpty else { return "" }
        let escaped = [UInt8](payload).map { String(format: "\\0%03o", $0) }.joined()
        return "printf '%b' '\(escaped)'\n"
    }
}

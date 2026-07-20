import Foundation
import XCTest
import ConsoleCore
@testable import ConsoleUI

// Phase-6 UI test harness. ConsoleUITests can only see ConsoleCore's PUBLIC API (not ConsoleCoreTests'
// TestSupport/Fx4/ScriptedSpawnRunner), so this replicates the minimum needed: checkout location, a real
// contract bundle, watch-line builders, a scripted spawn runner (real emitter subprocesses, like the
// core harness), a role-scripted runner for the privileged/egress spawns, a recording read runner, and a
// throwaway cursor store — all through public entry points.

enum UITestSupport {
    static func consoleRoot(file: StaticString = #filePath) -> URL {
        var dir = URL(fileURLWithPath: "\(file)").deletingLastPathComponent()
        while dir.path != "/" {
            if FileManager.default.fileExists(atPath: dir.appendingPathComponent("Package.swift").path) { return dir }
            dir = dir.deletingLastPathComponent()
        }
        fatalError("no console/ root from \(file)")
    }

    static func checkoutRoot(file: StaticString = #filePath) -> URL {
        var dir = consoleRoot(file: file)
        while dir.path != "/" {
            if FileManager.default.fileExists(atPath: dir.appendingPathComponent("docs/specs/cli-contract/commands.json").path) { return dir }
            dir = dir.deletingLastPathComponent()
        }
        fatalError("no atlas checkout root from \(file)")
    }

    static func cliContractDir(file: StaticString = #filePath) -> URL {
        checkoutRoot(file: file).appendingPathComponent("docs/specs/cli-contract")
    }

    static func contractSchema(_ name: String, file: StaticString = #filePath) throws -> Data {
        try Data(contentsOf: cliContractDir(file: file).appendingPathComponent(name))
    }

    static func realBundle(file: StaticString = #filePath) throws -> ContractBundle {
        try ContractBundle.resolve(fromAnchor: checkoutRoot(file: file))
    }

    static func tempDir(_ label: String = "atlas-console-uitest") -> URL {
        let url = FileManager.default.temporaryDirectory.appendingPathComponent("\(label)-\(UUID().uuidString)", isDirectory: true)
        try? FileManager.default.createDirectory(at: url, withIntermediateDirectories: true)
        return url
    }

    static func binary(file: StaticString = #filePath) throws -> ResolvedBinary {
        let bundle = try realBundle(file: file)
        return try ResolvedBinary(launch: ["/usr/bin/true"], contractAnchor: bundle.checkoutRoot,
                              baseEnv: ["PATH": "/usr/bin:/bin"], bundle: bundle)
    }

    static func newCursorStore() throws -> CursorStore {
        try CursorStore(path: tempDir().appendingPathComponent("console.sqlite"))
    }

    /// Build a `LiveSession` on a scripted runner + the real bundle + a throwaway cursor store, with a
    /// no-op backoff sleeper (retries asserted without real waits).
    static func session(runner: ProcessRunner, settings: Settings = .defaults,
                        cursors: (any CursorStoring)? = nil,
                        sleeper: (@Sendable (Int) async -> Void)? = { _ in },
                        file: StaticString = #filePath) throws -> LiveSession {
        let brain = try binary(file: file)
        let store: any CursorStoring = try cursors ?? newCursorStore()
        return try SessionBuilder.build(brain: brain, signer: brain, runner: runner,
                                        cursors: store, settings: settings, sleeper: sleeper)
    }

    @discardableResult
    static func writeScript(_ dir: URL, name: String, body: String) throws -> String {
        let url = dir.appendingPathComponent(name)
        try ("#!/bin/sh\n" + body).write(to: url, atomically: true, encoding: .utf8)
        try FileManager.default.setAttributes([.posixPermissions: 0o755], ofItemAtPath: url.path)
        return url.path
    }

    static func schemaExample(_ file: String, index: Int = 0, fileID: StaticString = #filePath) throws -> Data {
        let data = try contractSchema(file, file: fileID)
        let obj = try JSONSerialization.jsonObject(with: data) as! [String: Any]
        let ex = (obj["examples"] as! [Any])[index]
        return try JSONSerialization.data(withJSONObject: ex)
    }
}

// MARK: - Watch NDJSON line builders (schema-example derived, mutated per test)

enum UIFx {
    private static func example(event: String, attached: Bool?, file: StaticString = #filePath) -> [String: Any] {
        let schema = try! UITestSupport.contractSchema("watch.schema.json", file: file)
        let obj = try! JSONSerialization.jsonObject(with: schema) as! [String: Any]
        let examples = obj["examples"] as! [[String: Any]]
        return examples.first { ex in
            guard ex["event"] as? String == event else { return false }
            guard let attached else { return true }
            return ((ex["ledger"] as? [String: Any])?["attached"] as? Bool) == attached
        }!
    }
    private static func line(_ d: [String: Any]) -> Data { try! JSONSerialization.data(withJSONObject: d) }

    static func hello(path: String, resumeHead: Int? = 811, at: String = "2026-07-18T10:00:00.000Z") -> Data {
        var e = example(event: "watch.hello", attached: true)
        e["at"] = at
        e["ledger"] = ["attached": true, "path": path]
        if let resumeHead { e["resume"] = ["auditHeadSeq": resumeHead] } else { e.removeValue(forKey: "resume") }
        e.removeValue(forKey: "replay")
        return line(e)
    }
    static func heartbeat(path: String, resumeHead: Int?, attached: Bool = true, at: String = "2026-07-18T10:00:30.000Z") -> Data {
        var e = example(event: "watch.heartbeat", attached: nil)
        e["at"] = at
        e["ledger"] = ["attached": attached, "path": path]
        if let resumeHead { e["resume"] = ["auditHeadSeq": resumeHead] } else { e.removeValue(forKey: "resume") }
        return line(e)
    }
    static func audit(seq: Int, at: String = "2026-07-18T10:00:10.000Z") -> Data {
        var e = example(event: "audit", attached: nil)
        e["at"] = at
        e["seq"] = seq
        return line(e)
    }
    static func envelope(code: String, retryable: Bool) -> Data {
        try! JSONSerialization.data(withJSONObject: ["code": code, "message": "m", "hint": "", "retryable": retryable])
    }
}

// MARK: - Scripted spawn runner (real emitter subprocesses for streams; scripted results for run)

/// A `ProcessRunner` that scripts `stream()` behaviors (real emitter subprocesses, like the core harness)
/// and answers `run()` by ROLE (once-hello / export / authorize / sign / query / generic), so ONE runner
/// serves a whole `LiveSession` (supervisor stream + coordinator once-probe + privileged flow + egress).
final class UIScriptedRunner: ProcessRunner, @unchecked Sendable {
    enum Stream { case emitThenExit(lines: [Data], envelope: Data?, exit: Int32); case emitThenBlock(lines: [Data]) }

    private let inner = SystemProcessRunner()
    private let dir: URL
    private let lock = NSLock()
    private var streams: [Stream]
    private var onceHellos: [Data]
    private var exportResults: [SpawnResult]
    private var signResults: [SpawnResult]
    private var authorizeResults: [SpawnResult]
    private var queryResults: [SpawnResult]
    private var genericResult: SpawnResult
    private var _streamCalls = 0
    private var _runCommands: [String] = []
    private var _signStdins: [Data] = []
    private var scriptSeq = 0

    init(dir: URL, streams: [Stream] = [], onceHellos: [Data] = [],
         exportResults: [SpawnResult] = [], signResults: [SpawnResult] = [],
         authorizeResults: [SpawnResult] = [], queryResults: [SpawnResult] = [],
         genericResult: SpawnResult = SpawnResult(exitCode: 0, stdout: Data(), stderr: Data())) {
        self.dir = dir; self.streams = streams; self.onceHellos = onceHellos
        self.exportResults = exportResults; self.signResults = signResults
        self.authorizeResults = authorizeResults; self.queryResults = queryResults
        self.genericResult = genericResult
    }

    var streamCallCount: Int { lock.withLock { _streamCalls } }
    var runCommands: [String] { lock.withLock { _runCommands } }
    /// The stdin bytes piped to each `atlas-signer sign` spawn, in order — so a test can assert the bytes
    /// signed are byte-identical to the originally displayed (frozen) challenge, regardless of any later
    /// mutation of the on-disk `challenge.json`.
    var signStdins: [Data] { lock.withLock { _signStdins } }

    func run(_ req: SpawnRequest) async throws -> SpawnResult {
        lock.withLock { _runCommands.append(req.command ?? "?") }
        return lock.withLock {
            let args = req.arguments
            if args.contains("--once") { return SpawnResult(exitCode: 0, stdout: onceHellos.isEmpty ? Data() : onceHellos.removeFirst(), stderr: Data()) }
            if args.contains("--export-challenge") { return exportResults.isEmpty ? genericResult : exportResults.removeFirst() }
            if args.contains("--authorization") { return authorizeResults.isEmpty ? genericResult : authorizeResults.removeFirst() }
            if req.command == "atlas-signer sign" || args.contains("sign") {
                if let stdin = req.stdin { _signStdins.append(stdin) }
                return signResults.isEmpty ? genericResult : signResults.removeFirst()
            }
            if req.command == "query" { return queryResults.isEmpty ? genericResult : queryResults.removeFirst() }
            return genericResult
        }
    }

    func stream(_ req: SpawnRequest) throws -> StreamHandle {
        let behavior: Stream = try lock.withLock {
            _streamCalls += 1
            guard !streams.isEmpty else { throw Exhausted() }
            return streams.removeFirst()
        }
        let path = try writeEmitter(behavior)
        return try inner.stream(SpawnRequest(executable: [path], arguments: [], cwd: dir, environment: ["PATH": "/usr/bin:/bin"]))
    }

    struct Exhausted: Error {}

    private func writeEmitter(_ b: Stream) throws -> String {
        let seq = lock.withLock { () -> Int in scriptSeq += 1; return scriptSeq }
        switch b {
        case .emitThenExit(let lines, let envelope, let exit):
            var payload = Data(); for l in lines { payload.append(l); payload.append(0x0A) }
            if let envelope { payload.append(envelope); payload.append(0x0A) }
            return try UITestSupport.writeScript(dir, name: "w-\(seq).sh", body: Self.octal(payload) + "exit \(exit)\n")
        case .emitThenBlock(let lines):
            var payload = Data(); for l in lines { payload.append(l); payload.append(0x0A) }
            return try UITestSupport.writeScript(dir, name: "w-\(seq).sh",
                body: "trap 'exit 0' TERM INT\n" + Self.octal(payload) + "while true; do sleep 0.02; done\n")
        }
    }
    private static func octal(_ p: Data) -> String {
        guard !p.isEmpty else { return "" }
        return "printf '%b' '" + [UInt8](p).map { String(format: "\\0%03o", $0) }.joined() + "'\n"
    }
}

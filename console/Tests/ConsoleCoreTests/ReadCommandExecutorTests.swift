import XCTest
@testable import ConsoleCore

/// P6-Task-1 — the schema-bound, execution-class-gated read gateway. Executes a representative command
/// from EACH read class (read / audited-read / pure) via the runtime inventory, asserts strict success +
/// typed error-envelope parsing, and proves a write-path command (projection-write) is refused BEFORE any
/// spawn — a mutating command can never ride this executor.
final class ReadCommandExecutorTests: XCTestCase {

    /// A stub runner returning a preset result per `command`, recording whether a spawn happened at all.
    private final class StubRunner: ProcessRunner, @unchecked Sendable {
        struct Preset { let exit: Int32; let stdout: Data; let stderr: Data }
        private let lock = NSLock()
        private var presets: [String: Preset]
        private(set) var spawnedCommands: [String] = []
        private(set) var lastCwd: URL?
        init(_ presets: [String: Preset]) { self.presets = presets }
        func run(_ req: SpawnRequest) async throws -> SpawnResult {
            lock.withLock { spawnedCommands.append(req.command ?? "?"); lastCwd = req.cwd }
            let p = lock.withLock { presets[req.command ?? ""] }
                ?? Preset(exit: 0, stdout: Data(), stderr: Data())
            return SpawnResult(exitCode: p.exit, stdout: p.stdout, stderr: p.stderr)
        }
        func stream(_ req: SpawnRequest) throws -> StreamHandle { fatalError("read gateway never streams") }
    }

    private func example(_ schemaFile: String) throws -> Data {
        let data = try TestSupport.contractSchema(schemaFile)
        let obj = try JSONSerialization.jsonObject(with: data) as! [String: Any]
        let ex = (obj["examples"] as! [Any])[0]
        return try JSONSerialization.data(withJSONObject: ex)
    }

    private func makeExecutor(_ presets: [String: StubRunner.Preset]) throws -> (ReadCommandExecutor, StubRunner) {
        let bundle = try TestSupport.realBundle()
        let binary = try ResolvedBinary(launch: ["/usr/bin/true"], contractAnchor: bundle.checkoutRoot,
                                    baseEnv: [:], bundle: bundle)
        let runner = StubRunner(presets)
        return (ReadCommandExecutor(runner: runner, binary: binary), runner)
    }

    // MARK: - Bundle provenance: gating/schema/cwd come ONLY from `binary.bundle`

    /// The executor takes its contract bundle EXCLUSIVELY from the resolved binary — there is no API to
    /// hand it a foreign bundle, so a caller can never gate/validate/cwd binary A under bundle B's
    /// contract. This proves the invariant end to end: the spawn's cwd is `binary.bundle.checkoutRoot`,
    /// and validation is against that same checkout's schema.
    func testGatingSchemaAndCwdComeFromBinaryBundle() async throws {
        let bundle = try TestSupport.realBundle()
        let binary = try ResolvedBinary(launch: ["/usr/bin/true"], contractAnchor: bundle.checkoutRoot,
                                    baseEnv: [:], bundle: bundle)
        let runner = StubRunner(["git status": .init(exit: 0,
                                                      stdout: try example("git-status.schema.json"),
                                                      stderr: Data())])
        let exec = ReadCommandExecutor(runner: runner, binary: binary)
        _ = try await exec.run("git status", args: [])
        XCTAssertEqual(runner.lastCwd?.standardizedFileURL, binary.bundle.checkoutRoot.standardizedFileURL,
                       "the read spawns in the binary's own checkout, never a foreign bundle's")
    }

    // MARK: - One command per read class validates + returns

    func testStrictSuccessAcrossEveryReadClass() async throws {
        let gitStatus = try example("git-status.schema.json")       // read
        let status = try example("status.schema.json")              // audited-read
        let dbStatus = try example("db-status.schema.json")         // pure
        let (exec, runner) = try makeExecutor([
            "git status": .init(exit: 0, stdout: gitStatus, stderr: Data()),
            "status": .init(exit: 0, stdout: status, stderr: Data()),
            "db status": .init(exit: 0, stdout: dbStatus, stderr: Data()),
        ])
        let a = try await exec.run("git status", args: [])
        let b = try await exec.run("status", args: [])
        let c = try await exec.run("db status", args: [])
        XCTAssertEqual(a, gitStatus)
        XCTAssertEqual(b, status)
        XCTAssertEqual(c, dbStatus)
        XCTAssertEqual(runner.spawnedCommands, ["git status", "status", "db status"])
    }

    // MARK: - Nonzero exit ⇒ typed error envelope

    func testErrorEnvelopeParsedAndThrownTyped() async throws {
        let envelope = try JSONSerialization.data(withJSONObject: [
            "code": "vault-locked", "message": "the vault is locked", "hint": "unlock it", "retryable": false,
        ])
        let (exec, _) = try makeExecutor([
            "git status": .init(exit: 2, stdout: envelope, stderr: Data()),
        ])
        do {
            _ = try await exec.run("git status", args: [])
            XCTFail("expected a typed error-envelope throw")
        } catch ReadCommandError.failed(let env) {
            XCTAssertEqual(env.code, "vault-locked")
            XCTAssertFalse(env.retryable)
        }
    }

    // MARK: - Exit 0 but invalid output ⇒ strict-validation failure

    func testExitZeroWithInvalidOutputFailsStrict() async throws {
        let (exec, _) = try makeExecutor([
            "git status": .init(exit: 0, stdout: Data("{\"not\":\"a git-status\"}".utf8), stderr: Data()),
        ])
        do {
            _ = try await exec.run("git status", args: [])
            XCTFail("expected strict validation failure")
        } catch ReadCommandError.invalidOutput(let command, _) {
            XCTAssertEqual(command, "git status")
        }
    }

    // MARK: - Write paths can NEVER ride the executor (refused before any spawn)

    func testProjectionWriteCommandRefusedBeforeSpawn() async throws {
        let (exec, runner) = try makeExecutor([:])
        do {
            _ = try await exec.run("index rebuild", args: [])  // projection-write
            XCTFail("a write path must be refused")
        } catch ReadCommandError.notAReadCommand(let command, let ec) {
            XCTAssertEqual(command, "index rebuild")
            XCTAssertEqual(ec, "projection-write")
        }
        XCTAssertTrue(runner.spawnedCommands.isEmpty, "no spawn for a refused write command")
    }

    func testMutatingCommandRefusedBeforeSpawn() async throws {
        let (exec, runner) = try makeExecutor([:])
        do {
            _ = try await exec.run("source add", args: [])     // mutating
            XCTFail("a mutating command must be refused")
        } catch ReadCommandError.notAReadCommand {
            // expected
        }
        XCTAssertTrue(runner.spawnedCommands.isEmpty)
    }

    func testUnknownCommandThrowsBeforeSpawn() async throws {
        let (exec, runner) = try makeExecutor([:])
        do {
            _ = try await exec.run("not a command", args: [])
            XCTFail("unknown command must throw")
        } catch ReadCommandError.unknownCommand(let c) {
            XCTAssertEqual(c, "not a command")
        }
        XCTAssertTrue(runner.spawnedCommands.isEmpty)
    }
}

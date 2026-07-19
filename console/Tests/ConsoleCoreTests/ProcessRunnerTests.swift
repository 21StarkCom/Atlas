import XCTest
@testable import ConsoleCore

final class ProcessRunnerTests: XCTestCase {
    let runner = SystemProcessRunner()

    func testRoundTripArgvCwdEnvStdinExit() async throws {
        let cwd = TestSupport.tempDir("prunner-cwd")
        let script = "printf 'cwd=%s\\n' \"$PWD\"; printf 'env=%s\\n' \"$MYVAR\"; printf 'args=%s|%s\\n' \"$1\" \"$2\"; printf 'stdin='; cat; exit 7"
        let req = SpawnRequest(
            executable: ["/bin/sh"],
            arguments: ["-c", script, "sh", "A", "B"],
            cwd: cwd,
            environment: ["MYVAR": "hello", "PATH": "/usr/bin:/bin"],
            stdin: Data("payload".utf8)
        )
        let result = try await runner.run(req)
        XCTAssertEqual(result.exitCode, 7, "non-zero exit surfaced, not thrown")
        let out = String(decoding: result.stdout, as: UTF8.self)
        // The child's $PWD may be symlink-resolved (/var → /private/var); assert on the unique dir name.
        XCTAssertTrue(out.contains("/\(cwd.lastPathComponent)\n") || out.contains("/\(cwd.lastPathComponent)"), "cwd not honored: \(out)")
        XCTAssertTrue(out.contains("env=hello"), out)
        XCTAssertTrue(out.contains("args=A|B"), out)
        XCTAssertTrue(out.contains("stdin=payload"), out)
    }

    func testHangingFixtureTimesOut() async throws {
        let req = SpawnRequest(
            executable: ["/bin/sh"],
            arguments: ["-c", "sleep 30"],
            cwd: TestSupport.tempDir(),
            environment: ["PATH": "/usr/bin:/bin"],
            timeout: .milliseconds(300)
        )
        do {
            _ = try await runner.run(req)
            XCTFail("expected timeout")
        } catch let e as SpawnError {
            guard case .timedOut = e else { return XCTFail("wrong error \(e)") }
        }
    }

    func testLargeOutputBothStreamsNoDeadlock() async throws {
        // ~200 KB on each stream — well over the ~64 KB pipe capacity; concurrent drain must not deadlock.
        let script = "dd if=/dev/zero bs=200000 count=1 2>/dev/null | tr '\\0' 'o'; dd if=/dev/zero bs=200000 count=1 2>/dev/null | tr '\\0' 'e' 1>&2"
        let req = SpawnRequest(
            executable: ["/bin/sh"],
            arguments: ["-c", script],
            cwd: TestSupport.tempDir(),
            environment: ["PATH": "/usr/bin:/bin"]
        )
        let result = try await runner.run(req)
        XCTAssertEqual(result.exitCode, 0)
        XCTAssertEqual(result.stdout.count, 200000)
        XCTAssertEqual(result.stderr.count, 200000)
    }

    /// Cancellation with NO timeout must reap the child AND throw `CancellationError` — never return a
    /// termination status as a successful result (the `withTaskCancellationHandler` body does not throw
    /// on its own).
    func testCancellationNoTimeoutReapsAndPropagates() async throws {
        let marker = TestSupport.tempDir("cancel-marker").appendingPathComponent("pid")
        // Long-running child (no timeout on the request), writes its pid so we can assert it's reaped.
        let script = "printf '%s' \"$$\" > '\(marker.path)'; sleep 30"
        let req = SpawnRequest(
            executable: ["/bin/sh"],
            arguments: ["-c", script],
            cwd: TestSupport.tempDir(),
            environment: ["PATH": "/usr/bin:/bin"]
            // timeout: nil — the path under test
        )
        let localRunner = SystemProcessRunner()
        let task = Task { try await localRunner.run(req) }
        // Give the child time to launch and record its pid.
        try await Task.sleep(for: .milliseconds(300))
        task.cancel()
        do {
            _ = try await task.value
            XCTFail("expected CancellationError, not a successful SpawnResult")
        } catch is CancellationError {
            // expected
        } catch {
            XCTFail("expected CancellationError, got \(error)")
        }
        // The child must have been reaped, not orphaned.
        let pidStr = (try? String(contentsOf: marker, encoding: .utf8))?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        if let pid = Int32(pidStr), pid > 0 {
            // Poll briefly: reap may still be settling.
            var alive = true
            for _ in 0..<50 {
                if kill(pid, 0) != 0 { alive = false; break }
                usleep(20_000)
            }
            XCTAssertFalse(alive, "child pid \(pid) should be reaped after cancellation")
        }
    }

    /// A child that never reads its stdin, handed a payload far larger than pipe capacity, must still
    /// hit the timeout — the stdin write is concurrent, so it cannot block the reap path. Regression
    /// for the synchronous-write deadlock (wing finding, ProcessRunner stdin).
    func testTimeoutWithOversizedUnreadStdin() async throws {
        let big = Data(count: 1_000_000) // ~1 MB, dwarfs the ~64 KB pipe buffer
        let req = SpawnRequest(
            executable: ["/bin/sh"],
            arguments: ["-c", "sleep 30"], // never reads stdin
            cwd: TestSupport.tempDir(),
            environment: ["PATH": "/usr/bin:/bin"],
            stdin: big,
            timeout: .milliseconds(400)
        )
        let start = Date()
        do {
            _ = try await runner.run(req)
            XCTFail("expected timeout")
        } catch let e as SpawnError {
            guard case .timedOut = e else { return XCTFail("wrong error \(e)") }
        }
        XCTAssertLessThan(Date().timeIntervalSince(start), 10, "must time out promptly, not block on the stdin write")
    }

    /// Same guard for cancellation: an oversized unread stdin must not stop cancellation from reaping.
    func testCancellationWithOversizedUnreadStdin() async throws {
        let big = Data(count: 1_000_000)
        let marker = TestSupport.tempDir("cancel-stdin-marker").appendingPathComponent("pid")
        let script = "printf '%s' \"$$\" > '\(marker.path)'; sleep 30" // records pid, never reads stdin
        let req = SpawnRequest(
            executable: ["/bin/sh"],
            arguments: ["-c", script],
            cwd: TestSupport.tempDir(),
            environment: ["PATH": "/usr/bin:/bin"],
            stdin: big
        )
        let localRunner = SystemProcessRunner()
        let task = Task { try await localRunner.run(req) }
        try await Task.sleep(for: .milliseconds(400))
        task.cancel()
        do {
            _ = try await task.value
            XCTFail("expected CancellationError")
        } catch is CancellationError {
            // expected
        } catch { XCTFail("expected CancellationError, got \(error)") }
        let pidStr = (try? String(contentsOf: marker, encoding: .utf8))?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        if let pid = Int32(pidStr), pid > 0 {
            var alive = true
            for _ in 0..<50 {
                if kill(pid, 0) != 0 { alive = false; break }
                usleep(20_000)
            }
            XCTAssertFalse(alive, "child pid \(pid) should be reaped despite the unread stdin")
        }
    }

    /// `stream()` must not block its caller on the stdin write. A stream caller already holds the
    /// handle, so a synchronous write to a non-reading child would deadlock with no way to terminate.
    /// The write is pumped concurrently; `stream()` returns promptly and the handle reaps the child.
    /// Regression for the synchronous-write deadlock (wing finding, ProcessRunner.stream stdin).
    func testStreamOversizedUnreadStdinDoesNotBlock() async throws {
        let big = Data(repeating: 0x61, count: 4 * 1024 * 1024) // 4 MiB ≫ pipe capacity
        let start = Date()
        let handle = try runner.stream(SpawnRequest(
            executable: ["/bin/sh"],
            arguments: ["-c", "sleep 30"], // never reads stdin
            cwd: FileManager.default.temporaryDirectory,
            environment: [:],
            stdin: big
        ))
        // If the stdin write were synchronous, control would never reach here.
        XCTAssertLessThan(Date().timeIntervalSince(start), 5, "stream() must return without blocking on stdin")
        handle.terminate()
        let completion = await handle.completion()
        XCTAssertNotEqual(completion.exitCode, 0, "a terminated child does not exit 0")
    }

    func testNonAbsoluteExecutableRejected() async {
        let req = SpawnRequest(executable: ["sh"], cwd: TestSupport.tempDir(), environment: [:])
        do {
            _ = try await runner.run(req)
            XCTFail("expected rejection")
        } catch let e as SpawnError {
            guard case .executableNotAbsolute("sh") = e else { return XCTFail("wrong error \(e)") }
        } catch { XCTFail("wrong error \(error)") }
    }

    /// Swift 6 strict-concurrency composition: one shared runner across three actors compiles + runs
    /// under complete checking (tools-version 6.0 enables the Swift 6 language mode by default).
    func testSharedRunnerAcrossActors() async throws {
        let shared = SystemProcessRunner()
        let a = FakeSupervisor(runner: shared)
        let b = FakeCoordinator(runner: shared)
        let c = FakeFlow(runner: shared)
        let ea = try await a.ping()
        let eb = try await b.ping()
        let ec = try await c.ping()
        XCTAssertEqual([ea, eb, ec], [0, 0, 0])
    }
}

// Dummy actors proving a single `ProcessRunner` instance is Sendable-shareable across the three
// downstream owners (WatchSupervisor / AttachCoordinator / PrivilegedFlow).
private actor FakeSupervisor {
    let runner: ProcessRunner
    init(runner: ProcessRunner) { self.runner = runner }
    func ping() async throws -> Int32 {
        try await runner.run(SpawnRequest(executable: ["/bin/sh"], arguments: ["-c", "exit 0"], cwd: FileManager.default.temporaryDirectory, environment: [:])).exitCode
    }
}
private actor FakeCoordinator {
    let runner: ProcessRunner
    init(runner: ProcessRunner) { self.runner = runner }
    func ping() async throws -> Int32 {
        try await runner.run(SpawnRequest(executable: ["/bin/sh"], arguments: ["-c", "exit 0"], cwd: FileManager.default.temporaryDirectory, environment: [:])).exitCode
    }
}
private actor FakeFlow {
    let runner: ProcessRunner
    init(runner: ProcessRunner) { self.runner = runner }
    func ping() async throws -> Int32 {
        try await runner.run(SpawnRequest(executable: ["/bin/sh"], arguments: ["-c", "exit 0"], cwd: FileManager.default.temporaryDirectory, environment: [:])).exitCode
    }
}

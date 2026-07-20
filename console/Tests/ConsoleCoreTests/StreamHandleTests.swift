import XCTest
@testable import ConsoleCore

final class StreamHandleTests: XCTestCase {
    let runner = SystemProcessRunner()

    func testChunksInOrderStderrCapturedExitOnce() async throws {
        // Emit stdout in two chunks with a gap, write stderr, exit 5.
        let script = "printf 'chunk1'; sleep 0.05; printf 'chunk2'; printf 'err-bytes' 1>&2; exit 5"
        let req = SpawnRequest(
            executable: ["/bin/sh"],
            arguments: ["-c", script],
            cwd: TestSupport.tempDir(),
            environment: ["PATH": "/usr/bin:/bin"]
        )
        let handle = try runner.stream(req)

        var collected = Data()
        for try await chunk in handle.bytes {
            collected.append(chunk)
        }
        XCTAssertEqual(String(decoding: collected, as: UTF8.self), "chunk1chunk2", "chunks arrive in order")

        let completion = await handle.completion()
        XCTAssertEqual(completion.exitCode, 5)
        XCTAssertEqual(String(decoding: completion.stderr, as: UTF8.self), "err-bytes", "stderr captured, never swallowed")

        // completion() resolves the same value again for a second awaiter.
        let again = await handle.completion()
        XCTAssertEqual(again.exitCode, 5)
    }

    /// Repeatedly races a final stderr write against process exit. Completion must ALWAYS carry the full
    /// stderr — it may not freeze the buffer at exit before a late stderr chunk is appended.
    func testFinalStderrWriteNeverLostAcrossExitRace() async throws {
        // A child that writes a fixed stderr payload immediately before exiting. `printf` to stderr then
        // exit — the write end closes right after, maximizing the exit-vs-stderr-EOF race.
        let payload = "final-stderr-payload-0123456789"
        for i in 0..<40 {
            let script = "printf 'out%d' 1>&1; printf '%s' 1>&2; exit 0"
                .replacingOccurrences(of: "%d", with: "\(i)")
                .replacingOccurrences(of: "%s", with: payload)
            let req = SpawnRequest(
                executable: ["/bin/sh"],
                arguments: ["-c", script],
                cwd: TestSupport.tempDir(),
                environment: ["PATH": "/usr/bin:/bin"]
            )
            let handle = try runner.stream(req)
            for try await _ in handle.bytes {}
            let completion = await handle.completion()
            XCTAssertEqual(completion.exitCode, 0, "iteration \(i)")
            XCTAssertEqual(
                String(decoding: completion.stderr, as: UTF8.self), payload,
                "final stderr write must never be dropped by the exit race (iteration \(i))"
            )
        }
    }

    func testTerminateEndsStream() async throws {
        let req = SpawnRequest(
            executable: ["/bin/sh"],
            arguments: ["-c", "sleep 30"],
            cwd: TestSupport.tempDir(),
            environment: ["PATH": "/usr/bin:/bin"]
        )
        let handle = try runner.stream(req)
        try await Task.sleep(for: .milliseconds(100))
        handle.terminate()
        let completion = await handle.completion()
        XCTAssertNotEqual(completion.exitCode, 0, "SIGTERM interrupts the sleep — not a clean exit 0")
        // The byte stream closes after termination.
        for try await _ in handle.bytes {}
    }
}

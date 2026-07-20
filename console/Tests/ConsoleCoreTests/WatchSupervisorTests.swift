import XCTest
@testable import ConsoleCore

/// P4-Task-3 — the gated-backoff watch supervisor. Covers the exhaustive `(exitCode, envelope?)`
/// classification matrix, the backoff progression + floor, the proven-healthy reset, and the terminal
/// cap — driven through a REAL subprocess-pipe scripted spawn harness.
final class WatchSupervisorTests: XCTestCase {

    /// Records injected backoff delays without waiting, so the policy is asserted deterministically.
    private final class DelayRecorder: @unchecked Sendable {
        private let lock = NSLock()
        private var _delays: [Int] = []
        func record(_ ms: Int) { lock.withLock { _delays.append(ms) } }
        var delays: [Int] { lock.withLock { _delays } }
    }

    /// Collects the observed `stateChanges` transitions without racing the run loop.
    private final class StateRecorder: @unchecked Sendable {
        private let lock = NSLock()
        private var _states: [SupervisorState] = []
        func record(_ s: SupervisorState) { lock.withLock { _states.append(s) } }
        var states: [SupervisorState] { lock.withLock { _states } }
        var last: SupervisorState? { lock.withLock { _states.last } }
    }

    private func drive(_ streams: [ScriptedSpawnRunner.Stream]) async throws
    -> (state: SupervisorState, spawns: Int, delays: [Int], states: [SupervisorState]) {
        let dir = TestSupport.tempDir()
        let runner = ScriptedSpawnRunner(dir: dir, streams: streams)
        let binary = try Fx4.binary()
        let recorder = DelayRecorder()
        let sup = try WatchSupervisor(runner: runner, binary: binary, policy: .default,
                                      reapGrace: .milliseconds(150),
                                      sleeper: { ms in recorder.record(ms) })
        let states = StateRecorder()
        let collector = Task { for await s in sup.stateChanges { states.record(s) } }
        await sup.run(resumeArg: .liveOnly, options: WatchOptions())
        let state = await sup.state
        // Let the collector drain buffered transitions up to (and including) the terminal one.
        for _ in 0..<200 where states.last != state { try? await Task.sleep(for: .milliseconds(5)) }
        collector.cancel()
        return (state, runner.streamCallCount, recorder.delays, states.states)
    }

    private func hello(_ path: String = "/vault/.atlas/atlas.db") -> Data { Fx4.hello(path: path) }
    private func heartbeat() -> Data { Fx4.heartbeat(resumeHead: 907) }

    // MARK: - (a) exhaustive classification matrix (pure)

    func testClassifyMatrixIsTotalNoSilentDefault() {
        // Fully exhaustive over exits {0,1,2,3,4,5,6, 9-off-contract} × {retryable envelope, retryable:false
        // envelope, absent envelope}. Every cell asserted — the classifier is a total function with no
        // silent default, and the terminal cells carry the envelope hint (nil when absent, never fabricated).
        let retry = ErrorEnvelope(code: "boom", message: "m", hint: "try later", retryable: true, retryAfterMs: 1234)
        let nonRetry = ErrorEnvelope(code: "fatal", message: "m", hint: "give up", retryable: false)
        func c(_ e: Int32, _ env: ErrorEnvelope?) -> ExitClass { WatchSupervisor.classify(exit: e, envelope: env) }

        // exit 0 — clean detach for ALL three envelope variants (impossible envelope ignored).
        XCTAssertEqual(c(0, nil), .cleanDetach)
        XCTAssertEqual(c(0, retry), .cleanDetach)
        XCTAssertEqual(c(0, nonRetry), .cleanDetach)

        // exit 2 / 5 — STRUCTURALLY terminal for ALL three variants (the exit code wins over the envelope),
        // now INCLUDING the retryable:false and absent cells the reviewer flagged as missing.
        XCTAssertEqual(c(2, retry), .terminal(2, code: "boom", hint: "try later"))
        XCTAssertEqual(c(2, nonRetry), .terminal(2, code: "fatal", hint: "give up"))
        XCTAssertEqual(c(2, nil), .terminal(2, code: "config-or-vault-or-lock", hint: nil))
        XCTAssertEqual(c(5, retry), .terminal(5, code: "boom", hint: "try later"))
        XCTAssertEqual(c(5, nonRetry), .terminal(5, code: "fatal", hint: "give up"))
        XCTAssertEqual(c(5, nil), .terminal(5, code: "usage", hint: nil))

        // On-contract non-2/5 codes (1,3,4,6): retryable envelope ⇒ retryable; retryable:false ⇒ terminal
        // (carrying the hint); absent ⇒ retryable dropped-stream shape (exit-<n>, never a fabricated hint).
        for code: Int32 in [1, 3, 4, 6] {
            XCTAssertEqual(c(code, retry), .retryable(retryAfterMs: 1234, code: "boom"),
                           "code \(code) + retryable envelope ⇒ retryable, carries the envelope code")
            XCTAssertEqual(c(code, nonRetry), .terminal(code, code: "fatal", hint: "give up"),
                           "code \(code) + retryable:false ⇒ terminal + hint")
            XCTAssertEqual(c(code, nil), .retryable(retryAfterMs: nil, code: "exit-\(code)"),
                           "on-contract code \(code) + no envelope ⇒ retryable")
        }

        // Off-contract exit 9: a retryable envelope still retries; retryable:false is terminal; NO envelope
        // ⇒ terminal fail-fast (a bug surface, not a loop), with no fabricated hint.
        XCTAssertEqual(c(9, retry), .retryable(retryAfterMs: 1234, code: "boom"))
        XCTAssertEqual(c(9, nonRetry), .terminal(9, code: "fatal", hint: "give up"))
        XCTAssertEqual(c(9, nil), .terminal(9, code: "off-contract-exit-no-envelope", hint: nil))
    }

    // MARK: - (a) backoff progression + floor (pure)

    func testBackoffProgressionCapAndFloor() {
        var rng = SystemRandomNumberGenerator()
        let p = BackoffPolicy.default
        // 500 → 1s → 2s → 4s → 8s → 16s, then capped at 30s — each within ±20 %.
        let expected: [(Int, Int)] = [(1, 500), (2, 1000), (3, 2000), (4, 4000), (5, 8000), (6, 16000), (7, 30000), (9, 30000)]
        for (attempt, base) in expected {
            let d = p.delayMs(attempt: attempt, retryAfterMs: nil, using: &rng)
            XCTAssertGreaterThanOrEqual(d, Int(Double(base) * 0.79), "attempt \(attempt) delay \(d) below band")
            XCTAssertLessThanOrEqual(d, Int(Double(base) * 1.21), "attempt \(attempt) delay \(d) above band")
        }
        // retryAfterMs is a floor.
        let floored = p.delayMs(attempt: 1, retryAfterMs: 5000, using: &rng)
        XCTAssertGreaterThanOrEqual(floored, 5000)
    }

    // MARK: - (b)(c) proven-healthy reset + storm counter

    func testProvenHealthyRunResetsDelayAndCounter() async throws {
        // run1 fault (no heartbeat), run2 fault (no heartbeat), run3 HEALTHY then fault (reset), run4 terminal.
        let r = try await drive([
            .emitThenExit(lines: [hello()], envelope: Fx4.envelope(code: "e", retryable: true), exit: 4),
            .emitThenExit(lines: [hello()], envelope: Fx4.envelope(code: "e", retryable: true), exit: 4),
            .emitThenExit(lines: [hello(), heartbeat()], envelope: Fx4.envelope(code: "e", retryable: true), exit: 4),
            .emitThenExit(lines: [], envelope: nil, exit: 5),
        ])
        XCTAssertEqual(r.spawns, 4)
        XCTAssertEqual(r.delays.count, 3, "delays before respawns after runs 1,2,3 (run4 is terminal)")
        // attempt 1 (base 500) → attempt 2 (base 1000) → reset back to attempt 1 (base 500).
        XCTAssert((400...600).contains(r.delays[0]), "run1 → attempt-1 band, got \(r.delays[0])")
        XCTAssert((800...1200).contains(r.delays[1]), "run2 → attempt-2 band, got \(r.delays[1])")
        XCTAssert((400...600).contains(r.delays[2]), "run3 proven-healthy ⇒ reset to attempt-1 band, got \(r.delays[2])")
    }

    func testBareHelloWithoutHeartbeatNeverClearsStormCounterReachesCap() async throws {
        // Six [hello, retryable-fault] runs with NO sustained heartbeat ⇒ counter never resets ⇒ terminal cap.
        let streams = Array(repeating: ScriptedSpawnRunner.Stream
            .emitThenExit(lines: [hello()], envelope: Fx4.envelope(code: "e", retryable: true), exit: 4),
                            count: 6)
        let r = try await drive(streams)
        XCTAssertEqual(r.spawns, 6, "initial + 5 respawns; the 6th failure spawns no further attempt")
        XCTAssertEqual(r.state, .failed(exit: -1, code: "watch-retry-cap-exhausted", hint: nil, stderr: ""))
    }

    // MARK: - (d) non-retryable terminals

    func testExit5IsTerminalZeroRestart() async throws {
        let r = try await drive([.emitThenExit(lines: [hello()], envelope: nil, exit: 5)])
        XCTAssertEqual(r.spawns, 1)
        XCTAssertEqual(r.state, .failed(exit: 5, code: "usage", hint: nil, stderr: ""))
        XCTAssertTrue(r.delays.isEmpty)
    }

    func testExit2IsTerminalZeroRestart() async throws {
        let r = try await drive([.emitThenExit(lines: [hello()], envelope: nil, exit: 2)])
        XCTAssertEqual(r.spawns, 1)
        XCTAssertEqual(r.state, .failed(exit: 2, code: "config-or-vault-or-lock", hint: nil, stderr: ""))
    }

    func testExit4NonRetryableEnvelopeIsTerminal() async throws {
        let r = try await drive([.emitThenExit(lines: [hello()],
                                               envelope: Fx4.envelope(code: "fatal", retryable: false), exit: 4)])
        XCTAssertEqual(r.spawns, 1)
        // Fx4.envelope carries an empty hint; the terminal surface preserves it (not discarded to nil).
        XCTAssertEqual(r.state, .failed(exit: 4, code: "fatal", hint: "", stderr: ""))
    }

    // MARK: - (e) terminal cap

    func testSixConsecutiveFailuresReachTerminalCapNoSixthRespawn() async throws {
        let streams = Array(repeating: ScriptedSpawnRunner.Stream
            .emitThenExit(lines: [], envelope: Fx4.envelope(code: "e", retryable: true), exit: 4),
                            count: 8) // supply extra; only 6 should ever be consumed
        let r = try await drive(streams)
        XCTAssertEqual(r.spawns, 6, "6 consecutive failed runs (initial + 5), no 7th spawn")
        XCTAssertEqual(r.state, .failed(exit: -1, code: "watch-retry-cap-exhausted", hint: nil, stderr: ""))
    }

    // MARK: - (f) clean detach

    func testCleanExitZeroNoRestartNoFailure() async throws {
        let r = try await drive([.emitThenExit(lines: [hello()], envelope: nil, exit: 0)])
        XCTAssertEqual(r.spawns, 1)
        XCTAssertEqual(r.state, .detached)
        XCTAssertTrue(r.delays.isEmpty)
    }

    // MARK: - (g) dropped stream, no envelope ⇒ retry

    func testDroppedStreamNoEnvelopeRetries() async throws {
        let r = try await drive([
            .emitThenExit(lines: [hello()], envelope: nil, exit: 4),   // dropped stream, no envelope
            .emitThenExit(lines: [], envelope: nil, exit: 5),           // terminal to stop the loop
        ])
        XCTAssertEqual(r.spawns, 2, "the dropped stream was retried")
        XCTAssertEqual(r.delays.count, 1)
        XCTAssertEqual(r.state, .failed(exit: 5, code: "usage", hint: nil, stderr: ""))
    }

    // MARK: - (h) contract mismatch ⇒ terminate child, terminal, never hang

    func testFramingMismatchTerminatesChildAndIsTerminal() async throws {
        // A blank line (strict-contract violation) while the child stays alive: the transport rejects it,
        // the supervisor terminates + awaits the child, then enters terminal contractMismatch.
        let blank = Data("   ".utf8)
        let r = try await drive([.emitThenBlock(lines: [Fx4.hello(path: "/v/.atlas/x"), blank])])
        XCTAssertEqual(r.spawns, 1, "zero restarts on a contract mismatch")
        guard case .contractMismatch(let stage, _) = r.state else {
            return XCTFail("expected contractMismatch, got \(r.state)")
        }
        XCTAssertEqual(stage, "framing:blank-line")
    }

    // MARK: - (b) retry state surfaced on stateChanges with the real failure identity

    func testRetryStateSurfacedWithAttemptAndRealLastCode() async throws {
        // Two retryable runs (envelope code "e") then a terminal — the observable transitions include
        // .retrying with the actual code, never the literal "retryable".
        let r = try await drive([
            .emitThenExit(lines: [hello()], envelope: Fx4.envelope(code: "e", retryable: true), exit: 4),
            .emitThenExit(lines: [hello()], envelope: Fx4.envelope(code: "e", retryable: true), exit: 4),
            .emitThenExit(lines: [], envelope: nil, exit: 5),
        ])
        let retrying = r.states.compactMap { state -> (Int, String)? in
            if case .retrying(let attempt, _, let code) = state { return (attempt, code) }
            return nil
        }
        XCTAssertEqual(retrying.count, 2, "two retries were surfaced as observable transitions")
        XCTAssertEqual(retrying.map(\.0), [1, 2], "attempt increments across the storm")
        XCTAssertTrue(retrying.allSatisfy { $0.1 == "e" }, "lastCode is the envelope code, not \"retryable\"")
        // The terminal state is observed too.
        XCTAssertEqual(r.states.last, .failed(exit: 5, code: "usage", hint: nil, stderr: ""))
        // A dropped-stream retry (no envelope) carries the exit as its code.
        let d = try await drive([
            .emitThenExit(lines: [hello()], envelope: nil, exit: 4),
            .emitThenExit(lines: [], envelope: nil, exit: 5),
        ])
        let droppedCode = d.states.compactMap { state -> String? in
            if case .retrying(_, _, let code) = state { return code }; return nil
        }
        XCTAssertEqual(droppedCode, ["exit-4"], "dropped-stream retry surfaces the exit code")
    }

    // MARK: - (b) prompt stop() during .retrying — no hang, no further respawn

    func testStopDuringBackoffInterruptsPromptlyNoRespawn() async throws {
        // A blocking sleeper simulates a real (up to 30 s / unbounded retryAfterMs) backoff wait; stop()
        // must wake it immediately so the run loop returns promptly with NO further spawn.
        final class Gate: @unchecked Sendable {
            private let sem = DispatchSemaphore(value: 0)
            func wait() { sem.wait() }
        }
        let gate = Gate()
        let dir = TestSupport.tempDir()
        // Only ONE stream scripted: a respawn would throw ScriptExhausted, which the test would catch as
        // an extra spawn — so streamCallCount staying at 1 proves stop() ceased respawns.
        let runner = ScriptedSpawnRunner(dir: dir, streams: [
            .emitThenExit(lines: [hello()], envelope: Fx4.envelope(code: "e", retryable: true, retryAfterMs: 3_600_000), exit: 4),
        ])
        let binary = try Fx4.binary()
        // The injected sleeper blocks "forever" (until the process is torn down); stop() wakes the backoff
        // via its own continuation, so the run loop never actually waits on this.
        let sup = try WatchSupervisor(runner: runner, binary: binary, policy: .default,
                                      sleeper: { _ in gate.wait() })
        let runTask = Task { await sup.run(resumeArg: .liveOnly, options: WatchOptions()) }

        // Wait until the supervisor is in .retrying (the backoff has begun).
        var reachedRetrying = false
        for _ in 0..<400 {
            if case .retrying = await sup.state { reachedRetrying = true; break }
            try? await Task.sleep(for: .milliseconds(5))
        }
        XCTAssertTrue(reachedRetrying, "supervisor entered .retrying")

        // stop() must return promptly (well under the 1h retryAfterMs floor) and the run loop must finish.
        let start = Date()
        await sup.stop()
        await runTask.value
        XCTAssertLessThan(Date().timeIntervalSince(start), 3.0, "stop() interrupted the backoff promptly")
        let final = await sup.state
        XCTAssertEqual(final, .detached, "a stop during backoff ends detached, not respawned")
        XCTAssertEqual(runner.streamCallCount, 1, "no respawn after stop()")
    }

    // MARK: - (finding 4) transient diagnostics (hint + captured stderr) survive onto the error surface

    func testTerminalFailedCarriesHintAndCapturedStderr() async throws {
        // A non-retryable envelope (with a hint) on a non-structural exit, plus bytes on the child's stderr:
        // the terminal `.failed` state must surface BOTH the hint and the captured stderr — never discard
        // them (the contract requires exit, code/hint, and stderr on the error surface).
        let dir = TestSupport.tempDir()
        // emitThenExitWithStderr can't carry an envelope, so drive the envelope+hint path separately below;
        // here prove the stderr capture on a structural terminal (exit 5).
        let runner = ScriptedSpawnRunner(dir: dir, streams: [
            .emitThenExitWithStderr(lines: [hello()], stderr: "fatal: vault is locked\n", exit: 5),
        ])
        let sup = try WatchSupervisor(runner: runner, binary: try Fx4.binary(), policy: .default,
                                      reapGrace: .milliseconds(150), sleeper: { _ in })
        await sup.run(resumeArg: .liveOnly, options: WatchOptions())
        guard case .failed(let exit, let code, let hint, let stderr) = await sup.state else {
            return XCTFail("expected .failed, got \(await sup.state)")
        }
        XCTAssertEqual(exit, 5)
        XCTAssertEqual(code, "usage")
        XCTAssertNil(hint, "no envelope ⇒ no fabricated hint")
        XCTAssertTrue(stderr.contains("vault is locked"), "captured stderr surfaced, not swallowed: \(stderr)")

        // And the envelope hint IS carried when present (non-retryable envelope on exit 4).
        let r = try await drive([.emitThenExit(lines: [hello()],
            envelope: Fx4.envelope(code: "boom", retryable: false), exit: 4)])
        guard case .failed(_, _, let hint2, _) = r.state else { return XCTFail("expected .failed") }
        XCTAssertEqual(hint2, "", "the envelope hint (empty here) is preserved through to the error surface")
    }

    // MARK: - (finding 5) an unbounded retryAfterMs floor never traps (integer-safe floor + saturating nextAt)

    func testExtremeRetryAfterMsDoesNotTrap() async throws {
        // Pure: an Int.max floor must be returned in integer space — never round-tripped through Double
        // (which would trap). The jittered base is dwarfed by the floor, so the floor wins exactly.
        var rng = SystemRandomNumberGenerator()
        XCTAssertEqual(BackoffPolicy.default.delayMs(attempt: 1, retryAfterMs: Int.max, using: &rng), Int.max)

        // End-to-end: a retryable envelope with retryAfterMs = Int.max drives the supervisor into `.retrying`
        // with a SATURATED nextAt (Int.max) and no overflow trap; a following terminal stops the loop.
        let r = try await drive([
            .emitThenExit(lines: [hello()],
                          envelope: Fx4.envelope(code: "e", retryable: true, retryAfterMs: Int.max), exit: 4),
            .emitThenExit(lines: [], envelope: nil, exit: 5),
        ])
        XCTAssertEqual(r.spawns, 2, "the retry still happened despite the extreme floor")
        XCTAssertEqual(r.delays.first, Int.max, "the backoff delay saturated to the Int.max floor")
        let nextAts = r.states.compactMap { s -> Int? in
            if case .retrying(_, let nextAt, _) = s { return nextAt }; return nil
        }
        XCTAssertEqual(nextAts.first, Int.max, "nextAt saturated to Int.max instead of overflowing")
        XCTAssertEqual(r.state, .failed(exit: 5, code: "usage", hint: nil, stderr: ""))
    }

    // MARK: - (h) TERM-resistant child on a contract mismatch is SIGKILLed — never hangs

    /// B3 regression — concurrent `run()` calls must not start overlapping watch lifecycles. The actor's
    /// awaits make `run` reentrant, so without a single-flight guard a second caller would spawn a second
    /// watcher, overwrite `currentHandle`, and leave the first child unreaped.
    func testConcurrentRunCallsSpawnOnlyOneWatcher() async throws {
        let dir = TestSupport.tempDir()
        let runner = ScriptedSpawnRunner(dir: dir, streams: [
            .emitThenExit(lines: [], envelope: nil, exit: 0),   // clean detach ⇒ terminal, one spawn
            .emitThenExit(lines: [], envelope: nil, exit: 0),   // available if a second (wrong) run starts
        ])
        let sup = try WatchSupervisor(runner: runner, binary: try Fx4.binary(), policy: .default,
                                      reapGrace: .milliseconds(150), sleeper: { _ in })
        // Fire two concurrent runs; the second must be rejected by the single-flight guard.
        async let a: Void = sup.run(resumeArg: .liveOnly, options: WatchOptions())
        async let b: Void = sup.run(resumeArg: .liveOnly, options: WatchOptions())
        _ = await (a, b)
        XCTAssertEqual(runner.streamCallCount, 1, "concurrent run() calls must spawn exactly one watcher")
    }

    func testContractMismatchReapsTermResistantChild() async throws {
        // The emitter emits a blank line (a strict-contract violation ⇒ mismatch) then IGNORES SIGTERM and
        // idles. Bounded escalation must SIGKILL it so classification never blocks on completion().
        let blank = Data("   ".utf8)
        let r = try await drive([.emitThenIgnoreTerm(lines: [Fx4.hello(path: "/v/.atlas/x"), blank])])
        XCTAssertEqual(r.spawns, 1, "zero restarts on a contract mismatch")
        guard case .contractMismatch(let stage, _) = r.state else {
            return XCTFail("expected contractMismatch, got \(r.state)")
        }
        XCTAssertEqual(stage, "framing:blank-line")
    }
}

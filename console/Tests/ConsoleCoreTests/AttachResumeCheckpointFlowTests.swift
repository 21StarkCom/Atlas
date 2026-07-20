import XCTest
@testable import ConsoleCore

/// P4-Task-5 — the `AttachCoordinator` once-hello → cursor → plan → live-spawn → checkpoint-threading
/// flow, driven end-to-end through the scripted spawn harness (real pipes). The coordinator is the SOLE
/// checkpoint writer, and it never checkpoints a pre-replay hello value / detached heartbeat / a value
/// above the contiguous-prefix safe head.
final class AttachResumeCheckpointFlowTests: XCTestCase {

    private let pathA = "/vaultA/.atlas/atlas.db"
    private let pathB = "/vaultB/.atlas/atlas.db"
    private var keyA: String { IncarnationKey.derive(ledgerPath: pathA) }
    private var keyB: String { IncarnationKey.derive(ledgerPath: pathB) }

    private func makeCoordinator(streams: [ScriptedSpawnRunner.Stream], onceOutputs: [Data],
                                 cursors: any CursorStoring) throws -> (AttachCoordinator, ScriptedSpawnRunner) {
        let dir = TestSupport.tempDir()
        let runner = ScriptedSpawnRunner(dir: dir, streams: streams, onceOutputs: onceOutputs)
        let binary = try Fx4.binary()
        let supervisor = try WatchSupervisor(runner: runner, binary: binary)
        let coord = try AttachCoordinator(runner: runner, binary: binary, cursors: cursors,
                                          settings: .defaults, supervisor: supervisor)
        return (coord, runner)
    }

    // Generous timeout: these tests launch REAL emitter subprocesses (like TransportFramingTests), so
    // under the full suite's parallel load a spawn + transition can lag well past a few seconds.
    private func poll(timeout: Double = 30.0, _ cond: () async -> Bool) async -> Bool {
        let deadline = Date().addingTimeInterval(timeout)
        while Date() < deadline {
            if await cond() { return true }
            try? await Task.sleep(for: .milliseconds(25))
        }
        return await cond()
    }

    private func newStore() throws -> CursorStore {
        try CursorStore(path: TestSupport.tempDir().appendingPathComponent("console.sqlite"))
    }

    // MARK: - Attached existing-cursor: startup-hello rebaselines in place, checkpoint at heartbeat only

    func testAttachedResumeThenSingleCheckpointAtHeartbeat() async throws {
        let cursors = try newStore()
        try cursors.checkpoint(incarnationKey: keyA, seq: 100, updatedAt: "seed")
        let baseCheckpoints = cursors.checkpointCount

        let (coord, runner) = try makeCoordinator(
            streams: [
                // The live watch's OWN startup hello (same incarnation), a replay row, a checkpoint
                // heartbeat, then a same-incarnation re-hello — none of which tears down the watcher.
                .emitThenBlock(lines: [
                    Fx4.hello(path: pathA),
                    Fx4.audit(seq: 5),
                    Fx4.heartbeat(path: pathA, resumeHead: 907),
                    Fx4.hello(path: pathA),
                ]),
            ],
            onceOutputs: [Fx4.hello(path: pathA)],
            cursors: cursors)

        try await coord.start()

        // The checkpoint lands exactly once, at the heartbeat (907), not during replay.
        let checkpointed = await poll { (try? cursors.load(incarnationKey: self.keyA)) == 907 }
        XCTAssertTrue(checkpointed, "cursor checkpointed to the heartbeat's resume head")
        XCTAssertEqual(cursors.checkpointCount - baseCheckpoints, 1, "exactly one checkpoint, at the heartbeat")

        // The once-hello resumed from the existing cursor; the live spawn carried --since-seq 100.
        XCTAssertEqual(runner.streamCallCount, 1, "exactly one live spawn (startup + re-hello rebaseline in place)")
        let argv = runner.streamArgv[0]
        XCTAssertTrue(argv.contains("--since-seq"))
        XCTAssertEqual(argv[argv.firstIndex(of: "--since-seq")! + 1], "100")

        await coord.stop()
    }

    // MARK: - Different ledger.path mid-stream ⇒ stop + await old, consult new incarnation row

    func testIncarnationTransitionStopsOldBeforeNewSpawn() async throws {
        let cursors = try newStore()
        try cursors.checkpoint(incarnationKey: keyB, seq: 50, updatedAt: "seed") // the NEW incarnation's row
        let baseCheckpoints = cursors.checkpointCount

        let (coord, runner) = try makeCoordinator(
            streams: [
                // Incarnation A, then a fresh hello for a DIFFERENT ledger.path (B) mid-stream.
                .emitThenBlock(lines: [
                    Fx4.hello(path: pathA),
                    Fx4.heartbeat(path: pathA, resumeHead: 907),
                    Fx4.hello(path: pathB),
                ]),
                // Incarnation B's fresh stream.
                .emitThenBlock(lines: [
                    Fx4.hello(path: pathB),
                    Fx4.heartbeat(path: pathB, resumeHead: 200),
                ]),
            ],
            onceOutputs: [Fx4.hello(path: pathA)],
            cursors: cursors)

        try await coord.start()

        // The new incarnation's stream spawns (old one stopped + awaited first) and consults keyB's row (50).
        let spawnedTwice = await poll { await runner.streamCallCount == 2 }
        XCTAssertTrue(spawnedTwice, "the B incarnation spawned after A was stopped")
        let argvB = runner.streamArgv[1]
        XCTAssertTrue(argvB.contains("--since-seq"))
        XCTAssertEqual(argvB[argvB.firstIndex(of: "--since-seq")! + 1], "50", "new incarnation row consulted")

        // A's heartbeat checkpointed keyA(907); B's heartbeat checkpointed keyB(200) — no cross-incarnation write.
        let bCheckpointed = await poll { (try? cursors.load(incarnationKey: self.keyB)) == 200 }
        XCTAssertTrue(bCheckpointed)
        XCTAssertEqual(try cursors.load(incarnationKey: keyA), 907)
        XCTAssertEqual(cursors.checkpointCount - baseCheckpoints, 2, "one checkpoint per incarnation heartbeat")

        await coord.stop()
    }

    // MARK: - Detached once-hello ⇒ live-only, no cursor, checkpoint only after the attach

    func testDetachedOnceHelloIsLiveOnlyAndCheckpointsOnlyAfterAttach() async throws {
        let cursors = try newStore()
        let baseCheckpoints = cursors.checkpointCount // 0

        let (coord, runner) = try makeCoordinator(
            streams: [
                // Detached: a detached heartbeat must NOT checkpoint; then the ledger attaches (a real
                // incarnation transition) ⇒ stop + re-plan.
                .emitThenBlock(lines: [
                    Fx4.detachedHello(path: pathA),
                    Fx4.heartbeat(path: pathA, resumeHead: 907, attached: false),
                    Fx4.hello(path: pathA),
                ]),
                .emitThenBlock(lines: [
                    Fx4.hello(path: pathA),
                    Fx4.heartbeat(path: pathA, resumeHead: 300),
                ]),
            ],
            onceOutputs: [Fx4.detachedHello(path: pathA)],
            cursors: cursors)

        try await coord.start()

        // The detached live spawn carried NO --since-seq (live-only, no cursor read).
        let spawned = await poll { await runner.streamCallCount >= 1 }
        XCTAssertTrue(spawned)
        XCTAssertFalse(runner.streamArgv[0].contains("--since-seq"), "detached ⇒ live-only, no cursor")

        // Checkpointing begins only after the first attached hello ⇒ keyA reaches the attached heartbeat 300.
        let checkpointed = await poll { (try? cursors.load(incarnationKey: self.keyA)) == 300 }
        XCTAssertTrue(checkpointed)
        // The detached heartbeat (907, attached:false) never wrote a cursor.
        XCTAssertEqual(cursors.checkpointCount - baseCheckpoints, 1, "only the attached heartbeat checkpointed")

        await coord.stop()
    }

    // MARK: - Finding 4 — a stale old-generation heartbeat must NOT checkpoint the new incarnation

    func testStalePreTransitionHeartbeatDoesNotWriteNewIncarnation() async throws {
        let cursors = try newStore()

        let (coord, runner) = try makeCoordinator(
            streams: [
                // Incarnation A: healthy heartbeat (907), a transition hello to B, then a STALE A heartbeat
                // (999) queued BEHIND the transition hello on the shared, untagged stream.
                .emitThenBlock(lines: [
                    Fx4.hello(path: pathA),
                    Fx4.heartbeat(path: pathA, resumeHead: 907),
                    Fx4.hello(path: pathB),
                    Fx4.heartbeat(path: pathA, resumeHead: 999),
                ]),
                .emitThenBlock(lines: [
                    Fx4.hello(path: pathB),
                    Fx4.heartbeat(path: pathB, resumeHead: 200),
                ]),
            ],
            onceOutputs: [Fx4.hello(path: pathA)],
            cursors: cursors)

        try await coord.start()

        // B attaches and checkpoints 200.
        let bDone = await poll { (try? cursors.load(incarnationKey: self.keyB)) == 200 }
        XCTAssertTrue(bDone)
        // keyA stays at 907 — the stale post-transition A heartbeat (999) was dropped by the generation
        // guard, NOT written to keyB and NOT advanced on keyA either.
        XCTAssertEqual(try cursors.load(incarnationKey: keyA), 907, "the stale old-gen heartbeat never landed")
        XCTAssertEqual(try cursors.load(incarnationKey: keyB), 200, "no old-gen value bled into the new key")

        await coord.stop()
    }

    // MARK: - Finding 5 — a cursor-load failure is a typed terminal state, never a silent live-only attach

    func testCursorLoadFailureSurfacesTerminalStateAndStartThrows() async throws {
        let cursors = ToggleFailStore(failLoad: true)
        let (coord, runner) = try makeCoordinator(
            streams: [.emitThenBlock(lines: [Fx4.hello(path: pathA)])],
            // Two `--once` probes: the failed start consumes the first; the retry consumes the second.
            onceOutputs: [Fx4.hello(path: pathA), Fx4.hello(path: pathA)],
            cursors: cursors)

        do {
            try await coord.start()
            XCTFail("start() must throw on a cursor-load failure, not degrade to live-only")
        } catch {
            guard case AttachError.cursorLoadFailed = error else {
                return XCTFail("expected cursorLoadFailed, got \(error)")
            }
        }
        let state = await coord.state
        guard case .failed(let reason) = state else {
            return XCTFail("expected a terminal .failed state, got \(state)")
        }
        XCTAssertTrue(reason.contains("cursorLoadFailed"), "the terminal state names the load failure: \(reason)")
        XCTAssertEqual(runner.streamCallCount, 0, "no live spawn when the cursor could not be loaded")

        // Finding 6 — after the rollback, a retry with the store recovered SUCCEEDS (started was rolled back).
        cursors.failLoad = false
        try cursors.realStore.checkpoint(incarnationKey: keyA, seq: 42, updatedAt: "seed")
        try await coord.start()
        let spawned = await poll { await runner.streamCallCount == 1 }
        XCTAssertTrue(spawned, "the retry proceeded — start() did not silently no-op")
        let argv = runner.streamArgv[0]
        XCTAssertEqual(argv[argv.firstIndex(of: "--since-seq")! + 1], "42", "retry resumed from the recovered cursor")
        let live = await coord.state
        XCTAssertEqual(live, .live)

        await coord.stop()
    }

    // MARK: - Finding 1 — a stale old-generation heartbeat is discarded BEFORE forwarding to reducers

    /// Collects the forwarded (post-coordination) events so the test can prove an invalidated-generation
    /// heartbeat never reaches the reducers.
    private final class EventRecorder: @unchecked Sendable {
        private let lock = NSLock()
        private var _heads: [Int] = []
        private var _auditSeqs: [Int] = []
        func recordHeartbeat(_ head: Int) { lock.withLock { _heads.append(head) } }
        func recordAudit(_ seq: Int) { lock.withLock { _auditSeqs.append(seq) } }
        var heartbeatHeads: [Int] { lock.withLock { _heads } }
        var auditSeqs: [Int] { lock.withLock { _auditSeqs } }
    }

    /// B2 regression — the generation barrier must cover EVERY event type, not just heartbeats. A stale
    /// old-generation `audit` row buffered behind a transition hello on the shared, untagged supervisor
    /// stream must not enter the new generation's reducers.
    func testStalePreTransitionNonHeartbeatEventIsNotForwarded() async throws {
        let cursors = try newStore()

        let (coord, _) = try makeCoordinator(
            streams: [
                .emitThenBlock(lines: [
                    Fx4.hello(path: pathA),
                    Fx4.audit(seq: 11),                          // in-generation A audit row
                    Fx4.hello(path: pathB),                      // transition ⇒ generation flips to B
                    Fx4.audit(seq: 999),                         // STALE old-gen A audit row, buffered behind it
                ]),
                .emitThenBlock(lines: [
                    Fx4.hello(path: pathB),
                    Fx4.audit(seq: 22),
                    Fx4.heartbeat(path: pathB, resumeHead: 200),
                ]),
            ],
            onceOutputs: [Fx4.hello(path: pathA)],
            cursors: cursors)

        let rec = EventRecorder()
        let sink = Task {
            for await ev in coord.events {
                if case .audit(let a) = ev { rec.recordAudit(a.seq) }
            }
        }

        try await coord.start()
        let bDone = await poll { (try? cursors.load(incarnationKey: self.keyB)) == 200 }
        XCTAssertTrue(bDone)
        let settled = await poll { rec.auditSeqs.contains(22) }
        XCTAssertTrue(settled)
        XCTAssertTrue(rec.auditSeqs.contains(11), "the in-generation A audit row was forwarded")
        XCTAssertTrue(rec.auditSeqs.contains(22), "the new generation's audit row was forwarded")
        XCTAssertFalse(rec.auditSeqs.contains(999),
                       "a stale old-generation NON-heartbeat event must not reach the new generation")

        await coord.stop()
        sink.cancel()
    }

    func testStalePreTransitionHeartbeatIsNotForwardedToReducers() async throws {
        let cursors = try newStore()

        let (coord, _) = try makeCoordinator(
            streams: [
                .emitThenBlock(lines: [
                    Fx4.hello(path: pathA),
                    Fx4.heartbeat(path: pathA, resumeHead: 907),
                    Fx4.hello(path: pathB),                     // transition ⇒ generation flips to B
                    Fx4.heartbeat(path: pathA, resumeHead: 999), // STALE old-gen A heartbeat, buffered behind it
                ]),
                .emitThenBlock(lines: [
                    Fx4.hello(path: pathB),
                    Fx4.heartbeat(path: pathB, resumeHead: 200),
                ]),
            ],
            onceOutputs: [Fx4.hello(path: pathA)],
            cursors: cursors)

        // Consume the coordinator's forwarded stream (reducers' seat) and record heartbeat resume heads.
        let rec = EventRecorder()
        let sink = Task {
            for await ev in coord.events {
                if case .heartbeat(let hb) = ev, let r = hb.resume { rec.recordHeartbeat(r.auditHeadSeq) }
            }
        }

        try await coord.start()
        let bDone = await poll { (try? cursors.load(incarnationKey: self.keyB)) == 200 }
        XCTAssertTrue(bDone)
        // The generation guard drops the stale A(999) heartbeat before it is forwarded — reducers see the
        // in-generation 907 and 200 heads only, never the invalidated 999.
        let sawStale = await poll { rec.heartbeatHeads.contains(999) == false && rec.heartbeatHeads.contains(200) }
        XCTAssertTrue(sawStale)
        XCTAssertTrue(rec.heartbeatHeads.contains(907), "the healthy A heartbeat was forwarded")
        XCTAssertTrue(rec.heartbeatHeads.contains(200), "the B heartbeat was forwarded")
        XCTAssertFalse(rec.heartbeatHeads.contains(999), "the stale old-generation heartbeat was NOT forwarded")

        await coord.stop()
        sink.cancel()
    }

    // MARK: - Finding 6 — a supervisor's OWN retry re-hello (same incarnation) rebaselines in place

    func testSupervisorRetrySameIncarnationHelloRebaselinesInPlaceNoTeardown() async throws {
        let cursors = try newStore()
        try cursors.checkpoint(incarnationKey: keyA, seq: 100, updatedAt: "seed")
        let baseCheckpoints = cursors.checkpointCount

        // The FIRST live run faults (retryable) after its hello; the WatchSupervisor itself respawns and
        // the SECOND run re-hellos for the SAME incarnation (A) then sustains. The coordinator must treat
        // that supervisor-driven re-hello as an in-place rebaseline — NOT a coordinator transition (no
        // stop/replan, no second cursor read, no new incarnation row).
        let (coord, runner) = try makeCoordinator(
            streams: [
                .emitThenExit(lines: [Fx4.hello(path: pathA)],
                              envelope: Fx4.envelope(code: "e", retryable: true), exit: 4),
                .emitThenBlock(lines: [
                    Fx4.hello(path: pathA),
                    Fx4.heartbeat(path: pathA, resumeHead: 907),
                ]),
            ],
            onceOutputs: [Fx4.hello(path: pathA)],
            cursors: cursors)

        try await coord.start()

        // The supervisor respawned once (2 live spawns), and BOTH carry the SAME original resume plan
        // (--since-seq 100) — proving the coordinator did not re-plan for the re-hello.
        let respawned = await poll { await runner.streamCallCount == 2 }
        XCTAssertTrue(respawned, "the supervisor respawned on the retryable fault")
        for argv in runner.streamArgv {
            XCTAssertTrue(argv.contains("--since-seq"))
            XCTAssertEqual(argv[argv.firstIndex(of: "--since-seq")! + 1], "100",
                           "both spawns carry the original plan — no coordinator re-plan on the re-hello")
        }
        // The sustained run checkpoints A(907); still exactly one incarnation, no cross-key write.
        let checkpointed = await poll { (try? cursors.load(incarnationKey: self.keyA)) == 907 }
        XCTAssertTrue(checkpointed)
        XCTAssertEqual(cursors.checkpointCount - baseCheckpoints, 1, "one checkpoint, at the sustained heartbeat")
        let liveState = await coord.state
        XCTAssertEqual(liveState, .live, "the coordinator stayed live across the supervisor retry")

        await coord.stop()
    }

    // MARK: - Finding 2 — a replacement-generation cursor-load failure latches terminal; a later hello can't respawn

    func testReplacementGenerationFailureLatchesTerminalIgnoresBufferedHello() async throws {
        let cursors = ToggleFailStore()
        try cursors.realStore.checkpoint(incarnationKey: keyA, seq: 100, updatedAt: "seed")
        cursors.failLoadKey = keyB // the transition to B will fail its cursor load

        let (coord, runner) = try makeCoordinator(
            streams: [
                // A attaches, then a transition hello to B (its cursor load fails ⇒ terminal), then a
                // trailing hello — buffered behind the failed transition — which must NOT start a new watch.
                .emitThenBlock(lines: [
                    Fx4.hello(path: pathA),
                    Fx4.hello(path: pathB),
                    Fx4.hello(path: pathA),
                ]),
            ],
            onceOutputs: [Fx4.hello(path: pathA)],
            cursors: cursors)

        try await coord.start()

        // The replacement generation's cursor load failed ⇒ the coordinator latches .failed.
        let failed = await poll {
            if case .failed = await coord.state { return true }; return false
        }
        XCTAssertTrue(failed, "a replacement-generation cursor-load failure is terminal")

        // Give the (cancelled) consumer a beat: the trailing buffered hello(A) must NOT spawn another watch.
        try? await Task.sleep(for: .milliseconds(300))
        XCTAssertEqual(runner.streamCallCount, 1, "no new generation spawned after the terminal latch")

        // And a later start() is refused — never a silent no-op into a fake-live state.
        do {
            try await coord.start()
            XCTFail("start() after a terminal latch must throw")
        } catch {
            guard case AttachError.terminated = error else { return XCTFail("expected .terminated, got \(error)") }
        }
        XCTAssertEqual(runner.streamCallCount, 1, "still no respawn after a refused start()")

        await coord.stop()
    }

    // MARK: - Revision finding — stop() ABORTS a withheld-ack checkpoint (never advances past unconsumed state)

    /// With consumer acks enabled but the consumer NEVER acknowledging the heartbeat, the checkpoint
    /// barrier stays suspended. `stop()` must ABORT that barrier — resuming it as "aborted" so the
    /// checkpoint is skipped — rather than satisfying it and advancing the cursor past state the reducers
    /// never consumed. Proven: after start (heartbeat pending, ack withheld) then stop, the seeded cursor
    /// is unchanged and no checkpoint occurred.
    func testStopWithWithheldHeartbeatAckDoesNotCheckpoint() async throws {
        let cursors = try newStore()
        try cursors.checkpoint(incarnationKey: keyA, seq: 100, updatedAt: "seed")
        let base = cursors.checkpointCount

        let (coord, _) = try makeCoordinator(
            streams: [.emitThenBlock(lines: [
                Fx4.hello(path: pathA),
                Fx4.heartbeat(path: pathA, resumeHead: 907),
            ])],
            onceOutputs: [Fx4.hello(path: pathA)],
            cursors: cursors)

        // Enable the barrier but DELIBERATELY never drain `coord.events` / call `consumed()` — the
        // heartbeat's checkpoint suspends on the ack that never comes.
        await coord.enableConsumerAcks()
        try await coord.start()

        // Let the stream reach the heartbeat's suspended `awaitConsumedAll()`.
        try? await Task.sleep(for: .milliseconds(400))
        XCTAssertEqual(cursors.checkpointCount - base, 0, "no checkpoint while the ack is withheld")

        await coord.stop()
        // stop() must NOT satisfy the barrier as if consumed — the checkpoint is abandoned.
        try? await Task.sleep(for: .milliseconds(200))
        XCTAssertEqual(cursors.checkpointCount - base, 0,
                       "stop aborts the checkpoint — the cursor never advances past unconsumed state")
        XCTAssertEqual(try cursors.load(incarnationKey: keyA), 100, "cursor stayed at the seeded value")
    }

    // MARK: - Finding 5 — a checkpoint failure surfaces .degraded, not a silent swallow

    func testCheckpointFailureSurfacesDegraded() async throws {
        let cursors = ToggleFailStore(failCheckpoint: true)
        let (coord, _) = try makeCoordinator(
            streams: [.emitThenBlock(lines: [
                Fx4.hello(path: pathA),
                Fx4.heartbeat(path: pathA, resumeHead: 907),
            ])],
            onceOutputs: [Fx4.hello(path: pathA)],
            cursors: cursors)

        try await coord.start()
        let degraded = await poll {
            if case .degraded = await coord.state { return true }; return false
        }
        XCTAssertTrue(degraded, "a checkpoint failure surfaced as .degraded, never swallowed")

        await coord.stop()
    }
}

// MARK: - Injectable failing cursor store

/// A `CursorStoring` that delegates to a real `CursorStore` but can be told to fail `load`/`checkpoint`,
/// so the coordinator's storage-failure handling is exercised deterministically.
final class ToggleFailStore: CursorStoring, @unchecked Sendable {
    let realStore: CursorStore
    private let lock = NSLock()
    private var _failLoad: Bool
    private var _failCheckpoint: Bool
    private var _failLoadKey: String?

    var failLoad: Bool {
        get { lock.withLock { _failLoad } }
        set { lock.withLock { _failLoad = newValue } }
    }
    var failCheckpoint: Bool {
        get { lock.withLock { _failCheckpoint } }
        set { lock.withLock { _failCheckpoint = newValue } }
    }
    /// When set, ONLY this incarnation key's `load` throws — every other key loads normally (so the initial
    /// attach can succeed while a later transition's cursor load fails).
    var failLoadKey: String? {
        get { lock.withLock { _failLoadKey } }
        set { lock.withLock { _failLoadKey = newValue } }
    }

    init(failLoad: Bool = false, failCheckpoint: Bool = false, failLoadKey: String? = nil) {
        self.realStore = try! CursorStore(path: TestSupport.tempDir().appendingPathComponent("console.sqlite"))
        self._failLoad = failLoad
        self._failCheckpoint = failCheckpoint
        self._failLoadKey = failLoadKey
    }

    func load(incarnationKey: String) throws -> Int {
        if failLoad || failLoadKey == incarnationKey { throw CursorStoreError.stepFailed(message: "injected") }
        return try realStore.load(incarnationKey: incarnationKey)
    }

    func checkpoint(incarnationKey: String, seq: Int, updatedAt: String) throws {
        if failCheckpoint { throw CursorStoreError.stepFailed(message: "injected") }
        try realStore.checkpoint(incarnationKey: incarnationKey, seq: seq, updatedAt: updatedAt)
    }
}

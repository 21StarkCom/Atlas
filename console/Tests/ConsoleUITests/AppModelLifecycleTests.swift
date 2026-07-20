import XCTest
import ConsoleCore
@testable import ConsoleUI

// P6-Task-4 — AppModel launch (wire-then-start), probe/setup/blocked phases, and the settings cutover.

@MainActor
private func poll(_ timeout: Double = 20, _ cond: () -> Bool) async -> Bool {
    let deadline = Date().addingTimeInterval(timeout)
    while Date() < deadline {
        if cond() { return true }
        try? await Task.sleep(for: .milliseconds(25))
    }
    return cond()
}

/// A `SettingsStore` over a unique in-memory-ish suite; optionally pre-seeded with a blob.
@MainActor
private func makeStore(_ seed: Settings? = nil) -> SettingsStore {
    let suite = UserDefaults(suiteName: "uitest-\(UUID().uuidString)")!
    let store = SettingsStore(defaults: suite)
    if let seed { store.save(seed) }
    return store
}

@MainActor
final class AppLaunchProbeTests: XCTestCase {

    func testFreshInstallNoConfigLandsInSetupNeeded() async throws {
        let model = AppModel(settingsStore: makeStore(nil), environment: [:],
                             sessionFactory: { _, _ in XCTFail("factory must not run without config"); throw CancellationError() })
        await model.launch()
        XCTAssertEqual(model.phase, .setupNeeded)
    }

    func testFailingProbeLandsInBlockedNamingPathAndRemediation() async throws {
        let model = AppModel(
            settingsStore: makeStore(Settings(atlasRoot: "/atlas")),
            environment: [:],
            sessionFactory: { _, _ in
                throw BlockingResolutionError(path: "/atlas/apps/cli/dist/bin.js", remediation: "run pnpm -r build")
            })
        await model.launch()
        guard case .blocked(_, let path, let remediation) = model.phase else {
            return XCTFail("expected .blocked, got \(model.phase)")
        }
        XCTAssertEqual(path, "/atlas/apps/cli/dist/bin.js")
        XCTAssertEqual(remediation, "run pnpm -r build")
    }

    func testPassingProbeReachesRunningWithWatchSpawnObserved() async throws {
        let dir = UITestSupport.tempDir()
        let runner = UIScriptedRunner(
            dir: dir,
            streams: [.emitThenBlock(lines: [UIFx.hello(path: "/v/.atlas/atlas.db"),
                                             UIFx.heartbeat(path: "/v/.atlas/atlas.db", resumeHead: 900)])],
            onceHellos: [UIFx.hello(path: "/v/.atlas/atlas.db")])
        let model = AppModel(
            settingsStore: makeStore(Settings(atlasRoot: "/atlas")),
            environment: [:],
            sessionFactory: { settings, _ in try UITestSupport.session(runner: runner, settings: settings) })
        await model.launch()
        XCTAssertEqual(model.phase, .running)
        let spawned = await poll { runner.streamCallCount >= 1 }
        XCTAssertTrue(spawned, "the watch stream spawned after launch")
    }

    func testRepeatedAndConcurrentLaunchProducesExactlyOneWatcher() async throws {
        // launch() is single-flight + idempotent, so a repeated/concurrent invocation (e.g. a re-run
        // `.task`) can never build a second overlapping session/watcher and clobber the retained handles.
        let dir = UITestSupport.tempDir()
        let runner = UIScriptedRunner(
            dir: dir,
            streams: [.emitThenBlock(lines: [UIFx.hello(path: "/v/.atlas/atlas.db")])],
            onceHellos: [UIFx.hello(path: "/v/.atlas/atlas.db")])
        let model = AppModel(
            settingsStore: makeStore(Settings(atlasRoot: "/atlas")),
            environment: [:],
            sessionFactory: { settings, _ in try UITestSupport.session(runner: runner, settings: settings) })

        // Two concurrent launches + a later repeat.
        async let a: Void = model.launch()
        async let b: Void = model.launch()
        _ = await (a, b)
        await model.launch()

        XCTAssertEqual(model.phase, .running)
        let one = await poll { runner.streamCallCount == 1 }
        XCTAssertTrue(one, "exactly one watcher despite repeated/concurrent launch (got \(runner.streamCallCount))")
    }
}

@MainActor
final class WiringOrderTests: XCTestCase {

    func testFastEmitterEventsAllReachReducers() async throws {
        // A fast child that emits hello → audit → heartbeat immediately on spawn. Because the reducer
        // consumer is wired BEFORE the coordinator starts, none of these events is lost.
        let dir = UITestSupport.tempDir()
        let path = "/v/.atlas/atlas.db"
        let runner = UIScriptedRunner(
            dir: dir,
            streams: [.emitThenBlock(lines: [
                UIFx.hello(path: path),
                UIFx.audit(seq: 5),
                UIFx.heartbeat(path: path, resumeHead: 900),
            ])],
            onceHellos: [UIFx.hello(path: path)])
        let model = AppModel(
            settingsStore: makeStore(Settings(atlasRoot: "/atlas")),
            environment: [:],
            sessionFactory: { settings, _ in try UITestSupport.session(runner: runner, settings: settings) })
        await model.launch()
        XCTAssertEqual(model.phase, .running)

        // Every emitted event reached the reducers: the audit row landed in the timeline, and the hello
        // rebaselined the dashboard (snapshotAsOf set) — none outran the consumer.
        let sawAudit = await poll { model.auditTimeline.contains { $0.seq == 5 } }
        XCTAssertTrue(sawAudit, "the replay audit row reached the audit reducer")
        XCTAssertFalse(model.dashboard.snapshotAsOf.isEmpty, "the hello reached the dashboard reducer")
        XCTAssertEqual(runner.streamCallCount, 1, "exactly one live spawn (startup hello rebaselines in place)")
    }
}

@MainActor
final class SettingsCutoverTests: XCTestCase {

    /// A factory whose behaviour is keyed off `candidate.atlasRoot`, counting invocations:
    ///   "fail-probe" ⇒ throw (probe failure); "fail-start" ⇒ a session whose once-hello is garbage
    ///   (coordinator.start throws); anything else ⇒ a good session (hello + block).
    private final class FactoryBox: @unchecked Sendable {
        let lock = NSLock()
        private(set) var callCount = 0
        let dir = UITestSupport.tempDir()
        func make(_ settings: Settings, _ env: [String: String]) throws -> LiveSession {
            lock.withLock { callCount += 1 }
            let path = "/v/.atlas/atlas.db"
            switch settings.atlasRoot {
            case "fail-probe":
                throw BlockingResolutionError(path: "probe", remediation: "nope")
            case "fail-start":
                let r = UIScriptedRunner(dir: dir, streams: [], onceHellos: [Data("not-a-hello".utf8)])
                return try UITestSupport.session(runner: r, settings: settings)
            default:
                let r = UIScriptedRunner(dir: dir,
                    streams: [.emitThenBlock(lines: [UIFx.hello(path: path)])],
                    onceHellos: [UIFx.hello(path: path)])
                return try UITestSupport.session(runner: r, settings: settings)
            }
        }
    }

    private func launchedModel(_ box: FactoryBox, store: SettingsStore) async -> AppModel {
        let model = AppModel(settingsStore: store, environment: [:],
                             sessionFactory: { s, e in try box.make(s, e) })
        await model.launch()
        return model
    }

    func testCandidateProbeFailureSavesNothingAndKeepsPriorSettings() async throws {
        let box = FactoryBox()
        let store = makeStore(Settings(atlasRoot: "ok"))
        let model = await launchedModel(box, store: store)
        XCTAssertEqual(model.phase, .running)
        let before = box.lock.withLock { box.callCount }

        await model.applySettings(Settings(atlasRoot: "fail-probe"))
        XCTAssertNotNil(model.settingsError)
        XCTAssertEqual(store.load().settings.atlasRoot, "ok", "prior settings retained; candidate not saved")
        XCTAssertEqual(box.lock.withLock { box.callCount }, before + 1, "exactly one probe attempt for the candidate")
    }

    func testReplacementStartFailureRestoresPriorAndRetainsSettings() async throws {
        let box = FactoryBox()
        let store = makeStore(Settings(atlasRoot: "ok"))
        let model = await launchedModel(box, store: store)

        await model.applySettings(Settings(atlasRoot: "fail-start"))
        XCTAssertNotNil(model.settingsError)
        XCTAssertEqual(store.load().settings.atlasRoot, "ok", "prior settings retained after a replacement-start failure")
    }

    func testSuccessfulCutoverCommitsCandidateAfterReplacementSpawn() async throws {
        let box = FactoryBox()
        let store = makeStore(Settings(atlasRoot: "ok"))
        let model = await launchedModel(box, store: store)

        await model.applySettings(Settings(atlasRoot: "ok2"))
        XCTAssertNil(model.settingsError)
        XCTAssertEqual(store.load().settings.atlasRoot, "ok2", "candidate committed after the replacement's first spawn")
    }

    func testUnchangedSaveDoesNotReProbe() async throws {
        let box = FactoryBox()
        let store = makeStore(Settings(atlasRoot: "ok"))
        let model = await launchedModel(box, store: store)
        let before = box.lock.withLock { box.callCount }

        await model.applySettings(Settings(atlasRoot: "ok"))  // identical to the current settings
        XCTAssertEqual(box.lock.withLock { box.callCount }, before, "an unchanged save does not re-probe")
        XCTAssertNil(model.settingsError)
    }
}

// MARK: - Cutover atomicity, phase transitions, watcher readiness

/// A factory driven by per-call-ordinal behaviour, so a test can script exactly what launch, the
/// candidate cutover, and the restoration each do.
private final class ScriptedFactory: @unchecked Sendable {
    enum Behavior { case good, buildThrow, startFail, streamFail }
    let lock = NSLock()
    private(set) var calls = 0
    let dir = UITestSupport.tempDir()
    var behaviors: [Int: Behavior] = [:]
    var defaultBehavior: Behavior = .good
    private(set) var runners: [UIScriptedRunner] = []

    private static let path = "/v/.atlas/atlas.db"

    func make(_ s: Settings, _ e: [String: String]) throws -> LiveSession {
        let n = lock.withLock { calls += 1; return calls }
        let behavior = lock.withLock { behaviors[n] ?? defaultBehavior }
        switch behavior {
        case .buildThrow:
            throw BlockingResolutionError(path: "probe-\(n)", remediation: "scripted build failure")
        case .startFail:
            // Builds fine (probe passes) but the once-hello is garbage ⇒ coordinator.start throws.
            let r = UIScriptedRunner(dir: dir, streams: [], onceHellos: [Data("not-a-hello".utf8)])
            lock.withLock { runners.append(r) }
            return try UITestSupport.session(runner: r, settings: s)
        case .streamFail:
            // The once-hello is GOOD (start passes the probe) but the stream never spawns (stream throws),
            // so the watcher-readiness gate fails ⇒ start throws watcherDidNotLaunch.
            let r = UIScriptedRunner(dir: dir, streams: [], onceHellos: [UIFx.hello(path: Self.path)])
            lock.withLock { runners.append(r) }
            return try UITestSupport.session(runner: r, settings: s)
        case .good:
            let r = UIScriptedRunner(dir: dir,
                streams: [.emitThenBlock(lines: [UIFx.hello(path: Self.path)])],
                onceHellos: [UIFx.hello(path: Self.path)])
            lock.withLock { runners.append(r) }
            return try UITestSupport.session(runner: r, settings: s)
        }
    }
}

@MainActor
final class SettingsCutoverAtomicityTests: XCTestCase {
    private func poll(_ timeout: Double = 20, _ cond: () -> Bool) async -> Bool {
        let deadline = Date().addingTimeInterval(timeout)
        while Date() < deadline { if cond() { return true }; try? await Task.sleep(for: .milliseconds(25)) }
        return cond()
    }

    private func model(_ factory: ScriptedFactory, store: SettingsStore) -> AppModel {
        AppModel(settingsStore: store, environment: [:], sessionFactory: { s, e in try factory.make(s, e) })
    }

    func testRestorationFactoryFailureClearsSessionAndBlocks() async throws {
        let f = ScriptedFactory()
        f.behaviors = [1: .good, 2: .startFail, 3: .buildThrow]  // launch ok; candidate start fails; restore build throws
        let store = makeStore(Settings(atlasRoot: "ok"))
        let m = model(f, store: store)
        await m.launch()
        XCTAssertEqual(m.phase, .running)

        await m.applySettings(Settings(atlasRoot: "changed"))
        XCTAssertNotNil(m.settingsError)
        guard case .blocked = m.phase else { return XCTFail("expected .blocked, got \(m.phase)") }
        XCTAssertEqual(store.load().settings.atlasRoot, "ok", "prior settings retained")
    }

    func testRestorationStartFailureClearsSessionAndBlocks() async throws {
        let f = ScriptedFactory()
        f.behaviors = [1: .good, 2: .startFail, 3: .startFail]  // restore builds but also fails to start
        let store = makeStore(Settings(atlasRoot: "ok"))
        let m = model(f, store: store)
        await m.launch()
        XCTAssertEqual(m.phase, .running)

        await m.applySettings(Settings(atlasRoot: "changed"))
        XCTAssertNotNil(m.settingsError)
        guard case .blocked = m.phase else { return XCTFail("expected .blocked, got \(m.phase)") }
        XCTAssertEqual(store.load().settings.atlasRoot, "ok", "prior settings retained")
    }

    func testRestoredWatcherIsLiveAfterCandidateStartFailure() async throws {
        let f = ScriptedFactory()
        f.behaviors = [1: .good, 2: .startFail, 3: .good]  // restore succeeds
        let store = makeStore(Settings(atlasRoot: "ok"))
        let m = model(f, store: store)
        await m.launch()

        await m.applySettings(Settings(atlasRoot: "changed"))
        XCTAssertEqual(m.phase, .running, "the restored prior configuration is live again")
        XCTAssertEqual(store.load().settings.atlasRoot, "ok", "prior settings retained")
        // The restored runner (call 3) actually spawned a watcher.
        let restored = f.lock.withLock { f.runners.last! }
        let spawned = await poll { restored.streamCallCount >= 1 }
        XCTAssertTrue(spawned, "the restored watcher is live")
    }

    func testStreamLaunchFailureDoesNotCommitConfiguration() async throws {
        // The candidate probes AND its once-hello passes, but its watcher never spawns. The readiness gate
        // must fail the start so the unproven configuration is NOT persisted.
        let f = ScriptedFactory()
        f.behaviors = [1: .good, 2: .streamFail, 3: .good]  // candidate stream never launches; restore ok
        let store = makeStore(Settings(atlasRoot: "ok"))
        let m = model(f, store: store)
        await m.launch()

        await m.applySettings(Settings(atlasRoot: "changed"))
        XCTAssertNotNil(m.settingsError, "a stream-launch failure surfaces an error")
        XCTAssertEqual(store.load().settings.atlasRoot, "ok", "an unproven configuration is never committed")
    }

    func testExactlyOneWatcherAfterSuccessfulCutover() async throws {
        let f = ScriptedFactory()
        let store = makeStore(Settings(atlasRoot: "ok"))
        let m = model(f, store: store)
        await m.launch()

        await m.applySettings(Settings(atlasRoot: "ok2"))
        XCTAssertEqual(m.phase, .running)
        XCTAssertEqual(store.load().settings.atlasRoot, "ok2", "committed after the verified spawn")
        let replacement = f.lock.withLock { f.runners.last! }
        let one = await poll { replacement.streamCallCount == 1 }
        XCTAssertTrue(one, "exactly one watcher spawned for the replacement (got \(replacement.streamCallCount))")
    }

    func testSetupNeededToRunningWithoutRelaunch() async throws {
        let f = ScriptedFactory()   // default .good
        let store = makeStore(nil)  // no config ⇒ setupNeeded
        let m = AppModel(settingsStore: store, environment: [:], sessionFactory: { s, e in try f.make(s, e) })
        await m.launch()
        XCTAssertEqual(m.phase, .setupNeeded)

        await m.applySettings(Settings(atlasRoot: "now-configured"))
        XCTAssertEqual(m.phase, .running, "a valid settings apply from .setupNeeded reaches running")
        XCTAssertEqual(store.load().settings.atlasRoot, "now-configured")
    }

    func testBlockedToRunningWithoutRelaunch() async throws {
        let f = ScriptedFactory()
        f.behaviors = [1: .buildThrow]  // launch blocked; subsequent applies are .good
        let store = makeStore(Settings(atlasRoot: "bad"))
        let m = model(f, store: store)
        await m.launch()
        guard case .blocked = m.phase else { return XCTFail("expected .blocked, got \(m.phase)") }

        await m.applySettings(Settings(atlasRoot: "fixed"))
        XCTAssertEqual(m.phase, .running, "a valid settings apply from .blocked reaches running")
        XCTAssertEqual(store.load().settings.atlasRoot, "fixed")
    }

    func testSettingsSnapshotExposesNonDefaultPersistedValues() async throws {
        let f = ScriptedFactory()
        let seeded = Settings(atlasRoot: "ok", pollMs: 750, heartbeatSeconds: 9)
        let store = makeStore(seeded)
        let m = model(f, store: store)
        await m.launch()
        // The Settings surface starts from THESE values, never `.defaults` (which would erase overrides).
        XCTAssertEqual(m.currentSettingsSnapshot, seeded)
        XCTAssertNotEqual(m.currentSettingsSnapshot, .defaults)
    }
}

// MARK: - No checkpoint before consumption

/// A `CursorStoring` spy that snapshots an external recorder at the instant `checkpoint` is called.
private final class CheckpointSpyStore: CursorStoring, @unchecked Sendable {
    let lock = NSLock()
    private(set) var auditsAtFirstCheckpoint: [Int]?
    private let recorder: AuditRecorder
    init(_ recorder: AuditRecorder) { self.recorder = recorder }
    func load(incarnationKey: String) throws -> Int { -1 }
    func checkpoint(incarnationKey: String, seq: Int, updatedAt: String) throws {
        lock.withLock {
            if auditsAtFirstCheckpoint == nil { auditsAtFirstCheckpoint = recorder.snapshot() }
        }
    }
}

private final class AuditRecorder: @unchecked Sendable {
    private let lock = NSLock()
    private var seqs: [Int] = []
    func record(_ seq: Int) { lock.withLock { seqs.append(seq) } }
    func snapshot() -> [Int] { lock.withLock { seqs } }
}

@MainActor
final class CheckpointConsumptionOrderTests: XCTestCase {
    private func poll(_ timeout: Double = 20, _ cond: () -> Bool) async -> Bool {
        let deadline = Date().addingTimeInterval(timeout)
        while Date() < deadline { if cond() { return true }; try? await Task.sleep(for: .milliseconds(25)) }
        return cond()
    }

    func testCursorDoesNotCheckpointBeforeReducersConsumePrecedingEvents() async throws {
        let dir = UITestSupport.tempDir()
        let path = "/v/.atlas/atlas.db"
        let recorder = AuditRecorder()
        let spy = CheckpointSpyStore(recorder)
        // hello → audit(seq 5) → heartbeat(resume 900): the heartbeat checkpoints, but ONLY after the
        // audit row is consumed.
        let runner = UIScriptedRunner(dir: dir,
            streams: [.emitThenBlock(lines: [
                UIFx.hello(path: path),
                UIFx.audit(seq: 5),
                UIFx.heartbeat(path: path, resumeHead: 900),
            ])],
            onceHellos: [UIFx.hello(path: path)])
        let model = AppModel(
            settingsStore: SettingsStore(defaults: UserDefaults(suiteName: "ck-\(UUID())")!),
            environment: [ResolutionEnv.atlasRoot: "/atlas"],
            sessionFactory: { s, _ in
                try UITestSupport.session(runner: runner, settings: s, cursors: spy)
            })
        model.onAuditConsumed = { seq in recorder.record(seq) }
        await model.launch()
        XCTAssertEqual(model.phase, .running)

        let checkpointed = await poll { spy.lock.withLock { spy.auditsAtFirstCheckpoint != nil } }
        XCTAssertTrue(checkpointed, "a checkpoint occurred")
        let atCheckpoint = spy.lock.withLock { spy.auditsAtFirstCheckpoint ?? [] }
        XCTAssertTrue(atCheckpoint.contains(5),
                      "the preceding audit row was consumed BEFORE the cursor checkpointed (saw \(atCheckpoint))")
    }
}

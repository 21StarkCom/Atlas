import XCTest
import ConsoleCore
@testable import ConsoleUI

// P6-Task-4 — the Actions/Query entry points (intent criterion 3) + actor-state stream mirroring.

/// A capturing announcer so the A11y vocabulary a transition fires is observable without an app host.
final class AnnounceBox: @unchecked Sendable {
    private let lock = NSLock()
    private var _events: [A11yEvent] = []
    func add(_ e: A11yEvent) { lock.withLock { _events.append(e) } }
    var events: [A11yEvent] { lock.withLock { _events } }
    var announcer: A11yAnnouncer { A11yAnnouncer(post: { [weak self] in self?.add($0) }) }
}

/// A valid `git approve` integrate challenge bound to a fixed runId (passes the signer-contract validator
/// and the flow's consistency gate).
enum UIChallenge {
    static let runId = "01ARZ3NDEKTSV4RRFFQ69G5FAV"
    static func gitApprove() -> Data {
        try! JSONSerialization.data(withJSONObject: [
            "schemaVersion": 1,
            "op": "git approve",
            "runId": runId,
            "canonicalBaseCommit": String(repeating: "b", count: 40),
            "targetCommit": String(repeating: "a", count: 40),
            "intendedEffect": ["kind": "integrate", "tier": 1,
                               "changePlanDigest": "sha256:\(String(repeating: "c", count: 8))"],
            "nonce": String(repeating: "0", count: 32),
            "expiresAt": "2026-07-20T10:00:00.000Z",
            "payloadCanonicalization": "atlas-jcs-v1",
            "signingPayload": "payload-abc",
        ])
    }
}

@MainActor
final class ActionSurfaceTests: XCTestCase {

    private func poll(_ timeout: Double = 20, _ cond: () -> Bool) async -> Bool {
        let deadline = Date().addingTimeInterval(timeout)
        while Date() < deadline { if cond() { return true }; try? await Task.sleep(for: .milliseconds(25)) }
        return cond()
    }

    func testActionDrivesPrivilegedFlowToDisplay() async throws {
        let dir = UITestSupport.tempDir()
        let path = "/v/.atlas/atlas.db"
        let runner = UIScriptedRunner(
            dir: dir,
            streams: [.emitThenBlock(lines: [UIFx.hello(path: path)])],
            onceHellos: [UIFx.hello(path: path)],
            exportResults: [SpawnResult(exitCode: 6, stdout: UIChallenge.gitApprove(), stderr: Data())])
        let box = AnnounceBox()
        let model = AppModel(
            settingsStore: SettingsStore(defaults: UserDefaults(suiteName: "as-\(UUID())")!),
            environment: [ResolutionEnv.atlasRoot: "/atlas"],
            announcer: box.announcer,
            sessionFactory: { s, _ in try UITestSupport.session(runner: runner, settings: s) })
        // The env var makes launch resolvable; atlasRoot is unset in Settings.
        await model.launch()
        XCTAssertEqual(model.phase, .running)
        XCTAssertTrue(model.authorizableOps.contains("git approve"), "the Actions surface enumerates authorizableOps")

        await model.beginAction(op: "git approve", focus: FocusContext(fields: ["runId": UIChallenge.runId]), entry: [:])
        let reachedDisplay = await poll {
            if case .display = model.flowState { return true }; return false
        }
        XCTAssertTrue(reachedDisplay, "the UI-initiated op drove the flow to Display through the real spawn boundary")
        XCTAssertNotNil(model.currentChallenge)
        XCTAssertEqual(model.currentChallenge?.op, "git approve")
    }

    /// Build a valid `values` dict for a descriptor: fill every required field + exactly one member of
    /// each `oneOf` group, choosing a truthy string for boolean switches.
    private func valuesFor(_ descriptor: OperationDescriptor) -> [String: String] {
        var values: [String: String] = [:]
        var filledGroups: Set<String> = []
        for operand in descriptor.operands {
            let truthy: String = { if case .boolean = operand.kind { return "true" }; return "val-\(operand.name)" }()
            switch operand.requirement {
            case .required:
                if case .constant = operand.source { continue }  // router-pinned; no UI value
                values[operand.name] = truthy
            case .optional:
                break
            case .oneOf(let group):
                if !filledGroups.contains(group) { values[operand.name] = truthy; filledGroups.insert(group) }
            }
        }
        return values
    }

    func testEveryProductionAuthorizableOpBindsThroughTheUIPath() async throws {
        // The Actions surface builds its operand form from each op's descriptor and pre-fills focused
        // operands from the selection. Every production authorizable op — including the six that need
        // focused-object operands (git approve/rollback, quarantine inspect/resolve, source trust
        // promote/revoke) — must be STARTABLE through that descriptor-driven path, not blocked by an empty
        // FocusContext.
        let dir = UITestSupport.tempDir()
        let path = "/v/.atlas/atlas.db"
        let runner = UIScriptedRunner(dir: dir,
            streams: [.emitThenBlock(lines: [UIFx.hello(path: path)])],
            onceHellos: [UIFx.hello(path: path)])
        let model = AppModel(
            settingsStore: SettingsStore(defaults: UserDefaults(suiteName: "ops-\(UUID())")!),
            environment: [ResolutionEnv.atlasRoot: "/atlas"],
            sessionFactory: { s, _ in try UITestSupport.session(runner: runner, settings: s) })
        await model.launch()
        XCTAssertEqual(model.phase, .running)

        let ops = model.authorizableOps.sorted()
        XCTAssertTrue(ops.count >= 8, "the production authorizable set is discovered (got \(ops))")
        for op in ops {
            guard let descriptor = model.operationDescriptor(for: op) else {
                XCTFail("no descriptor for production authorizable op \(op)"); continue
            }
            let form = ActionOperandForm(descriptor: descriptor)
            let (focus, entry) = form.inputs(values: valuesFor(descriptor))
            // The router (the same one the flow uses) must bind the UI-assembled operands with no error.
            let router = try XCTUnwrap(model.activeRouter)
            XCTAssertNoThrow(try router.bind(op, focus: focus, entry: entry), "UI path could not start \(op)")
        }
    }

    func testChallengeExpiryAndBusyCompletedAnnouncementsFireThroughRealPaths() async throws {
        let dir = UITestSupport.tempDir()
        let path = "/v/.atlas/atlas.db"
        // A VALID empty `jobs list` page: the generic empty-stdout default fails the read gateway's schema
        // validation, so the refresh below would actually FAIL — and previously still announced
        // "completed" from a `defer`, letting this test pass on a false success.
        let jobsPage = Data(#"{"command":"jobs list","jobs":[],"pagination":{"limit":500,"offset":0,"total":0,"hasMore":false}}"#.utf8)
        let runner = UIScriptedRunner(dir: dir,
            streams: [.emitThenBlock(lines: [UIFx.hello(path: path)])],
            onceHellos: [UIFx.hello(path: path)],
            genericResult: SpawnResult(exitCode: 0, stdout: jobsPage, stderr: Data()))
        let box = AnnounceBox()
        let model = AppModel(
            settingsStore: SettingsStore(defaults: UserDefaults(suiteName: "ann-\(UUID())")!),
            environment: [ResolutionEnv.atlasRoot: "/atlas"],
            announcer: box.announcer,
            sessionFactory: { s, _ in try UITestSupport.session(runner: runner, settings: s) })
        await model.launch()

        // A refresh read announces busy + completed (never a silent spinner).
        await model.refreshJobs()
        XCTAssertTrue(box.events.contains(.busy("Jobs refresh")))
        XCTAssertTrue(box.events.contains(.completed("Jobs refresh")))
        XCTAssertNil(model.jobsError, "a successful refresh leaves no error")
        XCTAssertFalse(box.events.contains(.failed("Jobs refresh")), "success must not announce failure")

        // B5 regression — a FAILING refresh must announce `.failed` (not `.completed`) and surface a
        // visible error, rather than reporting success from a `defer`.
        let failingDir = UITestSupport.tempDir()
        let failingRunner = UIScriptedRunner(dir: failingDir,
            streams: [.emitThenBlock(lines: [UIFx.hello(path: path)])],
            onceHellos: [UIFx.hello(path: path)],
            genericResult: SpawnResult(exitCode: 0, stdout: Data(), stderr: Data())) // invalid jobs output
        let failBox = AnnounceBox()
        let failModel = AppModel(
            settingsStore: SettingsStore(defaults: UserDefaults(suiteName: "ann-fail-\(UUID())")!),
            environment: [ResolutionEnv.atlasRoot: "/atlas"],
            announcer: failBox.announcer,
            sessionFactory: { s, _ in try UITestSupport.session(runner: failingRunner, settings: s) })
        await failModel.launch()
        await failModel.refreshJobs()
        XCTAssertTrue(failBox.events.contains(.busy("Jobs refresh")))
        XCTAssertTrue(failBox.events.contains(.failed("Jobs refresh")), "a failed read announces failure")
        XCTAssertFalse(failBox.events.contains(.completed("Jobs refresh")),
                       "a failed read must NOT announce completion")
        XCTAssertNotNil(failModel.jobsError, "the failure is surfaced visibly, not swallowed")

        // A re-export from a post-Display state announces the expiry. Drive the flow state directly.
        model.ingestFlowState(.display(try JSONDecoder().decode(AuthorizationChallenge.self, from: UIChallenge.gitApprove())))
        model.ingestFlowState(.export(op: "git approve"))
        XCTAssertTrue(box.events.contains(.challengeExpired), "a re-export after Display announces expiry")
        // A .done transition announces completion.
        model.ingestFlowState(.done)
        XCTAssertTrue(box.events.contains(.completed("Authorization")))
    }

    func testAuditSelectionPreFillsFocusedOperandOnActionsForm() async throws {
        // Selecting an audit row records its runId as the focus; the Actions form for a run-scoped op
        // (`git approve`) then pre-fills the focused `runId` operand from that selection — the concrete
        // selection → ActionOperandForm propagation the audit surface's onSelect wires.
        let dir = UITestSupport.tempDir()
        let path = "/v/.atlas/atlas.db"
        let runner = UIScriptedRunner(dir: dir,
            streams: [.emitThenBlock(lines: [UIFx.hello(path: path)])],
            onceHellos: [UIFx.hello(path: path)])
        let model = AppModel(
            settingsStore: SettingsStore(defaults: UserDefaults(suiteName: "sel-\(UUID())")!),
            environment: [ResolutionEnv.atlasRoot: "/atlas"],
            sessionFactory: { s, _ in try UITestSupport.session(runner: runner, settings: s) })
        await model.launch()
        XCTAssertEqual(model.phase, .running)

        let auditJSON = try JSONSerialization.data(withJSONObject: [
            "at": "2026-07-18T10:00:00.000Z", "seq": 7, "runId": UIChallenge.runId,
            "eventType": "run.started", "createdAt": "2026-07-18T10:00:00.000Z",
        ])
        let row = try JSONDecoder().decode(AuditPayload.self, from: auditJSON)
        model.selectAuditFocus(row)   // the exact call AuditTimelineView.onSelect makes

        let descriptor = try XCTUnwrap(model.operationDescriptor(for: "git approve"))
        let form = ActionOperandForm(descriptor: descriptor)
        let seeded = form.seededValues(selection: model.selectedFocus)
        XCTAssertEqual(seeded["runId"], UIChallenge.runId,
                       "the selected run pre-filled the focused runId operand on the Actions form")
    }

    /// B4 regression — selecting a DIFFERENT audit row while the same operation stays selected must
    /// refresh the focused operands. Retaining the previous row's `runId` would authorize the WRONG run.
    /// Operator-typed fields must survive the re-seed.
    func testChangedSelectionReseedsFocusedOperandsPreservingOperatorEntry() async throws {
        let dir = UITestSupport.tempDir()
        let path = "/v/.atlas/atlas.db"
        let runner = UIScriptedRunner(dir: dir,
            streams: [.emitThenBlock(lines: [UIFx.hello(path: path)])],
            onceHellos: [UIFx.hello(path: path)])
        let model = AppModel(
            settingsStore: SettingsStore(defaults: UserDefaults(suiteName: "reseed-\(UUID())")!),
            environment: [ResolutionEnv.atlasRoot: "/atlas"],
            sessionFactory: { s, _ in try UITestSupport.session(runner: runner, settings: s) })
        await model.launch()
        let descriptor = try XCTUnwrap(model.operationDescriptor(for: "git approve"))
        let form = ActionOperandForm(descriptor: descriptor)

        // Row A selected, form seeded, and the operator types an extra field.
        var values = form.seededValues(selection: ["runId": "01ARZ3NDEKTSV4RRFFQ69G5FAV"])
        values["operatorNote"] = "typed by hand"
        XCTAssertEqual(values["runId"], "01ARZ3NDEKTSV4RRFFQ69G5FAV")

        // Selection moves to row B with the SAME op still selected.
        let reseeded = form.reseedFocused(values, selection: ["runId": "01BX5ZZKBKACTAV9WEVGEMMVRZ"])
        XCTAssertEqual(reseeded["runId"], "01BX5ZZKBKACTAV9WEVGEMMVRZ",
                       "the focused runId follows the new selection — never the previous run")
        XCTAssertEqual(reseeded["operatorNote"], "typed by hand",
                       "operator-entered fields are preserved across a selection change")

        // A selection carrying no value for the focused key CLEARS it rather than retaining a stale one.
        let cleared = form.reseedFocused(reseeded, selection: [:])
        XCTAssertNil(cleared["runId"], "a selection without the focused key clears the stale value")
        XCTAssertEqual(cleared["operatorNote"], "typed by hand")
    }

    func testFailedAndCancelledFlowAnnounceTerminalOutcomes() throws {
        // A failed or cancelled privileged flow must announce a terminal outcome, closing out the "busy"
        // utterance beginAction posts — never leaving a screen-reader user on an indefinite in-progress.
        let box = AnnounceBox()
        let model = AppModel(
            settingsStore: SettingsStore(defaults: UserDefaults(suiteName: "term-\(UUID())")!),
            environment: [:], announcer: box.announcer,
            sessionFactory: { _, _ in throw CancellationError() })

        // Failure path: an in-flight state → failed announces a terminal failure.
        model.ingestFlowState(.sign)
        model.ingestFlowState(.failed(reason: "boom"))
        XCTAssertTrue(box.events.contains { if case .failed = $0 { return true }; return false },
                      "a failed flow announces a terminal outcome")

        // Cancellation path: Display → Idle announces a cancellation.
        let challenge = try JSONDecoder().decode(AuthorizationChallenge.self, from: UIChallenge.gitApprove())
        model.ingestFlowState(.display(challenge))
        model.ingestFlowState(.idle)
        XCTAssertTrue(box.events.contains(.cancelled("Authorization")),
                      "a cancelled flow announces a terminal outcome")
    }

    func testQueryInvokedOnlyOnExplicitAction() async throws {
        let dir = UITestSupport.tempDir()
        let path = "/v/.atlas/atlas.db"
        let queryExample = try UITestSupport.schemaExample("query.schema.json")
        let runner = UIScriptedRunner(
            dir: dir,
            streams: [.emitThenBlock(lines: [UIFx.hello(path: path)])],
            onceHellos: [UIFx.hello(path: path)],
            queryResults: [SpawnResult(exitCode: 0, stdout: queryExample, stderr: Data())])
        let model = AppModel(
            settingsStore: SettingsStore(defaults: UserDefaults(suiteName: "q-\(UUID())")!),
            environment: [ResolutionEnv.atlasRoot: "/atlas", EgressCapabilityEnvVar: "cap-key"],
            sessionFactory: { s, _ in try UITestSupport.session(runner: runner, settings: s) })
        await model.launch()
        XCTAssertEqual(model.phase, .running)

        // No query spawn until the explicit run action (never polled).
        XCTAssertFalse(runner.runCommands.contains("query"), "no query before the explicit action")
        await model.runQuery("what changed?")
        XCTAssertNil(model.lastQueryError, "query succeeded: \(String(describing: model.lastQueryError))")
        XCTAssertNotNil(model.lastQueryResult)
        XCTAssertTrue(runner.runCommands.contains("query"), "the explicit action invoked EgressAction.query")
    }
}

@MainActor
final class ActorStateStreamTests: XCTestCase {

    private func poll(_ timeout: Double = 20, _ cond: () -> Bool) async -> Bool {
        let deadline = Date().addingTimeInterval(timeout)
        while Date() < deadline { if cond() { return true }; try? await Task.sleep(for: .milliseconds(25)) }
        return cond()
    }

    func testSupervisorRetryAndFlowChallengeReachObservablesAndAnnounce() async throws {
        let dir = UITestSupport.tempDir()
        let path = "/v/.atlas/atlas.db"
        // Supervisor: run 1 hellos then faults retryable (exit 4); run 2 sustains ⇒ a `.retrying` transition
        // is published. Flow: export returns a valid challenge ⇒ `.display`.
        let runner = UIScriptedRunner(
            dir: dir,
            streams: [
                .emitThenExit(lines: [UIFx.hello(path: path)], envelope: UIFx.envelope(code: "transient", retryable: true), exit: 4),
                .emitThenBlock(lines: [UIFx.hello(path: path)]),
            ],
            exportResults: [SpawnResult(exitCode: 6, stdout: UIChallenge.gitApprove(), stderr: Data())])
        let box = AnnounceBox()
        let model = AppModel(
            settingsStore: SettingsStore(defaults: UserDefaults(suiteName: "ss-\(UUID())")!),
            environment: [:],
            announcer: box.announcer,
            sessionFactory: { _, _ in throw CancellationError() })   // unused: we wire the actors directly
        let session = try UITestSupport.session(runner: runner)

        // Wire the two actor-state observers directly (no full launch — we drive the actors ourselves).
        model.observeSupervisor(session.supervisor)
        model.observeFlow(session.flow)

        // Drive the supervisor (retained) + the flow.
        let supTask = Task { await session.supervisor.run(resumeArg: .liveOnly, options: WatchOptions()) }
        await session.flow.begin(op: "git approve", focus: FocusContext(fields: ["runId": UIChallenge.runId]), entry: [:])

        let sawRetryAnnounce = await poll { box.events.contains(.watchRetrying(1)) }
        XCTAssertTrue(sawRetryAnnounce, "the supervisor retry transition fired a watchRetrying announcement")
        let sawChallengeAnnounce = await poll { box.events.contains(.challengeArrived) }
        XCTAssertTrue(sawChallengeAnnounce, "the flow challenge transition fired a challengeArrived announcement")

        // The mirrored @Observable properties reflect the transitions.
        if case .display = model.flowState {} else { XCTFail("flowState mirrored to .display, got \(model.flowState)") }
        XCTAssertNotEqual(model.supervisorState, .idle, "supervisorState mirrored a real transition")

        await session.supervisor.stop()
        supTask.cancel()
    }
}

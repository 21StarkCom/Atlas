import XCTest
import ConsoleCore
@testable import ConsoleUI

// P6-Task-1 — each surface renders from a fixture reducer state; snapshot-only fields carry the "as of"
// label; detail-on-demand reads are not timer-driven (the cadence guard admits only `watch`).
// @MainActor: the view initializers are MainActor-isolated under Swift 6 SwiftUI inference; the CI
// toolchain (older Swift 6) rejects calling them from a nonisolated sync test context.
@MainActor
final class SurfaceRenderTests: XCTestCase {

    private func auditRow(seq: Int, event: String) throws -> AuditPayload {
        let json = try JSONSerialization.data(withJSONObject: [
            "at": "2026-07-18T10:00:00.000Z", "seq": seq, "runId": "01ARZ3NDEKTSV4RRFFQ69G5FAV",
            "eventType": event, "createdAt": "2026-07-18T10:00:00.000Z",
        ])
        return try JSONDecoder().decode(AuditPayload.self, from: json)
    }

    private func modelCall() throws -> ModelCallPayload {
        let json = try JSONSerialization.data(withJSONObject: [
            "at": "2026-07-18T10:00:00.000Z", "callId": "c1", "runId": "01ARZ3NDEKTSV4RRFFQ69G5FAV",
            "provider": "anthropic", "model": "claude", "operation": "chat",
            "inputTokens": 10, "outputTokens": 20, "costMicros": 5, "createdAt": "2026-07-18T10:00:00.000Z",
        ])
        return try JSONDecoder().decode(ModelCallPayload.self, from: json)
    }

    private func dashboardFixture() -> DashboardState {
        DashboardState(
            openRuns: 2, jobs: JobCounts(queued: 1, failed: 0), quarantineCount: 3,
            backup: BackupView(watermarkSeq: 10, coveredSeq: 5, healthy: true),
            audit: AuditView(headSeq: 7, head: "abc", anchorOk: true, anchorSource: "broker"),
            daemons: DaemonView(broker: true, egress: true),
            snapshotAsOf: "2026-07-18T10:00:00.000Z")
    }

    func testEverySurfaceConstructsFromFixtureState() throws {
        _ = DashboardView(state: dashboardFixture(), reachability: DaemonReachability(broker: .reachable, egress: .reachable))
        _ = JobsListView(rows: [JobListRowState(jobId: "j1", workflow: "ingest", state: "running",
                                                attempts: 1, maxAttempts: 3, updatedAt: "2026-07-18T10:00:00.000Z")])
        _ = AuditTimelineView(rows: [try auditRow(seq: 1, event: "run.started")])
        _ = ModelCallFeedView(calls: [try modelCall()])
    }

    func testSnapshotOnlyFieldsCarryAsOfLabel() {
        let stamp = "2026-07-18T10:00:00.000Z"
        XCTAssertEqual(DashboardPresentation.asOfLabel(stamp), "as of \(stamp)")
        // A present value is shown WITH its "as of" provenance; an absent value is the label, never `0`.
        XCTAssertTrue(DashboardPresentation.snapshotOnly(3, snapshotAsOf: stamp).contains("as of"))
        // An ABSENT ledger-derived field is never fabricated as a bare "0" — it is the "as of" label.
        XCTAssertEqual(DashboardPresentation.snapshotOnly(nil, snapshotAsOf: stamp),
                       DashboardPresentation.asOfLabel(stamp))
        XCTAssertTrue(DashboardPresentation.snapshotOnly(nil, snapshotAsOf: stamp).contains("as of"))
        // No hello yet ⇒ an explicit "awaiting first hello", never a fabricated timestamp.
        XCTAssertTrue(DashboardPresentation.asOfLabel("").contains("awaiting"))
    }

    func testDetailOnDemandIsNotTimerDriven() {
        // The cadence guard: the ONLY periodic subprocess is `watch`; every audited/read command is
        // focus/action-triggered, never scheduled on a timer.
        XCTAssertTrue(CadencePolicy.isPeriodicAllowed("watch"))
        for cmd in ["status", "inspect", "graduation audit", "query", "jobs list", "note show", "git status"] {
            XCTAssertFalse(CadencePolicy.isPeriodicAllowed(cmd), "\(cmd) must not be timer-eligible")
        }
        var scheduler = PeriodicScheduler()
        XCTAssertThrowsError(try scheduler.register(command: "status"))
        XCTAssertNoThrow(try scheduler.register(command: "watch"))
    }

    // MARK: - Rendered fixture CONTENT (not just lazy view initialization)

    func testDashboardRendersFixtureContent() {
        // The transforms the DashboardView actually uses over the fixture produce the expected content:
        // present ledger-derived values are shown, absent ones become the "as of" label (never a bare 0).
        let s = dashboardFixture()
        XCTAssertEqual(s.openRuns.map(String.init), "2")
        XCTAssertEqual(s.jobs.map { String($0.queued) }, "1")
        XCTAssertEqual(s.jobs.map { String($0.failed) }, "0")
        // Quarantine is snapshot-only ⇒ shown WITH its "as of" provenance.
        let quarantine = DashboardPresentation.snapshotOnly(s.quarantineCount, snapshotAsOf: s.snapshotAsOf)
        XCTAssertTrue(quarantine.contains("3") && quarantine.contains("as of"))
        // Backup + anchor badges carry a NAME + a role symbol from the fixture state.
        XCTAssertEqual(StatusPresentation.backup(healthy: s.backup!.healthy).text.isEmpty, false)
        XCTAssertEqual(StatusPresentation.anchor(ok: s.audit!.anchorOk, source: s.audit!.anchorSource).text.isEmpty, false)
    }

    func testJobAndAuditRowContentIsControlSafe() throws {
        // The columns the JobsListView/AuditTimelineView render are the control-safe projections of the
        // fixture rows — a hostile jobId/runId is escaped, never rendered raw.
        let row = JobListRowState(jobId: "j\u{1B}1", workflow: "ingest", state: "running",
                                  attempts: 1, maxAttempts: 3, updatedAt: "2026-07-18T10:00:00.000Z")
        let jobCell = ControlSafeText.plain(row.jobId)
        XCTAssertFalse(jobCell.unicodeScalars.contains { $0.value == 0x1B }, "ESC escaped in the Job column")
        XCTAssertTrue(jobCell.contains("<U+001B>"))
        let audit = try auditRow(seq: 42, event: "run.started")
        XCTAssertEqual(ControlSafeText.plain(audit.eventType), "run.started")
    }

    // MARK: - Detail-on-demand actually SPAWNS through the ReadCommandExecutor (recording runner)

    func testRefreshDrivesJobsListThroughTheReadExecutor() async throws {
        // A read-on-focus refresh must spawn `jobs list` THROUGH the schema-bound read gateway — not merely
        // pass the cadence guard. A recording runner proves the spawn happens on the explicit action.
        let dir = UITestSupport.tempDir()
        let jobsPage = try UITestSupport.schemaExample("jobs-list.schema.json")
        let runner = UIScriptedRunner(dir: dir,
            genericResult: SpawnResult(exitCode: 0, stdout: jobsPage, stderr: Data()))
        let brain = try UITestSupport.binary()
        let exec = ReadCommandExecutor(runner: runner, binary: brain)
        let coord = JobStateCoordinator(reader: JobsListReader(), invoker: exec)

        XCTAssertFalse(runner.runCommands.contains("jobs list"), "no read before the explicit action")
        try? await coord.refresh()
        XCTAssertTrue(runner.runCommands.contains("jobs list"),
                      "the focus/action refresh spawned `jobs list` through the read executor")
    }
}

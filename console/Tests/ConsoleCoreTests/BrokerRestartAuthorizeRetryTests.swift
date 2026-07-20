import Foundation
import XCTest
@testable import ConsoleCore

/// AuthorizeRetry + broker-restart re-export resolution: a voided nonce re-exports (never resubmits a
/// stale artifact); a lost response resubmits the SAME artifact to a deterministic outcome; a replayed
/// nonce on an incomplete op surfaces reconciliation (no blind re-export).
final class BrokerRestartAuthorizeRetryTests: XCTestCase {
    private let focus = FocusContext(fields: ["runId": PFx.runId])

    private func driveToAuthorize(_ runner: PrivRunner, root: URL) async throws -> PrivilegedFlow {
        let flow = try PrivFlowKit.make(runner: runner, flowsRoot: root)
        await flow.begin(op: "git approve", focus: focus, entry: [:])
        await flow.confirm()
        return flow
    }

    private func signOK() -> [SpawnResult] {
        [SpawnResult(exitCode: 0, stdout: PFx.response(for: PFx.challengeDict()), stderr: Data())]
    }

    private func exportTwice() -> [SpawnResult] {
        [
            SpawnResult(exitCode: 6, stdout: PFx.challenge(), stderr: Data()),
            SpawnResult(exitCode: 6, stdout: PFx.challenge(["nonce": String(repeating: "2", count: 32)]), stderr: Data()),
        ]
    }

    // MARK: - Voided nonce ⇒ re-export, never resubmit stale

    func testNonceExpiredReExportsNeverResubmits() async throws {
        let root = PrivFlowKit.flowsRoot()
        let runner = PrivRunner(
            export: exportTwice(),
            sign: signOK(),
            authorize: [SpawnResult(exitCode: 6, stdout: PFx.envelope(code: "authz.nonce_expired"), stderr: Data())]
        )
        let flow = try await driveToAuthorize(runner, root: root)
        // Re-export minted a FRESH challenge; we are back in Display awaiting a new sign.
        guard case .display(let ch) = await flow.state else { return XCTFail("expected display, got \(await flow.state)") }
        XCTAssertEqual(ch.nonce, String(repeating: "2", count: 32))
        XCTAssertEqual(runner.calls(for: .authorize).count, 1, "must NOT resubmit the stale artifact")
        XCTAssertEqual(runner.calls(for: .export).count, 2)
    }

    func testNonceUnknownReExports() async throws {
        let root = PrivFlowKit.flowsRoot()
        let runner = PrivRunner(
            export: exportTwice(),
            sign: signOK(),
            authorize: [SpawnResult(exitCode: 1, stdout: PFx.envelope(code: "authz.nonce_unknown"), stderr: Data())]
        )
        let flow = try await driveToAuthorize(runner, root: root)
        guard case .display = await flow.state else { return XCTFail("expected display, got \(await flow.state)") }
        XCTAssertEqual(runner.calls(for: .authorize).count, 1)
    }

    // MARK: - Commit-then-response-loss ⇒ same-artifact resubmit ⇒ authz.ok + noop ⇒ Done

    func testCommitThenResponseLossResubmitsSameArtifactToDone() async throws {
        let root = PrivFlowKit.flowsRoot()
        let runner = PrivRunner(
            export: [SpawnResult(exitCode: 6, stdout: PFx.challenge(), stderr: Data())],
            sign: signOK(),
            authorize: [SpawnResult(exitCode: 0, stdout: PFx.successStdout(), stderr: Data())],
            authorizeThrows: [true, false] // first submit dies after a possible commit; resubmit succeeds
        )
        let flow = try await driveToAuthorize(runner, root: root)
        do { let s = await flow.state; XCTAssertEqual(s, .done) }
        let authCalls = runner.calls(for: .authorize)
        XCTAssertEqual(authCalls.count, 2, "indeterminate ⇒ resubmit exactly the same argv+artifact")
        XCTAssertEqual(authCalls[0].arguments, authCalls[1].arguments, "resubmit must be the EXACT same argv")
        XCTAssertEqual(PrivFlowKit.leftoverCount(root), 0)
    }

    func testRetryableAuthorizeResolvesToDone() async throws {
        let root = PrivFlowKit.flowsRoot()
        let runner = PrivRunner(
            export: [SpawnResult(exitCode: 6, stdout: PFx.challenge(), stderr: Data())],
            sign: signOK(),
            authorize: [
                SpawnResult(exitCode: 6, stdout: PFx.envelope(code: "action-required", retryable: true, retryAfterMs: 10), stderr: Data()),
                SpawnResult(exitCode: 0, stdout: PFx.successStdout(), stderr: Data()),
            ]
        )
        let flow = try await driveToAuthorize(runner, root: root)
        do { let s = await flow.state; XCTAssertEqual(s, .done) }
        XCTAssertEqual(runner.calls(for: .authorize).count, 2)
    }

    // MARK: - Replayed nonce (op incomplete) ⇒ reconciliation, no blind re-export

    func testNonceReplayedSurfacesReconciliationNoReExport() async throws {
        let root = PrivFlowKit.flowsRoot()
        let runner = PrivRunner(
            export: exportTwice(),
            sign: signOK(),
            authorize: [SpawnResult(exitCode: 1, stdout: PFx.envelope(code: "authz.nonce_replayed"), stderr: Data())]
        )
        let flow = try await driveToAuthorize(runner, root: root)
        guard case .failed(let reason) = await flow.state else { return XCTFail("expected failed, got \(await flow.state)") }
        XCTAssertTrue(reason.contains("authz.nonce_replayed"))
        XCTAssertTrue(reason.contains("reconcile"))
        XCTAssertEqual(runner.calls(for: .export).count, 1, "a replayed nonce must NOT blind re-export")
        XCTAssertEqual(PrivFlowKit.leftoverCount(root), 0)
    }

    // MARK: - Indeterminate past the retry cap ⇒ Failed

    func testIndeterminatePastCapFails() async throws {
        let root = PrivFlowKit.flowsRoot()
        let runner = PrivRunner(
            export: [SpawnResult(exitCode: 6, stdout: PFx.challenge(), stderr: Data())],
            sign: signOK(),
            authorize: [],
            authorizeThrows: [true, true, true] // exceeds maxAuthorizeRetries = 2
        )
        let flow = try PrivFlowKit.make(runner: runner, flowsRoot: root, maxAuthorizeRetries: 2)
        await flow.begin(op: "git approve", focus: focus, entry: [:])
        await flow.confirm()
        guard case .failed(let reason) = await flow.state else { return XCTFail("expected failed, got \(await flow.state)") }
        XCTAssertTrue(reason.contains("indeterminate"))
        XCTAssertEqual(PrivFlowKit.leftoverCount(root), 0)
    }
}

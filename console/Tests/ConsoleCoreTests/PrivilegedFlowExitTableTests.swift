import Foundation
import XCTest
@testable import ConsoleCore

/// Drives export→sign→authorize with software-P-256 fixtures and asserts each stage is interpreted by
/// the correct exit table (`brain` 0–6, `atlas-signer` 0–5) — never cross-mapped — plus the Display
/// consistency gate and temp-dir cleanup on every terminal transition.
final class PrivilegedFlowExitTableTests: XCTestCase {
    private let focus = FocusContext(fields: ["runId": PFx.runId])

    private func begin(_ flow: PrivilegedFlow) async {
        await flow.begin(op: "git approve", focus: focus, entry: [:])
    }

    // MARK: - Exit 0 is not self-certifying

    /// B1 regression — an authorize that exits 0 but whose stdout does NOT satisfy the op's bound command
    /// schema must FAIL CLOSED, never resolve to Done. Treating any exit 0 as success is fail-open: a
    /// half-completed handler emitting empty/foreign output would be reported as a completed mutation.
    func testAuthorizeExitZeroWithInvalidStdoutFailsClosed() async throws {
        for badStdout in [Data(), Data("{}".utf8), Data(#"{"code":"authz.ok"}"#.utf8), Data("not json".utf8)] {
            let root = PrivFlowKit.flowsRoot()
            let runner = PrivRunner(
                export: [SpawnResult(exitCode: 6, stdout: PFx.challenge(), stderr: Data())],
                sign: [SpawnResult(exitCode: 0, stdout: PFx.response(for: PFx.challengeDict()), stderr: Data())],
                authorize: [SpawnResult(exitCode: 0, stdout: badStdout, stderr: Data())]
            )
            let flow = try PrivFlowKit.make(runner: runner, flowsRoot: root)
            await begin(flow)
            await flow.confirm()
            let state = await flow.state
            guard case .failed = state else {
                return XCTFail("exit 0 with invalid stdout must fail closed, got \(state)")
            }
            // And the per-flow temp dir is still cleaned up on the failure path.
            XCTAssertEqual(PrivFlowKit.leftoverCount(root), 0, "temp dir cleaned on the fail-closed path")
        }
    }

    // MARK: - Happy path

    func testHappyPathExportSignAuthorizeDone() async throws {
        let root = PrivFlowKit.flowsRoot()
        let runner = PrivRunner(
            export: [SpawnResult(exitCode: 6, stdout: PFx.challenge(), stderr: Data())],
            sign: [SpawnResult(exitCode: 0, stdout: PFx.response(for: PFx.challengeDict()), stderr: Data())],
            authorize: [SpawnResult(exitCode: 0, stdout: PFx.successStdout(), stderr: Data())]
        )
        let flow = try PrivFlowKit.make(runner: runner, flowsRoot: root)
        await begin(flow)
        guard case .display(let ch) = await flow.state else { return XCTFail("expected display, got \(await flow.state)") }
        XCTAssertEqual(ch.op, "git approve")
        XCTAssertEqual(ch.runId, PFx.runId)
        await flow.confirm()
        do { let s = await flow.state; XCTAssertEqual(s, .done) }
        // Sign was piped the FROZEN challenge bytes on stdin, no --out.
        let signCall = runner.calls(for: .sign).first
        XCTAssertEqual(signCall?.arguments, ["sign"])
        XCTAssertNotNil(signCall?.stdin)
        XCTAssertFalse(signCall?.arguments.contains("--out") ?? true)
        // Temp dir cleaned on Done — no signed authorization artifact lingers.
        XCTAssertEqual(PrivFlowKit.leftoverCount(root), 0)
    }

    func testAuthorizeNoopRendersDone() async throws {
        let root = PrivFlowKit.flowsRoot()
        let runner = PrivRunner(
            export: [SpawnResult(exitCode: 6, stdout: PFx.challenge(), stderr: Data())],
            sign: [SpawnResult(exitCode: 0, stdout: PFx.response(for: PFx.challengeDict()), stderr: Data())],
            authorize: [SpawnResult(exitCode: 0, stdout: PFx.successStdout(), stderr: Data())]
        )
        let flow = try PrivFlowKit.make(runner: runner, flowsRoot: root)
        await begin(flow)
        await flow.confirm()
        do { let s = await flow.state; XCTAssertEqual(s, .done) }
    }

    // MARK: - Export outcomes

    func testExportNonRetryableExitFails() async throws {
        for code: Int32 in [1, 2, 4, 5] {
            let root = PrivFlowKit.flowsRoot()
            let runner = PrivRunner(export: [SpawnResult(exitCode: code, stdout: Data(), stderr: PFx.envelope(code: "usage"))])
            let flow = try PrivFlowKit.make(runner: runner, flowsRoot: root)
            await begin(flow)
            guard case .failed(let reason) = await flow.state else { return XCTFail("expected failed for exit \(code)") }
            XCTAssertTrue(reason.contains("export"))
            XCTAssertEqual(PrivFlowKit.leftoverCount(root), 0)
        }
    }

    func testExportRetryableEnvelopeFailsWithReinitiateHint() async throws {
        let root = PrivFlowKit.flowsRoot()
        let runner = PrivRunner(export: [SpawnResult(exitCode: 2, stdout: Data(), stderr: PFx.envelope(code: "backup-unhealthy", retryable: true))])
        let flow = try PrivFlowKit.make(runner: runner, flowsRoot: root)
        await begin(flow)
        guard case .failed(let reason) = await flow.state else { return XCTFail("expected failed") }
        XCTAssertTrue(reason.contains("retryable"))
        XCTAssertTrue(reason.contains("re-initiate"))
    }

    // MARK: - Display consistency gate

    func testConsistencyGateOpMismatchFailsBeforeDisplay() async throws {
        let root = PrivFlowKit.flowsRoot()
        // Challenge for a DIFFERENT op than the bound invocation ⇒ terminal challenge-mismatch.
        let runner = PrivRunner(export: [SpawnResult(exitCode: 6, stdout: PFx.challenge(["op": "purge"]), stderr: Data())])
        let flow = try PrivFlowKit.make(runner: runner, flowsRoot: root)
        await begin(flow)
        guard case .failed(let reason) = await flow.state else { return XCTFail("expected failed, got \(await flow.state)") }
        XCTAssertTrue(reason.contains("challenge-mismatch"))
        XCTAssertEqual(PrivFlowKit.leftoverCount(root), 0)
    }

    func testConsistencyGateUnsupportedCanonicalizationFails() async throws {
        let root = PrivFlowKit.flowsRoot()
        let runner = PrivRunner(export: [SpawnResult(exitCode: 6, stdout: PFx.challenge(["payloadCanonicalization": "made-up-v9"]), stderr: Data())])
        let flow = try PrivFlowKit.make(runner: runner, flowsRoot: root)
        await begin(flow)
        guard case .failed(let reason) = await flow.state else { return XCTFail("expected failed") }
        XCTAssertTrue(reason.contains("challenge-mismatch"))
        XCTAssertTrue(reason.contains("Canonicalization") || reason.contains("canonicalization"))
    }

    func testCancelAtDisplayReturnsToIdleAndCleans() async throws {
        let root = PrivFlowKit.flowsRoot()
        let runner = PrivRunner(export: [SpawnResult(exitCode: 6, stdout: PFx.challenge(), stderr: Data())])
        let flow = try PrivFlowKit.make(runner: runner, flowsRoot: root)
        await begin(flow)
        if case .display = await flow.state {} else { return XCTFail("expected display") }
        await flow.cancel()
        do { let s = await flow.state; XCTAssertEqual(s, .idle) }
        XCTAssertEqual(PrivFlowKit.leftoverCount(root), 0)
    }

    // MARK: - Signer exit table (0–5), never read against the brain table

    func testSignerInternalFaultExit1Fails() async throws {
        try await signerExit(1) { reason in XCTAssertTrue(reason.contains("exit 1")) }
    }

    func testSignerMalformedExit2Fails() async throws {
        try await signerExit(2) { reason in XCTAssertTrue(reason.contains("exit 2")) }
    }

    func testSignerExpiredExit3ReExports() async throws {
        let root = PrivFlowKit.flowsRoot()
        let runner = PrivRunner(
            export: [
                SpawnResult(exitCode: 6, stdout: PFx.challenge(), stderr: Data()),
                SpawnResult(exitCode: 6, stdout: PFx.challenge(["nonce": String(repeating: "1", count: 32)]), stderr: Data()),
            ],
            sign: [SpawnResult(exitCode: 3, stdout: Data(), stderr: Data())]
        )
        let flow = try PrivFlowKit.make(runner: runner, flowsRoot: root)
        await begin(flow)
        await flow.confirm()
        // exit 3 (expired) ⇒ a fresh challenge is minted and we land back in Display.
        guard case .display(let ch) = await flow.state else { return XCTFail("expected display after re-export, got \(await flow.state)") }
        XCTAssertEqual(ch.nonce, String(repeating: "1", count: 32))
        XCTAssertEqual(runner.calls(for: .export).count, 2)
    }

    func testSignerCancelExit4ReturnsToIdle() async throws {
        let root = PrivFlowKit.flowsRoot()
        let runner = PrivRunner(
            export: [SpawnResult(exitCode: 6, stdout: PFx.challenge(), stderr: Data())],
            sign: [SpawnResult(exitCode: 4, stdout: Data(), stderr: Data())]
        )
        let flow = try PrivFlowKit.make(runner: runner, flowsRoot: root)
        await begin(flow)
        await flow.confirm()
        do { let s = await flow.state; XCTAssertEqual(s, .idle) }
        XCTAssertEqual(PrivFlowKit.leftoverCount(root), 0)
    }

    func testSignerKeyInvalidatedExit5FailsWithReenroll() async throws {
        try await signerExit(5) { reason in
            XCTAssertTrue(reason.contains("re-enroll"))
        }
    }

    /// A brain exit code in the signer's numeric range is NEVER interpreted by the brain table: a signer
    /// exit 2 is "malformed", not brain's "config" — proven by the distinct failure reason.
    private func signerExit(_ code: Int32, _ check: (String) -> Void) async throws {
        let root = PrivFlowKit.flowsRoot()
        let runner = PrivRunner(
            export: [SpawnResult(exitCode: 6, stdout: PFx.challenge(), stderr: Data())],
            sign: [SpawnResult(exitCode: code, stdout: Data(), stderr: Data())]
        )
        let flow = try PrivFlowKit.make(runner: runner, flowsRoot: root)
        await begin(flow)
        await flow.confirm()
        guard case .failed(let reason) = await flow.state else { return XCTFail("expected failed for signer exit \(code)") }
        XCTAssertTrue(reason.hasPrefix("sign:"))
        check(reason)
        XCTAssertEqual(PrivFlowKit.leftoverCount(root), 0)
    }

    func testSignMalformedResponseFails() async throws {
        let root = PrivFlowKit.flowsRoot()
        let runner = PrivRunner(
            export: [SpawnResult(exitCode: 6, stdout: PFx.challenge(), stderr: Data())],
            sign: [SpawnResult(exitCode: 0, stdout: Data("{\"not\":\"a response\"}".utf8), stderr: Data())]
        )
        let flow = try PrivFlowKit.make(runner: runner, flowsRoot: root)
        await begin(flow)
        await flow.confirm()
        guard case .failed(let reason) = await flow.state else { return XCTFail("expected failed") }
        XCTAssertTrue(reason.contains("malformed response"))
    }

    // MARK: - Authorize broker authz.* branch (exit-6 handling)

    func testAuthorizeContractRefusalFails() async throws {
        let root = PrivFlowKit.flowsRoot()
        let runner = PrivRunner(
            export: [SpawnResult(exitCode: 6, stdout: PFx.challenge(), stderr: Data())],
            sign: [SpawnResult(exitCode: 0, stdout: PFx.response(for: PFx.challengeDict()), stderr: Data())],
            authorize: [SpawnResult(exitCode: 1, stdout: PFx.envelope(code: "authz.signature_invalid"), stderr: Data())]
        )
        let flow = try PrivFlowKit.make(runner: runner, flowsRoot: root)
        await begin(flow)
        await flow.confirm()
        guard case .failed(let reason) = await flow.state else { return XCTFail("expected failed, got \(await flow.state)") }
        XCTAssertTrue(reason.contains("authz.signature_invalid"))
        XCTAssertEqual(PrivFlowKit.leftoverCount(root), 0)
    }

    // MARK: - TOTAL authorize matrix over brain exits 0–6 + unknown (finding: no silent AuthorizeRetry)

    /// A nonzero authorize exit with NO parseable envelope must FAIL for every definitive code (1/2/3/5)
    /// and every UNKNOWN code — never silently enter AuthorizeRetry.
    func testAuthorizeDefinitiveExitsWithNoEnvelopeFail() async throws {
        for code: Int32 in [1, 2, 3, 5, 99] {
            let root = PrivFlowKit.flowsRoot()
            let runner = PrivRunner(
                export: [SpawnResult(exitCode: 6, stdout: PFx.challenge(), stderr: Data())],
                sign: [SpawnResult(exitCode: 0, stdout: PFx.response(for: PFx.challengeDict()), stderr: Data())],
                authorize: [SpawnResult(exitCode: code, stdout: Data("not-json".utf8), stderr: Data("plain".utf8))]
            )
            let flow = try PrivFlowKit.make(runner: runner, flowsRoot: root, maxAuthorizeRetries: 2)
            await begin(flow); await flow.confirm()
            guard case .failed(let reason) = await flow.state else { return XCTFail("exit \(code): expected failed, got \(await flow.state)") }
            XCTAssertTrue(reason.contains("authorize"), "exit \(code) reason: \(reason)")
            XCTAssertEqual(runner.calls(for: .authorize).count, 1, "exit \(code) must not retry")
            XCTAssertEqual(PrivFlowKit.leftoverCount(root), 0)
        }
    }

    /// exit 0 ⇒ Done; exit 4/6 with NO envelope ⇒ indeterminate ⇒ AuthorizeRetry (a possible commit),
    /// which resolves on the next authz.ok.
    func testAuthorizeExit0DoneAndIndeterminate4And6Retry() async throws {
        // exit 0 direct.
        do {
            let root = PrivFlowKit.flowsRoot()
            let runner = PrivRunner(
                export: [SpawnResult(exitCode: 6, stdout: PFx.challenge(), stderr: Data())],
                sign: [SpawnResult(exitCode: 0, stdout: PFx.response(for: PFx.challengeDict()), stderr: Data())],
                authorize: [SpawnResult(exitCode: 0, stdout: PFx.successStdout(), stderr: Data())]
            )
            let flow = try PrivFlowKit.make(runner: runner, flowsRoot: root)
            await begin(flow); await flow.confirm()
            let s = await flow.state; XCTAssertEqual(s, .done)
        }
        // exit 4 and exit 6 with no envelope: retry, then resolve on authz.ok.
        for code: Int32 in [4, 6] {
            let root = PrivFlowKit.flowsRoot()
            let runner = PrivRunner(
                export: [SpawnResult(exitCode: 6, stdout: PFx.challenge(), stderr: Data())],
                sign: [SpawnResult(exitCode: 0, stdout: PFx.response(for: PFx.challengeDict()), stderr: Data())],
                authorize: [
                    SpawnResult(exitCode: code, stdout: Data("not-json".utf8), stderr: Data()),
                    SpawnResult(exitCode: 0, stdout: PFx.successStdout(), stderr: Data()),
                ]
            )
            let flow = try PrivFlowKit.make(runner: runner, flowsRoot: root, maxAuthorizeRetries: 3)
            await begin(flow); await flow.confirm()
            let s = await flow.state; XCTAssertEqual(s, .done, "exit \(code) should retry then resolve")
            XCTAssertEqual(runner.calls(for: .authorize).count, 2, "exit \(code) should have retried once")
        }
    }

    // MARK: - stateChanges stream (Display / retry / cancellation / terminal delivery)

    func testStateChangesStreamPublishesEveryTransition() async throws {
        let root = PrivFlowKit.flowsRoot()
        let runner = PrivRunner(
            export: [SpawnResult(exitCode: 6, stdout: PFx.challenge(), stderr: Data())],
            sign: [SpawnResult(exitCode: 0, stdout: PFx.response(for: PFx.challengeDict()), stderr: Data())],
            authorize: [
                SpawnResult(exitCode: 6, stdout: PFx.envelope(code: "action-required", retryable: true, retryAfterMs: 1), stderr: Data()),
                SpawnResult(exitCode: 0, stdout: PFx.successStdout(), stderr: Data()),
            ]
        )
        let flow = try PrivFlowKit.make(runner: runner, flowsRoot: root)
        let collector = StateCollector()
        let consumer = Task { for await s in flow.stateChanges { await collector.add(s) } }

        await begin(flow)
        await flow.confirm()
        // Let the buffered transitions drain to the consumer.
        try await Task.sleep(for: .milliseconds(50))
        consumer.cancel()

        let kinds = await collector.kinds
        // Export → Display → Sign → Authorize → AuthorizeRetry → Done, all observed without polling.
        XCTAssertEqual(kinds.first, "export")
        XCTAssertTrue(kinds.contains("display"))
        XCTAssertTrue(kinds.contains("sign"))
        XCTAssertTrue(kinds.contains("authorize"))
        XCTAssertTrue(kinds.contains("authorizeRetry"), "the retry transition must be published")
        XCTAssertEqual(kinds.last, "done", "the terminal state must be delivered")
    }

    func testStateChangesDeliversCancellationTerminal() async throws {
        let root = PrivFlowKit.flowsRoot()
        let runner = PrivRunner(export: [SpawnResult(exitCode: 6, stdout: PFx.challenge(), stderr: Data())])
        let flow = try PrivFlowKit.make(runner: runner, flowsRoot: root)
        let collector = StateCollector()
        let consumer = Task { for await s in flow.stateChanges { await collector.add(s) } }
        await begin(flow)
        await flow.cancel()
        try await Task.sleep(for: .milliseconds(50))
        consumer.cancel()
        let kinds = await collector.kinds
        XCTAssertTrue(kinds.contains("display"))
        XCTAssertEqual(kinds.last, "idle", "cancellation lands on idle and is delivered")
    }

    // MARK: - Fail-closed filesystem: an unwritable flows root fails BEFORE any spawn (finding 7)

    func testUnwritableTempDirFailsClosedBeforeSpawn() async throws {
        // Point the flows root at a child of a REGULAR FILE — createDirectory cannot succeed.
        let file = TestSupport.tempDir("priv-blocker").appendingPathComponent("blocker")
        try Data("x".utf8).write(to: file)
        let flowsRoot = file.appendingPathComponent("flows")
        let runner = PrivRunner(export: [SpawnResult(exitCode: 6, stdout: PFx.challenge(), stderr: Data())])
        let flow = try PrivFlowKit.make(runner: runner, flowsRoot: flowsRoot)
        await begin(flow)
        guard case .failed(let reason) = await flow.state else { return XCTFail("expected failed, got \(await flow.state)") }
        XCTAssertTrue(reason.contains("temp-dir"), reason)
        XCTAssertTrue(runner.calls.isEmpty, "no export spawn may run without a real 0700 temp dir")
    }

    // MARK: - Actor reentrancy: a cancel mid-authorize cannot be revived by the old continuation (finding 4)

    func testCancelDuringAuthorizeIsNotRevivedByOldContinuation() async throws {
        let root = PrivFlowKit.flowsRoot()
        let runner = GatedAuthorizeRunner(
            export: [SpawnResult(exitCode: 6, stdout: PFx.challenge(), stderr: Data())],
            sign: [SpawnResult(exitCode: 0, stdout: PFx.response(for: PFx.challengeDict()), stderr: Data())]
        )
        let flow = try PrivFlowKit.makeGeneric(runner: runner, flowsRoot: root)
        // Drive begin→confirm; confirm suspends inside the parked authorize spawn.
        let localFocus = FocusContext(fields: ["runId": PFx.runId])
        let driver = Task { await flow.begin(op: "git approve", focus: localFocus, entry: [:]); await flow.confirm() }
        // Wait until authorize has actually entered.
        var waited = 0
        while !runner.authorizeEntered && waited < 500 { try await Task.sleep(for: .milliseconds(5)); waited += 1 }
        XCTAssertTrue(runner.authorizeEntered, "authorize should have entered")
        // Cancel while suspended — bumps the generation and lands idle + cleanup.
        await flow.cancel()
        // Now release the OLD authorize with a success: it must NOT flip the cancelled flow to Done.
        runner.releaseAuthorize(SpawnResult(exitCode: 0, stdout: PFx.successStdout(), stderr: Data()))
        await driver.value
        let s = await flow.state
        XCTAssertEqual(s, .idle, "the superseded continuation must not revive a cancelled flow")
        XCTAssertEqual(PrivFlowKit.leftoverCount(root), 0)
    }

    // MARK: - AuthorizeRetry is published BEFORE the backoff sleep (finding: blocking sleeper)

    /// With a BLOCKING sleeper, the flow must already be in `authorizeRetry` while the backoff is still in
    /// progress — an observer is never stranded in `authorize` throughout the wait.
    func testAuthorizeRetryPublishedBeforeBackoffSleep() async throws {
        let root = PrivFlowKit.flowsRoot()
        let runner = PrivRunner(
            export: [SpawnResult(exitCode: 6, stdout: PFx.challenge(), stderr: Data())],
            sign: [SpawnResult(exitCode: 0, stdout: PFx.response(for: PFx.challengeDict()), stderr: Data())],
            authorize: [
                SpawnResult(exitCode: 6, stdout: PFx.envelope(code: "action-required", retryable: true, retryAfterMs: 1), stderr: Data()),
                SpawnResult(exitCode: 0, stdout: PFx.successStdout(), stderr: Data()),
            ]
        )
        let gate = SleepGate()
        let brain = try Fx4.binary()
        let flow = try PrivilegedFlow(
            runner: runner, brain: brain, signer: brain,
            router: OperationRouter(bundle: brain.bundle), validator: SignerContractValidator(),
            configRoot: brain.bundle.checkoutRoot, flowsRoot: root, maxAuthorizeRetries: 3,
            brainTimeout: .seconds(5), sleeper: { _ in await gate.waitOnce() })
        let localFocus = focus
        let driver = Task { await flow.begin(op: "git approve", focus: localFocus, entry: [:]); await flow.confirm() }

        var waited = 0
        while waited < 600 {
            if case .authorizeRetry = await flow.state { break }
            try await Task.sleep(for: .milliseconds(5)); waited += 1
        }
        guard case .authorizeRetry = await flow.state else {
            return XCTFail("AuthorizeRetry must be published WHILE the backoff sleep blocks, not after")
        }
        await gate.release() // let the backoff complete → resubmit → authz.ok
        await driver.value
        let final = await flow.state
        XCTAssertEqual(final, .done)
    }

    // MARK: - An invalid/unsupported begin cleans the PREVIOUS flow's temp dir (finding 5)

    /// A flow parked at Display (its challenge/authorization temp dir on disk) then a NEW begin for an
    /// unsupported op must not leave the prior dir behind: the supersede path cleans it before failing.
    func testInvalidBeginCleansPreviousFlowDirectory() async throws {
        let root = PrivFlowKit.flowsRoot()
        let runner = PrivRunner(export: [SpawnResult(exitCode: 6, stdout: PFx.challenge(), stderr: Data())])
        let flow = try PrivFlowKit.make(runner: runner, flowsRoot: root)
        await begin(flow) // lands in Display with a live temp dir…
        if case .display = await flow.state {} else { return XCTFail("expected display") }
        XCTAssertEqual(PrivFlowKit.leftoverCount(root), 1, "the parked flow has a temp dir on disk")

        // A NEW begin for an unsupported op (not a privileged registry command) supersedes + fails…
        await flow.begin(op: "definitely not a command", focus: FocusContext(), entry: [:])
        guard case .failed(let reason) = await flow.state else { return XCTFail("expected failed, got \(await flow.state)") }
        XCTAssertTrue(reason.contains("unsupported"))
        // …and the PREVIOUS flow's directory is gone (no lingering signed-artifact scratch).
        XCTAssertEqual(PrivFlowKit.leftoverCount(root), 0, "the superseded flow's temp dir must be cleaned")
    }

    // MARK: - A malformed bound error-envelope schema fails the flow at CONSTRUCTION (finding 6)

    /// The Authorize matrix must never fall open. If the bound `error-envelope.schema.json` is malformed,
    /// `PrivilegedFlow` cannot be constructed at all (the parser is REQUIRED), so a definitive exit 4/6
    /// can never be silently downgraded into an indeterminate retry by a disabled parser.
    func testMalformedErrorEnvelopeSchemaFailsFlowConstruction() throws {
        let root = try TestSupport.makeFixtureCheckout()
        let errEnv = root.appendingPathComponent("docs/specs/cli-contract/error-envelope.schema.json")
        try Data("{ this is not valid json ".utf8).write(to: errEnv)
        let bundle = try ContractBundle.resolve(fromAnchor: root)
        let brain = ResolvedBinary(launch: ["/usr/bin/true"], contractAnchor: root, baseEnv: [:], bundle: bundle)
        let runner = PrivRunner()
        XCTAssertThrowsError(
            try PrivilegedFlow(
                runner: runner, brain: brain, signer: brain,
                router: OperationRouter(bundle: bundle), validator: SignerContractValidator(),
                configRoot: root, flowsRoot: root.appendingPathComponent("flows"),
                sleeper: { _ in }),
            "a malformed bound envelope schema must fail flow construction, never disable parsing"
        )
    }
}

/// Collects `PrivilegedFlowState`s published on the `stateChanges` stream, as lightweight kind labels.
actor StateCollector {
    private(set) var kinds: [String] = []
    func add(_ s: PrivilegedFlowState) { kinds.append(StateCollector.kind(s)) }
    static func kind(_ s: PrivilegedFlowState) -> String {
        switch s {
        case .idle: return "idle"
        case .export: return "export"
        case .display: return "display"
        case .sign: return "sign"
        case .authorize: return "authorize"
        case .done: return "done"
        case .authorizeRetry: return "authorizeRetry"
        case .retry: return "retry"
        case .failed: return "failed"
        }
    }
}

/// A one-shot gate for the blocking-sleeper test: the FIRST `waitOnce()` blocks until `release()`;
/// any later call returns immediately. Lets a test hold the flow inside its backoff sleep.
actor SleepGate {
    private var cont: CheckedContinuation<Void, Never>?
    private var released = false
    private var used = false
    func waitOnce() async {
        if used || released { return }
        used = true
        await withCheckedContinuation { (c: CheckedContinuation<Void, Never>) in
            if released { c.resume() } else { cont = c }
        }
    }
    func release() {
        released = true
        cont?.resume(); cont = nil
    }
}

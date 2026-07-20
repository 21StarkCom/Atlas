import Foundation
import XCTest
@testable import ConsoleCore

/// The cadence invariant: the ONLY periodic subprocess is `brain watch`; no audited read runs on a timer.
final class CadenceGuardTests: XCTestCase {
    func testOnlyWatchIsPeriodic() throws {
        XCTAssertEqual(CadencePolicy.periodicCommands, ["watch"])
        XCTAssertTrue(CadencePolicy.isPeriodicAllowed("watch"))
    }

    /// The scheduler surface — not a constant checked against itself — REFUSES to register any audited
    /// read (and every read-surface command), and admits only `watch`. A future timer that tried to spawn
    /// an audited read would throw here, so the sole registered periodic task can only ever be the watch.
    func testSchedulerAdmitsOnlyWatch() throws {
        let bundle = try TestSupport.realBundle()

        var scheduler = PeriodicScheduler()
        try scheduler.register(command: "watch")
        XCTAssertEqual(scheduler.registered, ["watch"], "the sole registered periodic task must be watch")

        // Every audited read is REFUSED by the scheduler (proven against the runtime inventory).
        let audited = ReadSurface.auditedReadCommands(bundle).map(\.name)
        XCTAssertEqual(Set(audited), ["graduation audit", "inspect", "query", "status"])
        for cmd in audited {
            XCTAssertThrowsError(try scheduler.register(command: cmd), "audited read \(cmd) must not be schedulable") { err in
                XCTAssertEqual(err as? PeriodicScheduler.SchedulingError, .notPeriodicAllowed(cmd))
            }
        }
        // Every other read-surface command is likewise refused; only watch ever survives.
        for cmd in ReadSurface.readCommands(bundle).map(\.name) where cmd != "watch" {
            XCTAssertThrowsError(try scheduler.register(command: cmd), "read \(cmd) must not be schedulable")
        }
        // The audit of what was admitted is still exactly [watch] after all refusals.
        XCTAssertEqual(scheduler.registered, ["watch"])
        XCTAssertFalse(audited.contains("watch"))
    }

    /// The enforcement seam is REAL, at the spawn boundary: `WatchSupervisor` admits its recurring command
    /// through `PeriodicScheduler` at construction. `watch` is admitted; any audited read is REJECTED, so a
    /// supervisor that would periodically spawn a read can never be built (not merely discouraged).
    func testWatchSupervisorAdmitsWatchAndRejectsAuditedReadsAtConstruction() throws {
        let binary = try Fx4.binary()
        let runner = ScriptedSpawnRunner(dir: TestSupport.tempDir(), streams: [], onceOutputs: [])
        // Admission: the default watch supervisor constructs fine.
        XCTAssertNoThrow(try WatchSupervisor(runner: runner, binary: binary))
        // Rejection: every audited read is refused at the spawn boundary (construction throws).
        let bundle = try TestSupport.realBundle()
        for cmd in ReadSurface.auditedReadCommands(bundle).map(\.name) {
            XCTAssertThrowsError(try WatchSupervisor(runner: runner, binary: binary, periodicCommand: cmd),
                                 "a periodic \(cmd) supervisor must not be constructible") { err in
                XCTAssertEqual(err as? PeriodicScheduler.SchedulingError, .notPeriodicAllowed(cmd))
            }
        }
    }

    func testReadSurfaceInventoryCountsFromExecutionClass() throws {
        let bundle = try TestSupport.realBundle()
        let read = ReadSurface.readCommands(bundle)
        // 18 read + 4 audited-read + 4 pure = 26 (60-B added `sync status`, executionClass read).
        XCTAssertEqual(read.count, 26)
        XCTAssertTrue(read.allSatisfy { ReadSurface.readExecutionClasses.contains($0.executionClass) })
    }
}

/// The egress-minting drift guard.
final class EgressMintingDriftTests: XCTestCase {
    func testEgressMintingConstantMatchesSchemas() throws {
        let bundle = try TestSupport.realBundle()
        XCTAssertEqual(EgressMintingDrift.mirror, ["query", "index eval"])
        if let authoritative = EgressMintingDrift.fromSchemas(bundle) {
            // Once the schemas carry `mintsEgressCapability`, the mirror MUST agree (fail on drift).
            XCTAssertEqual(authoritative, EgressMintingDrift.mirror, "EgressMintingCommands drifted from the schemas")
        } else {
            // No schema carries the authoritative field yet — the mirror is the temporary SSOT.
            XCTAssertEqual(EgressMintingDrift.mirror, ConsoleConstants.egressMintingCommands)
        }
    }
}

/// Read-command conformance: representative read commands carry `--json` on their argv contract, their
/// schema strict-validates a representative payload, and the validator is ARMED (an independently-built
/// payload missing a required field is REJECTED — so a pass is not vacuous).
final class ReadCommandConformanceTests: XCTestCase {
    private func assertConforms(_ command: String) throws {
        let bundle = try TestSupport.realBundle()
        guard let schemaData = bundle.schema(for: command) else { return XCTFail("no schema for \(command)") }
        let obj = try JSONSerialization.jsonObject(with: schemaData) as! [String: Any]
        let contract = obj["x-atlas-contract"] as! [String: Any]

        // (1) --json is part of the command's argv contract (the Console always sniffs the JSON envelope).
        let commonFlags = (contract["commonFlags"] as? [String]) ?? []
        XCTAssertTrue(commonFlags.contains("--json"), "\(command) must expose --json on its argv contract")

        // (2) A representative payload strict-validates.
        let validator = try SchemaValidator(schema: schemaData)
        guard let examples = obj["examples"] as? [Any], let first = examples.first as? [String: Any] else {
            return XCTFail("\(command) schema has no example object to validate")
        }
        let payload = try JSONSerialization.data(withJSONObject: first)
        XCTAssertTrue(validator.validate(payload).isValid, "\(command) representative payload failed strict validation")

        // (3) ARMED: an independently-derived payload with a required top-level property removed is
        // REJECTED. Proves the validator actually constrains the shape (not a vacuous pass). If a schema
        // declares no required top-level properties there is nothing to arm against — skip cleanly.
        guard let required = (obj["required"] as? [String]), let victim = required.first else { return }
        var broken = first
        broken.removeValue(forKey: victim)
        let brokenPayload = try JSONSerialization.data(withJSONObject: broken)
        XCTAssertFalse(validator.validate(brokenPayload).isValid,
                       "\(command) validator is not armed — a payload missing required `\(victim)` still passed")
    }

    func testJobsListConforms() throws { try assertConforms("jobs list") }
    func testNoteShowConforms() throws { try assertConforms("note show") }
    func testGitStatusConforms() throws { try assertConforms("git status") }
}

/// The launch-time crash-leftover sweep is WIRED into the startup composition seam (`ConsoleLaunch`),
/// not merely defined on `PrivilegedFlow`. A stale per-flow dir from a previous session must be gone
/// after startup cleanup runs.
final class LaunchCleanupTests: XCTestCase {
    func testStartupCleanupRemovesStaleFlowDirectories() throws {
        let fm = FileManager.default
        let flowsRoot = TestSupport.tempDir("launch-flows").appendingPathComponent("flows")
        // Two leftover per-flow dirs, one carrying a (would-be signed) authorization artifact.
        let a = flowsRoot.appendingPathComponent(UUID().uuidString)
        let b = flowsRoot.appendingPathComponent(UUID().uuidString)
        try fm.createDirectory(at: a, withIntermediateDirectories: true)
        try fm.createDirectory(at: b, withIntermediateDirectories: true)
        try Data("{}".utf8).write(to: b.appendingPathComponent("authorization.json"))
        XCTAssertEqual((try? fm.contentsOfDirectory(atPath: flowsRoot.path))?.count, 2)

        ConsoleLaunch.performStartupCleanup(flowsRoot: flowsRoot)

        XCTAssertEqual((try? fm.contentsOfDirectory(atPath: flowsRoot.path))?.count ?? 0, 0,
                       "startup cleanup must remove every leftover flow dir")
        // Idempotent + tolerant of an absent root.
        ConsoleLaunch.performStartupCleanup(flowsRoot: flowsRoot.appendingPathComponent("does-not-exist"))
    }
}

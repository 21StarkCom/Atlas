import Foundation
import XCTest
@testable import ConsoleCore

final class PrivilegedOpDiscoveryRoutingTests: XCTestCase {
    // MARK: - Discovery is registry-driven (never a hardcoded list)

    func testAuthorizableSetIsDerivedFromRegistryPrivilege() throws {
        let bundle = try TestSupport.realBundle()
        let ops = AuthorizableOpSet.derive(from: bundle)
        // The real registry's privileged commands, discovered purely from `privilege == "privileged"`.
        XCTAssertTrue(ops.contains("git approve"))
        XCTAssertTrue(ops.contains("quarantine resolve"))
        XCTAssertTrue(ops.contains("purge"))
        // A shared read command must NOT be discovered.
        XCTAssertFalse(ops.contains("note show"))
        XCTAssertFalse(ops.contains("watch"))
    }

    // MARK: - operandSourceMapCoversAuthorizableOps (stale-entry guard)

    func testOperandSourceMapCoversAuthorizableOps() throws {
        let bundle = try TestSupport.realBundle()
        let ops = AuthorizableOpSet.derive(from: bundle)
        let mapped = Set(OperandSourceMap.production.keys)
        // Every discovered authorizable op has a source-map entry…
        XCTAssertEqual(ops, mapped, "OperandSourceMap must cover exactly the authorizableOps set")
        // …and no map entry names an op no longer in the set (stale-entry guard).
        for op in mapped { XCTAssertTrue(ops.contains(op), "stale OperandSourceMap entry: \(op)") }
    }

    // MARK: - bind derives byte-identical export/authorize argv from ONE operand argv

    func testBindDerivesConsistentExportAndAuthorizeArgv() throws {
        let bundle = try TestSupport.realBundle()
        let router = OperationRouter(bundle: bundle)
        let inv = try router.bind("git approve", focus: FocusContext(fields: ["runId": PFx.runId]), entry: [:])
        XCTAssertEqual(inv.argv, ["git", "approve", PFx.runId, "--json"])
        // export = argv + --export-challenge; authorize = argv + --authorization <path>. Byte-identical
        // apart from the trailing flag — the AuthorizeRetry "same argv" guarantee by construction.
        let authPath = URL(fileURLWithPath: "/tmp/authorization.json")
        XCTAssertEqual(inv.exportArgv, inv.argv + ["--export-challenge"])
        XCTAssertEqual(inv.authorizeArgv(authorizationPath: authPath), inv.argv + ["--authorization", "/tmp/authorization.json"])
        XCTAssertEqual(Array(inv.exportArgv.dropLast()), Array(inv.authorizeArgv(authorizationPath: authPath).dropLast(2)))
    }

    func testBindResolvesOperatorEntryFlagOperand() throws {
        let bundle = try TestSupport.realBundle()
        let router = OperationRouter(bundle: bundle)
        let inv = try router.bind(
            "quarantine resolve",
            focus: FocusContext(fields: ["opaqueId": "QITEM-1"]),
            entry: ["resolution": "release"]
        )
        XCTAssertEqual(inv.argv, ["quarantine", "resolve", "QITEM-1", "--resolution", "release", "--json"])
    }

    func testBindMissingRequiredPositionalThrows() throws {
        let bundle = try TestSupport.realBundle()
        let router = OperationRouter(bundle: bundle)
        XCTAssertThrowsError(try router.bind("git approve", focus: FocusContext(fields: [:]), entry: [:])) { err in
            guard case RoutingError.missingOperand(let op, let operand) = err else { return XCTFail("wrong error \(err)") }
            XCTAssertEqual(op, "git approve")
            XCTAssertEqual(operand, "runId")
        }
    }

    // MARK: - Flip a shared row to privileged: discovered AND bindable with a supplied map

    func testFlippedSharedRowIsDiscoveredAndBindable() throws {
        let root = try makeFlippedCheckout(flip: "note show")
        let bundle = try ContractBundle.resolve(fromAnchor: root)
        let ops = AuthorizableOpSet.derive(from: bundle)
        XCTAssertTrue(ops.contains("note show"), "the flipped shared row must be discovered as privileged")

        // The test supplies its OWN operand source map for the flipped op (the production map covers only
        // the real set); the router then binds a valid invocation.
        let router = OperationRouter(bundle: bundle, operandSourceMap: ["note show": ["id-or-slug": .init(.operatorEntry)]])
        let inv = try router.bind("note show", focus: FocusContext(), entry: ["id-or-slug": "my-note"])
        XCTAssertEqual(inv.argv, ["note", "show", "my-note", "--json"])
        XCTAssertEqual(inv.exportArgv, inv.argv + ["--export-challenge"])

        // A discovered privileged op with NO descriptor (absent from the supplied map) fails fast into the
        // unsupported-privileged-command surface — never a half-built invocation.
        XCTAssertNil(router.descriptor(for: "git approve"))
        XCTAssertThrowsError(try router.bind("git approve", focus: FocusContext(), entry: [:])) { err in
            guard case RoutingError.unsupportedPrivilegedCommand(let op) = err else { return XCTFail("wrong error \(err)") }
            XCTAssertEqual(op, "git approve")
        }
    }

    // MARK: - Exit-6 backstop: an un-pre-classified op routes into Export via its exact argv

    func testExit6BackstopReusesExactArgvNoMembershipList() async throws {
        // A command the Console did NOT pre-classify as privileged (registry says shared) returns exit 6.
        // The caller wraps the exact argv it ran into a BoundInvocation and enters the flow — no
        // descriptor, no membership list. Here the refused op is `note show` (shared).
        let root = PrivFlowKit.flowsRoot()
        let runner = PrivRunner(export: [SpawnResult(exitCode: 6, stdout: PFx.challenge(["op": "note show"]), stderr: Data())])
        let flow = try PrivFlowKit.make(runner: runner, flowsRoot: root)
        let refused = BoundInvocation(op: "note show", argv: ["note", "show", "my-note", "--json"])
        await flow.handleExit6(refused: refused, envelope: ErrorEnvelope(code: "authorization-required", message: "auth", hint: "", retryable: false))

        // It entered Export → Display (challenge minted), reusing the exact argv (+ --export-challenge).
        if case .display = await flow.state {} else { XCTFail("expected Display, got \(await flow.state)") }
        let exportCall = runner.calls(for: .export).first
        XCTAssertEqual(exportCall?.arguments.prefix(5).map { $0 },
                       ["note", "show", "my-note", "--json", "--export-challenge"])
    }

    // MARK: - Every production privileged op binds its COMPLETE argv (booleans + required/cardinality)

    func testEveryProductionPrivilegedOpBindsCompleteArgv() throws {
        let bundle = try TestSupport.realBundle()
        let router = OperationRouter(bundle: bundle)
        func argv(_ op: String, _ focus: [String: String] = [:], _ entry: [String: String] = [:]) throws -> [String] {
            try router.bind(op, focus: FocusContext(fields: focus), entry: entry).argv
        }

        // Simple required positionals.
        XCTAssertEqual(try argv("db restore", [:], ["backupRef": "BK-1"]), ["db", "restore", "BK-1", "--json"])
        XCTAssertEqual(try argv("git approve", ["runId": PFx.runId]), ["git", "approve", PFx.runId, "--json"])
        XCTAssertEqual(try argv("git rollback", ["runId": PFx.runId]), ["git", "rollback", PFx.runId, "--json"])
        XCTAssertEqual(try argv("source trust promote", ["sourceId": "SRC-1"]), ["source", "trust", "promote", "SRC-1", "--json"])
        XCTAssertEqual(try argv("source trust revoke", ["sourceId": "SRC-1"]), ["source", "trust", "revoke", "SRC-1", "--json"])

        // graduation migrate: exactly one boolean direction — NEVER a preview (the finding).
        XCTAssertEqual(try argv("graduation migrate", [:], ["apply": "true"]), ["graduation", "migrate", "--apply", "--json"])
        XCTAssertEqual(try argv("graduation migrate", [:], ["rollback": "true"]), ["graduation", "migrate", "--rollback", "--json"])

        // purge: exactly one selector + the Console-pinned --apply — NEVER a preview (the finding).
        XCTAssertEqual(try argv("purge", [:], ["note": "N-1"]), ["purge", "--apply", "--note", "N-1", "--json"])
        XCTAssertEqual(try argv("purge", [:], ["source": "S-1"]), ["purge", "--apply", "--source", "S-1", "--json"])
        XCTAssertEqual(try argv("purge", [:], ["data-category": "PII"]), ["purge", "--apply", "--data-category", "PII", "--json"])
        XCTAssertTrue(try argv("purge", [:], ["note": "N-1"]).contains("--apply"))

        // quarantine inspect: --reveal is REACHABLE (the finding) and optional.
        XCTAssertEqual(try argv("quarantine inspect", ["opaqueId": "Q-1"]), ["quarantine", "inspect", "Q-1", "--json"])
        XCTAssertEqual(try argv("quarantine inspect", ["opaqueId": "Q-1"], ["reveal": "true"]),
                       ["quarantine", "inspect", "Q-1", "--reveal", "--json"])

        // quarantine resolve: --resolution is REQUIRED.
        XCTAssertEqual(try argv("quarantine resolve", ["opaqueId": "Q-1"], ["resolution": "discard"]),
                       ["quarantine", "resolve", "Q-1", "--resolution", "discard", "--json"])
    }

    func testRequiredResolutionCannotBeOmitted() throws {
        let router = OperationRouter(bundle: try TestSupport.realBundle())
        XCTAssertThrowsError(try router.bind("quarantine resolve", focus: FocusContext(fields: ["opaqueId": "Q-1"]), entry: [:])) { err in
            guard case RoutingError.missingOperand(_, let operand) = err else { return XCTFail("wrong error \(err)") }
            XCTAssertEqual(operand, "resolution")
        }
    }

    func testCardinalityViolationsThrow() throws {
        let router = OperationRouter(bundle: try TestSupport.realBundle())
        // graduation migrate: neither direction.
        XCTAssertThrowsError(try router.bind("graduation migrate", focus: FocusContext(), entry: [:])) { err in
            guard case RoutingError.cardinality(_, let group, let present) = err else { return XCTFail("wrong \(err)") }
            XCTAssertEqual(group, "direction"); XCTAssertTrue(present.isEmpty)
        }
        // graduation migrate: BOTH directions.
        XCTAssertThrowsError(try router.bind("graduation migrate", focus: FocusContext(), entry: ["apply": "true", "rollback": "true"])) { err in
            guard case RoutingError.cardinality(_, _, let present) = err else { return XCTFail("wrong \(err)") }
            XCTAssertEqual(present, ["apply", "rollback"])
        }
        // purge: no selector.
        XCTAssertThrowsError(try router.bind("purge", focus: FocusContext(), entry: [:])) { err in
            guard case RoutingError.cardinality(_, let group, _) = err else { return XCTFail("wrong \(err)") }
            XCTAssertEqual(group, "selector")
        }
        // purge: two selectors.
        XCTAssertThrowsError(try router.bind("purge", focus: FocusContext(), entry: ["note": "N", "source": "S"])) { err in
            guard case RoutingError.cardinality = err else { return XCTFail("wrong \(err)") }
        }
    }

    // MARK: - Bidirectional descriptor drift (mutated-schema)

    /// schema→map: a newly-added REQUIRED schema operand absent from the map ⇒ descriptor nil (fail-closed),
    /// never a half-built invocation missing the operand.
    func testAddedRequiredSchemaOperandNotInMapMakesDescriptorNil() throws {
        let root = try makeSchemaMutatedCheckout(schema: "git-approve.schema.json") { contract in
            var args = contract["args"] as? [[String: Any]] ?? []
            args.append(["arg": "<extraTarget>", "type": "string", "required": true, "description": "new required operand"])
            contract["args"] = args
        }
        let bundle = try ContractBundle.resolve(fromAnchor: root)
        let router = OperationRouter(bundle: bundle) // production map lacks `extraTarget`
        XCTAssertNil(router.descriptor(for: "git approve"), "an unmapped required schema operand must fail closed")
        XCTAssertThrowsError(try router.bind("git approve", focus: FocusContext(fields: ["runId": PFx.runId]), entry: [:])) { err in
            guard case RoutingError.unsupportedPrivilegedCommand = err else { return XCTFail("wrong \(err)") }
        }
    }

    /// map→schema: a map entry naming an operand the schema no longer declares ⇒ descriptor nil.
    func testStaleMapEntryNamingUnknownOperandMakesDescriptorNil() throws {
        let bundle = try TestSupport.realBundle()
        let router = OperationRouter(bundle: bundle, operandSourceMap: [
            "git approve": ["runId": .init(.focusedObject("runId")), "ghost": .init(.operatorEntry, .optional)],
        ])
        XCTAssertNil(router.descriptor(for: "git approve"), "a map entry for a non-schema operand must fail closed")
    }

    /// A SHARED command (registry `privilege != "privileged"`) is NEVER routable through the privileged
    /// flow, even if a map entry is supplied — the descriptor authority is the registry, not the map.
    func testSharedCommandIsNeverRoutableEvenWithAMapEntry() throws {
        let bundle = try TestSupport.realBundle()
        // `note show` is shared in the real registry; supply a perfectly-valid map entry for it.
        let router = OperationRouter(bundle: bundle, operandSourceMap: ["note show": ["id-or-slug": .init(.operatorEntry)]])
        XCTAssertNil(router.descriptor(for: "note show"), "a shared command must not get a privileged descriptor")
        XCTAssertThrowsError(try router.bind("note show", focus: FocusContext(), entry: ["id-or-slug": "x"])) { err in
            guard case RoutingError.unsupportedPrivilegedCommand = err else { return XCTFail("wrong \(err)") }
        }
    }

    /// schema→map exact equality: an OPTIONAL schema operand (a non-required flag) absent from the map
    /// ⇒ descriptor nil. The prior required-only check would have silently omitted it.
    func testOptionalSchemaOperandNotInMapMakesDescriptorNil() throws {
        let bundle = try TestSupport.realBundle()
        // `quarantine inspect` declares {opaqueId, reveal}; a map omitting the optional `reveal` must fail
        // closed — never silently drop the boolean switch.
        let router = OperationRouter(bundle: bundle, operandSourceMap: [
            "quarantine inspect": ["opaqueId": .init(.focusedObject("opaqueId"))],
        ])
        XCTAssertNil(router.descriptor(for: "quarantine inspect"),
                     "an unmapped optional schema operand must fail closed (exact equality)")
    }

    // MARK: - helpers

    /// Copy the real cli-contract dir into a fixture checkout and mutate one schema's `x-atlas-contract`.
    private func makeSchemaMutatedCheckout(schema: String, _ mutate: (inout [String: Any]) -> Void) throws -> URL {
        let root = try TestSupport.makeFixtureCheckout()
        let url = root.appendingPathComponent("docs/specs/cli-contract/\(schema)")
        var obj = try JSONSerialization.jsonObject(with: Data(contentsOf: url)) as! [String: Any]
        var contract = obj["x-atlas-contract"] as! [String: Any]
        mutate(&contract)
        obj["x-atlas-contract"] = contract
        try JSONSerialization.data(withJSONObject: obj).write(to: url)
        return root
    }

    /// Copy the real cli-contract dir into a fixture checkout, flipping one shared command's `privilege`
    /// to `privileged` in commands.json.
    private func makeFlippedCheckout(flip: String) throws -> URL {
        let root = try TestSupport.makeFixtureCheckout()
        let commandsURL = root.appendingPathComponent("docs/specs/cli-contract/commands.json")
        var obj = try JSONSerialization.jsonObject(with: Data(contentsOf: commandsURL)) as! [String: Any]
        var rows = obj["commands"] as! [[String: Any]]
        for i in rows.indices where rows[i]["name"] as? String == flip {
            rows[i]["privilege"] = "privileged"
        }
        obj["commands"] = rows
        try JSONSerialization.data(withJSONObject: obj).write(to: commandsURL)
        return root
    }
}

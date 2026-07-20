import XCTest
@testable import ConsoleCore

final class ContractBundleResolutionTests: XCTestCase {
    let runner = SystemProcessRunner()
    let fastProbe: Duration = .seconds(3)

    func testResolveFromAnchorBindsAtDistBinJsNotLauncher() throws {
        let root = try TestSupport.makeFixtureCheckout()
        let binJs = root.appendingPathComponent("apps/cli/dist/bin.js")
        let bundle = try ContractBundle.resolve(fromAnchor: binJs)
        XCTAssertEqual(bundle.checkoutRoot.standardizedFileURL.path, root.standardizedFileURL.path)
        XCTAssertFalse(bundle.commands.isEmpty)
        XCTAssertNotNil(bundle.schema(for: "db status"))
        XCTAssertFalse(bundle.watchSchema.isEmpty)
    }

    func testAnchorWithoutCommandsJsonThrows() {
        let empty = TestSupport.tempDir("no-bundle")
        XCTAssertThrowsError(try ContractBundle.resolve(fromAnchor: empty)) { err in
            guard let b = err as? BlockingResolutionError else { return XCTFail("wrong error \(err)") }
            XCTAssertFalse(b.remediation.isEmpty)
        }
    }

    func testRepoLayoutBrainBindsBundleAtBinJsAndProbesGreen() async throws {
        let root = try TestSupport.makeFixtureCheckout()
        let binJs = root.appendingPathComponent("apps/cli/dist/bin.js")
        let binDir = TestSupport.tempDir("path-bin")
        let nodeAbs = try TestSupport.writeJSONEmitter(binDir, name: "node", json: try TestSupport.dbStatusExampleJSON())
        let env = ["PATH": binDir.path]
        let resolved = try await BinaryResolution.resolve(
            .brain,
            inputs: ResolutionInputs(atlasRoot: root.path),
            env: env, runner: runner, probeTimeout: fastProbe
        )
        XCTAssertEqual(resolved.launch, [nodeAbs, binJs.path], "launch = node + bin.js, node absolute")
        XCTAssertEqual(resolved.contractAnchor.standardizedFileURL.path, binJs.standardizedFileURL.path, "anchor is bin.js, not the node launcher")
        XCTAssertEqual(resolved.bundle.checkoutRoot.standardizedFileURL.path, root.standardizedFileURL.path)
        XCTAssertEqual(resolved.baseEnv[ResolutionEnv.atlasRoot], root.path)
    }

    func testSignerOverrideOutsideCheckoutThrowsSameCheckoutMismatch() async throws {
        let root = try TestSupport.makeFixtureCheckout()
        let brainAnchor = root.appendingPathComponent("apps/cli/dist/bin.js")
        // A signer OUTSIDE the brain-bound checkout.
        let outside = TestSupport.tempDir("outside-signer")
        let outsideSigner = try TestSupport.writeSigner(outside)
        do {
            _ = try await BinaryResolution.resolve(
                .signer,
                inputs: ResolutionInputs(atlasRoot: root.path, signerPathOverride: outsideSigner),
                env: [:], runner: runner, brainAnchor: brainAnchor, probeTimeout: fastProbe
            )
            XCTFail("expected same-checkout mismatch")
        } catch let b as BlockingResolutionError {
            XCTAssertTrue(b.remediation.contains("outside the brain-bound contract checkout"), b.remediation)
            XCTAssertTrue(b.path.contains("signer"), b.path)
        }
    }

    func testSignerInsideCheckoutResolves() async throws {
        let root = try TestSupport.makeFixtureCheckout()
        let brainAnchor = root.appendingPathComponent("apps/cli/dist/bin.js")
        let signer = try TestSupport.writeDefaultSigner(root) // <checkout>/console/signer/.build/release/atlas-signer
        let resolved = try await BinaryResolution.resolve(
            .signer,
            inputs: ResolutionInputs(atlasRoot: root.path),
            env: [:], runner: runner, brainAnchor: brainAnchor, probeTimeout: fastProbe
        )
        XCTAssertEqual(resolved.launch, [signer])
        XCTAssertEqual(resolved.bundle.checkoutRoot.standardizedFileURL.path, root.standardizedFileURL.path)
        // contractAnchor is the brain-derived anchor (same checkout as the bundle), not the signer path.
        XCTAssertEqual(resolved.contractAnchor.standardizedFileURL.path, brainAnchor.standardizedFileURL.path)
    }

    /// A brain from checkout A + a signer/atlasRoot from checkout B must be rejected: the signer's
    /// checkout is derived EXCLUSIVELY from the brain's contractAnchor, so an `atlasRoot` pointing at a
    /// different checkout cannot smuggle in a foreign signer.
    func testMixedRootBrainAndSignerRejected() async throws {
        let checkoutA = try TestSupport.makeFixtureCheckout()
        let checkoutB = try TestSupport.makeFixtureCheckout()
        // brain is bound to checkout A.
        let brainAnchor = checkoutA.appendingPathComponent("apps/cli/dist/bin.js")
        // A perfectly good in-B signer — but B is NOT the brain's checkout.
        let consoleB = checkoutB.appendingPathComponent("console")
        try FileManager.default.createDirectory(at: consoleB, withIntermediateDirectories: true)
        let signerB = try TestSupport.writeSigner(consoleB)
        do {
            _ = try await BinaryResolution.resolve(
                .signer,
                // atlasRoot points at B, signer lives in B — but the brainAnchor (A) governs.
                inputs: ResolutionInputs(atlasRoot: checkoutB.path, signerPathOverride: signerB),
                env: [:], runner: runner, brainAnchor: brainAnchor, probeTimeout: fastProbe
            )
            XCTFail("expected cross-checkout mismatch — signer from B must not pair with brain from A")
        } catch let b as BlockingResolutionError {
            XCTAssertTrue(b.remediation.contains("outside the brain-bound contract checkout"), b.remediation)
            XCTAssertTrue(b.remediation.contains(checkoutA.standardizedFileURL.lastPathComponent), "names the brain checkout A: \(b.remediation)")
            XCTAssertTrue(b.path.contains(checkoutB.standardizedFileURL.lastPathComponent), "names the offending signer path in B: \(b.path)")
        }
    }

    /// Signer resolution with no `brainAnchor` is a blocking error, not a silent independent-root choice.
    func testSignerWithoutBrainAnchorIsBlocking() async {
        do {
            _ = try await BinaryResolution.resolve(
                .signer,
                inputs: ResolutionInputs(atlasRoot: "/tmp/whatever"),
                env: [:], runner: runner, probeTimeout: fastProbe
            )
            XCTFail("expected blocking without brainAnchor")
        } catch let b as BlockingResolutionError {
            XCTAssertTrue(b.remediation.contains("brainAnchor"), b.remediation)
        } catch { XCTFail("wrong error \(error)") }
    }

    /// A commands.json referencing a schema file that does not exist must fail the bundle closed.
    func testMissingReferencedSchemaFailsBundle() throws {
        let root = try TestSupport.makeFixtureCheckout()
        let cliContract = root.appendingPathComponent("docs/specs/cli-contract")
        let commandsURL = cliContract.appendingPathComponent("commands.json")
        // Append a row pointing at a schema that is not on disk.
        let data = try Data(contentsOf: commandsURL)
        var obj = try JSONSerialization.jsonObject(with: data) as! [String: Any]
        var rows = obj["commands"] as! [[String: Any]]
        rows.append([
            "name": "zzz phantom",
            "phase": "1",
            "privilege": "read",
            "idempotency": "idempotent",
            "implemented": true,
            "schemaRef": "docs/specs/cli-contract/zzz-phantom.schema.json"
        ])
        obj["commands"] = rows
        try JSONSerialization.data(withJSONObject: obj).write(to: commandsURL)

        XCTAssertThrowsError(try ContractBundle.resolve(fromAnchor: root)) { err in
            guard let b = err as? BlockingResolutionError else { return XCTFail("wrong error \(err)") }
            XCTAssertTrue(b.path.contains("zzz-phantom.schema.json"), b.path)
            XCTAssertTrue(b.remediation.contains("missing") || b.remediation.contains("unreadable"), b.remediation)
        }
    }

    /// A referenced schema present but lacking x-atlas-contract.executionClass must fail the bundle closed.
    func testSchemaMissingExecutionClassFailsBundle() throws {
        let root = try TestSupport.makeFixtureCheckout()
        let cliContract = root.appendingPathComponent("docs/specs/cli-contract")
        let commandsURL = cliContract.appendingPathComponent("commands.json")
        let phantomSchema = cliContract.appendingPathComponent("zzz-noexec.schema.json")
        // A syntactically valid schema with NO x-atlas-contract.executionClass.
        try TestSupport.json(["type": "object"]).write(to: phantomSchema)
        let data = try Data(contentsOf: commandsURL)
        var obj = try JSONSerialization.jsonObject(with: data) as! [String: Any]
        var rows = obj["commands"] as! [[String: Any]]
        rows.append([
            "name": "zzz noexec",
            "phase": "1",
            "privilege": "read",
            "idempotency": "idempotent",
            "implemented": true,
            "schemaRef": "docs/specs/cli-contract/zzz-noexec.schema.json"
        ])
        obj["commands"] = rows
        try JSONSerialization.data(withJSONObject: obj).write(to: commandsURL)

        XCTAssertThrowsError(try ContractBundle.resolve(fromAnchor: root)) { err in
            guard let b = err as? BlockingResolutionError else { return XCTFail("wrong error \(err)") }
            XCTAssertTrue(b.remediation.contains("executionClass"), b.remediation)
        }
    }
}

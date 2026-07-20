import XCTest
@testable import ConsoleCore

final class NodeResolutionTests: XCTestCase {
    let runner = SystemProcessRunner()

    func testResolveOnPathFindsAbsoluteNode() throws {
        let binDir = TestSupport.tempDir("node-bin")
        let nodeAbs = try TestSupport.writeScript(binDir, name: "node", body: "exit 0\n")
        let resolved = BinaryResolution.resolveOnPath("node", env: ["PATH": binDir.path])
        XCTAssertEqual(resolved, nodeAbs)
        XCTAssertTrue(resolved!.hasPrefix("/"), "resolved node is absolute")
    }

    func testRepoLayoutResolvesNodeWithRealRunner() async throws {
        // Real SystemProcessRunner drives the probe; node is resolved to absolute via the request PATH.
        let root = try TestSupport.makeFixtureCheckout()
        let binJs = root.appendingPathComponent("apps/cli/dist/bin.js")
        let binDir = TestSupport.tempDir("node-bin")
        let nodeAbs = try TestSupport.writeJSONEmitter(binDir, name: "node", json: try TestSupport.dbStatusExampleJSON())
        let resolved = try await BinaryResolution.resolve(
            .brain, inputs: ResolutionInputs(atlasRoot: root.path),
            env: ["PATH": binDir.path], runner: runner, probeTimeout: .seconds(3))
        XCTAssertEqual(resolved.launch, [nodeAbs, binJs.path])
    }

    func testNoNodeOnPathIsBlockingNamingSearchedPath() async throws {
        let root = try TestSupport.makeFixtureCheckout()
        let emptyBin = TestSupport.tempDir("empty-bin") // no node here
        do {
            _ = try await BinaryResolution.resolve(
                .brain, inputs: ResolutionInputs(atlasRoot: root.path),
                env: ["PATH": emptyBin.path], runner: runner, probeTimeout: .seconds(3))
            XCTFail("expected blocking (no node)")
        } catch let b as BlockingResolutionError {
            XCTAssertEqual(b.path, "node")
            XCTAssertTrue(b.remediation.contains(emptyBin.path), "names the searched PATH: \(b.remediation)")
        }
    }
}

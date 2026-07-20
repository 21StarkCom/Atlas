import XCTest
@testable import ConsoleCore

final class PathResolutionProbeTests: XCTestCase {
    let runner = SystemProcessRunner()
    let fastProbe: Duration = .seconds(3)

    /// Places a standalone `brain` inside the fixture checkout (so the bundle resolves from it).
    private func fixtureWithBrain(name: String = "brain") throws -> (root: URL, brain: String) {
        let root = try TestSupport.makeFixtureCheckout()
        let consoleDir = root.appendingPathComponent("console")
        try FileManager.default.createDirectory(at: consoleDir, withIntermediateDirectories: true)
        let brain = try TestSupport.writeRecordingBrain(consoleDir, name: name, json: try TestSupport.dbStatusExampleJSON())
        return (root, brain)
    }

    func testBrainOverrideSourceHitProbesGreenUsingDbStatus() async throws {
        let (_, brain) = try fixtureWithBrain()
        let resolved = try await BinaryResolution.resolve(
            .brain, inputs: ResolutionInputs(brainPathOverride: brain),
            env: [:], runner: runner, probeTimeout: fastProbe
        )
        XCTAssertEqual(resolved.launch, [brain])
        XCTAssertEqual(TestSupport.readArgv(brain), "db status --json", "probe uses the pure `db status`, not an audited read")
    }

    func testBrainEnvVarSourceHit() async throws {
        let (_, brain) = try fixtureWithBrain()
        let resolved = try await BinaryResolution.resolve(
            .brain, inputs: ResolutionInputs(),
            env: [ResolutionEnv.brainPath: brain], runner: runner, probeTimeout: fastProbe
        )
        XCTAssertEqual(resolved.launch, [brain])
    }

    func testMissingBrainOverrideIsBlockingNamingPath() async {
        let missing = "/nonexistent/path/brain-xyz"
        do {
            _ = try await BinaryResolution.resolve(
                .brain, inputs: ResolutionInputs(brainPathOverride: missing),
                env: [:], runner: runner, probeTimeout: fastProbe)
            XCTFail("expected blocking")
        } catch let b as BlockingResolutionError {
            XCTAssertTrue(b.path.contains("brain-xyz"), b.path)
        } catch { XCTFail("wrong \(error)") }
    }

    func testNonExecutableBrainIsBlocking() async throws {
        let root = try TestSupport.makeFixtureCheckout()
        let consoleDir = root.appendingPathComponent("console")
        try FileManager.default.createDirectory(at: consoleDir, withIntermediateDirectories: true)
        let plain = consoleDir.appendingPathComponent("brain")
        try "not executable".write(to: plain, atomically: true, encoding: .utf8) // no +x
        do {
            _ = try await BinaryResolution.resolve(
                .brain, inputs: ResolutionInputs(brainPathOverride: plain.path),
                env: [:], runner: runner, probeTimeout: fastProbe)
            XCTFail("expected blocking")
        } catch let b as BlockingResolutionError {
            XCTAssertTrue(b.path.contains("brain"), b.path)
        }
    }

    func testProbeFailNoFallthrough() async throws {
        // Override brain probe-fails; a good env brain also set — must NOT fall through to it.
        let root = try TestSupport.makeFixtureCheckout()
        let consoleDir = root.appendingPathComponent("console")
        try FileManager.default.createDirectory(at: consoleDir, withIntermediateDirectories: true)
        let bad = try TestSupport.writeScript(consoleDir, name: "brain-bad", body: "exit 1\n")
        let good = try TestSupport.writeRecordingBrain(consoleDir, name: "brain-good", json: try TestSupport.dbStatusExampleJSON())
        do {
            _ = try await BinaryResolution.resolve(
                .brain, inputs: ResolutionInputs(brainPathOverride: bad),
                env: [ResolutionEnv.brainPath: good], runner: runner, probeTimeout: fastProbe)
            XCTFail("expected blocking, not fallthrough")
        } catch let b as BlockingResolutionError {
            XCTAssertTrue(b.path.contains("brain-bad"), "must name the failing override, not fall through: \(b.path)")
        }
    }

    func testHangingProbeHitsTimeout() async throws {
        let root = try TestSupport.makeFixtureCheckout()
        let consoleDir = root.appendingPathComponent("console")
        try FileManager.default.createDirectory(at: consoleDir, withIntermediateDirectories: true)
        let hang = try TestSupport.writeScript(consoleDir, name: "brain", body: "sleep 30\n")
        do {
            _ = try await BinaryResolution.resolve(
                .brain, inputs: ResolutionInputs(brainPathOverride: hang),
                env: [:], runner: runner, probeTimeout: .milliseconds(600))
            XCTFail("expected timeout blocking")
        } catch let b as BlockingResolutionError {
            XCTAssertTrue(b.remediation.contains("timed out"), b.remediation)
        }
    }

    /// The repo-layout default resolves the signer's real SwiftPM build product
    /// (`console/signer/.build/release/atlas-signer`), never the package directory.
    func testSignerDefaultResolvesBuildProductAndProbesPubkey() async throws {
        let root = try TestSupport.makeFixtureCheckout()
        let signer = try TestSupport.writeDefaultSigner(root)
        XCTAssertTrue(signer.hasSuffix("console/signer/.build/release/atlas-signer"), signer)
        let brainAnchor = root.appendingPathComponent("apps/cli/dist/bin.js")
        let resolved = try await BinaryResolution.resolve(
            .signer, inputs: ResolutionInputs(atlasRoot: root.path),
            env: [:], runner: runner, brainAnchor: brainAnchor, probeTimeout: fastProbe)
        XCTAssertEqual(resolved.launch, [signer])
        XCTAssertEqual(TestSupport.readArgv(signer), "pubkey")
    }

    /// The package DIRECTORY (`console/signer`) is not an executable — with no build product present,
    /// the default resolution must fail closed naming that path, never silently succeed.
    func testSignerDefaultWithoutBuildProductIsBlocking() async throws {
        let root = try TestSupport.makeFixtureCheckout()
        // Create the package dir but NOT the build product.
        try FileManager.default.createDirectory(
            at: root.appendingPathComponent("console/signer"), withIntermediateDirectories: true)
        let brainAnchor = root.appendingPathComponent("apps/cli/dist/bin.js")
        do {
            _ = try await BinaryResolution.resolve(
                .signer, inputs: ResolutionInputs(atlasRoot: root.path),
                env: [:], runner: runner, brainAnchor: brainAnchor, probeTimeout: fastProbe)
            XCTFail("expected blocking — package dir is not the executable")
        } catch let b as BlockingResolutionError {
            XCTAssertTrue(b.path.hasSuffix(".build/release/atlas-signer"), b.path)
        }
    }

    /// Env-var source hit: `ATLAS_SIGNER_PATH` inside the bound checkout resolves + probes green.
    func testSignerEnvVarSourceHit() async throws {
        let root = try TestSupport.makeFixtureCheckout()
        let consoleDir = root.appendingPathComponent("console")
        try FileManager.default.createDirectory(at: consoleDir, withIntermediateDirectories: true)
        let signer = try TestSupport.writeSigner(consoleDir, name: "atlas-signer-env")
        let brainAnchor = root.appendingPathComponent("apps/cli/dist/bin.js")
        let resolved = try await BinaryResolution.resolve(
            .signer, inputs: ResolutionInputs(atlasRoot: root.path),
            env: [ResolutionEnv.signerPath: signer], runner: runner,
            brainAnchor: brainAnchor, probeTimeout: fastProbe)
        XCTAssertEqual(resolved.launch, [signer])
        XCTAssertEqual(TestSupport.readArgv(signer), "pubkey")
    }

    /// Override source hit: `signerPathOverride` wins over env var and default.
    func testSignerOverrideSourceHit() async throws {
        let root = try TestSupport.makeFixtureCheckout()
        let consoleDir = root.appendingPathComponent("console")
        try FileManager.default.createDirectory(at: consoleDir, withIntermediateDirectories: true)
        let override = try TestSupport.writeSigner(consoleDir, name: "atlas-signer-override")
        let envSigner = try TestSupport.writeSigner(consoleDir, name: "atlas-signer-env")
        let brainAnchor = root.appendingPathComponent("apps/cli/dist/bin.js")
        let resolved = try await BinaryResolution.resolve(
            .signer, inputs: ResolutionInputs(atlasRoot: root.path, signerPathOverride: override),
            env: [ResolutionEnv.signerPath: envSigner], runner: runner,
            brainAnchor: brainAnchor, probeTimeout: fastProbe)
        XCTAssertEqual(resolved.launch, [override], "override wins over env var")
    }

    /// A probe-failing signer override must NOT fall through to a good env-var signer — it blocks,
    /// naming the failing override.
    func testSignerProbeFailNoFallthrough() async throws {
        let root = try TestSupport.makeFixtureCheckout()
        let consoleDir = root.appendingPathComponent("console")
        try FileManager.default.createDirectory(at: consoleDir, withIntermediateDirectories: true)
        let bad = try TestSupport.writeScript(consoleDir, name: "signer-bad", body: "exit 4\n")
        let good = try TestSupport.writeSigner(consoleDir, name: "signer-good")
        let brainAnchor = root.appendingPathComponent("apps/cli/dist/bin.js")
        do {
            _ = try await BinaryResolution.resolve(
                .signer, inputs: ResolutionInputs(atlasRoot: root.path, signerPathOverride: bad),
                env: [ResolutionEnv.signerPath: good], runner: runner,
                brainAnchor: brainAnchor, probeTimeout: fastProbe)
            XCTFail("expected blocking, not fallthrough")
        } catch let b as BlockingResolutionError {
            XCTAssertTrue(b.path.contains("signer-bad"), "must name the failing override, not fall through: \(b.path)")
        }
    }

    // Same-checkout enforcement must be symlink-aware: an in-checkout signer symlink whose target
    // lives in ANOTHER checkout defeats a lexical containment check. Canonicalizing both sides before
    // the containment test rejects it.
    func testSignerSymlinkToOtherCheckoutIsBlocking() async throws {
        let rootA = try TestSupport.makeFixtureCheckout()
        let rootB = try TestSupport.makeFixtureCheckout()
        let consoleA = rootA.appendingPathComponent("console")
        let consoleB = rootB.appendingPathComponent("console")
        try FileManager.default.createDirectory(at: consoleA, withIntermediateDirectories: true)
        try FileManager.default.createDirectory(at: consoleB, withIntermediateDirectories: true)
        // Real signer lives in checkout B.
        let realSigner = try TestSupport.writeSigner(consoleB, name: "atlas-signer")
        // A symlink inside checkout A points at it — lexically "within" A, physically in B.
        let link = consoleA.appendingPathComponent("atlas-signer")
        try FileManager.default.createSymbolicLink(atPath: link.path, withDestinationPath: realSigner)
        let brainAnchor = rootA.appendingPathComponent("apps/cli/dist/bin.js")
        do {
            _ = try await BinaryResolution.resolve(
                .signer, inputs: ResolutionInputs(atlasRoot: rootA.path, signerPathOverride: link.path),
                env: [:], runner: runner, brainAnchor: brainAnchor, probeTimeout: fastProbe)
            XCTFail("expected blocking — a symlink into another checkout must not pass same-checkout binding")
        } catch let b as BlockingResolutionError {
            XCTAssertTrue(b.path.contains("atlas-signer"), b.path)
        }
    }

    func testSignerProbeFailIsBlocking() async throws {
        let root = try TestSupport.makeFixtureCheckout()
        let consoleDir = root.appendingPathComponent("console")
        try FileManager.default.createDirectory(at: consoleDir, withIntermediateDirectories: true)
        // signer that exits nonzero on pubkey.
        let bad = try TestSupport.writeScript(consoleDir, name: "signer", body: "exit 4\n")
        let brainAnchor = root.appendingPathComponent("apps/cli/dist/bin.js")
        do {
            _ = try await BinaryResolution.resolve(
                .signer, inputs: ResolutionInputs(atlasRoot: root.path, signerPathOverride: bad),
                env: [:], runner: runner, brainAnchor: brainAnchor, probeTimeout: fastProbe)
            XCTFail("expected blocking")
        } catch let b as BlockingResolutionError {
            XCTAssertTrue(b.path.contains("signer"), b.path)
        }
    }
}

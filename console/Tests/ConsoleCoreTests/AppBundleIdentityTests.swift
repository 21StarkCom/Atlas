import XCTest
@testable import ConsoleCore

final class AppBundleIdentityTests: XCTestCase {
    /// Run assemble-app.sh from BOTH the repo root and console/, then assert the assembled bundle is
    /// well-formed and codesign-verifiable. Uses a shared relocated scratch dir so the second run is
    /// cached and avoids lock contention with the outer `swift test` build dir.
    func testAssembleFromBothCwds() async throws {
        let consoleRoot = TestSupport.consoleRoot()
        let repoRoot = TestSupport.checkoutRoot()
        let script = consoleRoot.appendingPathComponent("scripts/assemble-app.sh").path
        let scratch = TestSupport.tempDir("assemble-scratch")
        let runner = SystemProcessRunner()

        var env = ProcessInfo.processInfo.environment
        env["ATLAS_CONSOLE_SCRATCH"] = scratch.path

        for cwd in [repoRoot, consoleRoot] {
            let result = try await runner.run(SpawnRequest(
                executable: ["/bin/bash"],
                arguments: [script],
                cwd: cwd,
                environment: env,
                timeout: .seconds(600)
            ))
            XCTAssertEqual(result.exitCode, 0, "assemble from \(cwd.lastPathComponent) failed: \(String(decoding: result.stderr, as: UTF8.self))")

            let app = consoleRoot.appendingPathComponent(".build/AtlasConsole.app")
            XCTAssertTrue(FileManager.default.fileExists(atPath: app.path), "bundle exists at declared path")

            // Info.plist identity.
            let plistURL = app.appendingPathComponent("Contents/Info.plist")
            let plist = try PropertyListSerialization.propertyList(from: Data(contentsOf: plistURL), format: nil) as! [String: Any]
            XCTAssertEqual(plist["CFBundleIdentifier"] as? String, "com.atlas.console")
            XCTAssertEqual(plist["CFBundleExecutable"] as? String, "AtlasConsole")

            // Executable bit.
            let exe = app.appendingPathComponent("Contents/MacOS/AtlasConsole").path
            XCTAssertTrue(FileManager.default.isExecutableFile(atPath: exe), "executable bit set")

            // codesign verifies.
            let verify = try await runner.run(SpawnRequest(
                executable: ["/usr/bin/codesign"],
                arguments: ["--verify", "--strict", app.path],
                cwd: consoleRoot,
                environment: env,
                timeout: .seconds(60)
            ))
            XCTAssertEqual(verify.exitCode, 0, "codesign --verify failed: \(String(decoding: verify.stderr, as: UTF8.self))")
        }
    }
}

import XCTest
@testable import ConsoleCore

final class ModuleAcyclicityTests: XCTestCase {
    /// Parse `swift package dump-package` and assert the module graph is exactly
    /// ConsoleCore ← ConsoleUI ← AtlasConsole with no library→executable back-edge, and macOS 15.
    func testModuleGraphAndPlatform() async throws {
        let consoleRoot = TestSupport.consoleRoot()
        let scratch = TestSupport.tempDir("dump-scratch")
        let runner = SystemProcessRunner()
        let result = try await runner.run(SpawnRequest(
            executable: ["/usr/bin/swift"],
            arguments: ["package", "--scratch-path", scratch.path, "dump-package"],
            cwd: consoleRoot,
            environment: ProcessInfo.processInfo.environment
        ))
        XCTAssertEqual(result.exitCode, 0, "dump-package failed: \(String(decoding: result.stderr, as: UTF8.self))")

        let obj = try JSONSerialization.jsonObject(with: result.stdout) as! [String: Any]

        // Platform: macOS 15.
        let platforms = obj["platforms"] as! [[String: Any]]
        let macos = platforms.first { ($0["platformName"] as? String) == "macos" }
        XCTAssertEqual(macos?["version"] as? String, "15.0", "resolved platform must be macOS 15")

        // Targets → dependency names.
        let targets = obj["targets"] as! [[String: Any]]
        func deps(_ targetName: String) -> Set<String> {
            guard let t = targets.first(where: { ($0["name"] as? String) == targetName }) else { return [] }
            let raw = t["dependencies"] as? [[String: Any]] ?? []
            var names = Set<String>()
            for d in raw {
                for key in ["byName", "target", "product"] {
                    if let arr = d[key] as? [Any], let first = arr.first as? String { names.insert(first) }
                }
            }
            return names
        }

        XCTAssertTrue(deps("ConsoleUI").contains("ConsoleCore"), "ConsoleUI ← ConsoleCore")
        XCTAssertTrue(deps("AtlasConsole").contains("ConsoleUI"), "AtlasConsole ← ConsoleUI")

        // No library → executable back-edge.
        XCTAssertFalse(deps("ConsoleCore").contains("AtlasConsole"))
        XCTAssertFalse(deps("ConsoleCore").contains("ConsoleUI"), "ConsoleCore is a leaf")
        XCTAssertFalse(deps("ConsoleUI").contains("AtlasConsole"), "no library→executable back-edge")
    }
}

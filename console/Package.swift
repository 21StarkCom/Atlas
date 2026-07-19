// swift-tools-version:6.0
import PackageDescription

// Atlas Console — SwiftUI macOS app, one Swift Package, three targets.
// platforms: [.macOS(.v15)] — LSMinimumSystemVersion in the bundle plist does NOT raise
// SwiftPM's compilation deployment target; Phase 6 SwiftUI App/Observation/accessibility APIs need it.
// This package lives OUTSIDE the pnpm workspace globs — it is not a pnpm workspace.
let package = Package(
    name: "AtlasConsole",
    platforms: [.macOS(.v15)],
    products: [
        .library(name: "ConsoleCore", targets: ["ConsoleCore"]),
        .library(name: "ConsoleUI", targets: ["ConsoleUI"]),
        .executable(name: "AtlasConsole", targets: ["AtlasConsole"]),
    ],
    targets: [
        // All non-UI logic. Leaf of the module graph.
        .target(name: "ConsoleCore"),
        // SwiftUI views. Depends on ConsoleCore only.
        .target(name: "ConsoleUI", dependencies: ["ConsoleCore"]),
        // Assembles the .app. Depends on ConsoleUI (⇒ transitively ConsoleCore).
        .executableTarget(name: "AtlasConsole", dependencies: ["ConsoleUI"]),
        .testTarget(name: "ConsoleCoreTests", dependencies: ["ConsoleCore"]),
        .testTarget(name: "ConsoleUITests", dependencies: ["ConsoleUI"]),
    ]
)

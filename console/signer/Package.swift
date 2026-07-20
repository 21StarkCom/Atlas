// swift-tools-version:6.0
//
// atlas-signer — the standalone Secure-Enclave P-256 authorization signer (SP-3).
//
// Deliberately a SEPARATE SwiftPM package from `console/` (the Console app): the
// signer is the ONE component that touches the SE key, usable from the terminal
// with no GUI installed, and built ad-hoc from source (no Xcode, no .app bundle,
// no entitlements — CryptoKit's dataRepresentation blob custody needs none).
// Outside the pnpm workspace; CI does not build it (spec §6/§11) — the p256
// VERIFY path is CI-covered on the TypeScript side via software fixtures.
//
// `SignerCore` is the testable leaf (all non-OS logic + a protocol-abstracted
// signing backend so a software P-256 key substitutes for the enclave in tests);
// `atlas-signer` is the thin executable. macOS 15+, Swift 6 language mode.
import PackageDescription

let package = Package(
    name: "atlas-signer",
    platforms: [.macOS(.v15)],
    targets: [
        .target(
            name: "SignerCore",
            swiftSettings: [.swiftLanguageMode(.v6)]
        ),
        .executableTarget(
            name: "atlas-signer",
            dependencies: ["SignerCore"],
            swiftSettings: [.swiftLanguageMode(.v6)]
        ),
        .testTarget(
            name: "SignerCoreTests",
            dependencies: ["SignerCore"],
            resources: [.copy("Fixtures")],
            swiftSettings: [.swiftLanguageMode(.v6)]
        ),
    ]
)

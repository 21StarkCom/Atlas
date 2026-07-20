import Foundation
import XCTest
@testable import ConsoleCore

/// Locates paths relative to the repo checkout and the console package, from a test's `#filePath`.
enum TestSupport {
    /// The console package root (dir containing Package.swift), found by walking up from this file.
    static func consoleRoot(file: StaticString = #filePath) -> URL {
        var dir = URL(fileURLWithPath: "\(file)").deletingLastPathComponent()
        while dir.path != "/" {
            if FileManager.default.fileExists(atPath: dir.appendingPathComponent("Package.swift").path) {
                return dir
            }
            dir = dir.deletingLastPathComponent()
        }
        fatalError("could not locate console/ package root from \(file)")
    }

    /// The atlas checkout root (dir containing docs/specs/cli-contract/commands.json).
    static func checkoutRoot(file: StaticString = #filePath) -> URL {
        var dir = consoleRoot(file: file)
        while dir.path != "/" {
            if FileManager.default.fileExists(atPath: dir.appendingPathComponent("docs/specs/cli-contract/commands.json").path) {
                return dir
            }
            dir = dir.deletingLastPathComponent()
        }
        fatalError("could not locate atlas checkout root (docs/specs/cli-contract/commands.json) from \(file)")
    }

    static func cliContractDir(file: StaticString = #filePath) -> URL {
        checkoutRoot(file: file).appendingPathComponent("docs/specs/cli-contract")
    }

    /// The `atlas-signer` package's committed golden-vector challenge for a given
    /// `intendedEffect` kind (SP-3 #272 anchor). The Console's signer-contract tests
    /// source their example challenge from HERE — the same fixture the signer's own
    /// tests derive from the broker's `buildSigningPayload` — so upstream contract
    /// drift in the anchored SP-3 signer source breaks the Console gate. Returns the
    /// challenge object as a JSON string.
    static func signerGoldenChallenge(kind: String = "integrate", file: StaticString = #filePath) throws -> String {
        let url = checkoutRoot(file: file)
            .appendingPathComponent("console/signer/Tests/SignerCoreTests/Fixtures/signing-payload-vectors.json")
        let data = try Data(contentsOf: url)
        guard
            let obj = try JSONSerialization.jsonObject(with: data) as? [String: Any],
            let vectors = obj["vectors"] as? [[String: Any]],
            let vector = vectors.first(where: { ($0["kind"] as? String) == kind }),
            let challenge = vector["challenge"] as? [String: Any]
        else {
            throw NSError(domain: "TestSupport", code: 1, userInfo: [NSLocalizedDescriptionKey: "no \(kind) golden vector in the atlas-signer fixtures"])
        }
        let json = try JSONSerialization.data(withJSONObject: challenge)
        return String(decoding: json, as: UTF8.self)
    }

    static func contractSchema(_ name: String, file: StaticString = #filePath) throws -> Data {
        try Data(contentsOf: cliContractDir(file: file).appendingPathComponent(name))
    }

    /// The bound contract bundle for the real repo checkout.
    static func realBundle(file: StaticString = #filePath) throws -> ContractBundle {
        try ContractBundle.resolve(fromAnchor: checkoutRoot(file: file))
    }

    static func tempDir(_ label: String = "atlas-console-test") -> URL {
        let url = FileManager.default.temporaryDirectory
            .appendingPathComponent("\(label)-\(UUID().uuidString)", isDirectory: true)
        try? FileManager.default.createDirectory(at: url, withIntermediateDirectories: true)
        return url
    }

    /// Writes an executable shell script; returns its absolute path.
    @discardableResult
    static func writeScript(_ dir: URL, name: String, body: String) throws -> String {
        let url = dir.appendingPathComponent(name)
        try ("#!/bin/sh\n" + body).write(to: url, atomically: true, encoding: .utf8)
        try FileManager.default.setAttributes([.posixPermissions: 0o755], ofItemAtPath: url.path)
        return url.path
    }

    static func json(_ value: Any) -> Data {
        (try? JSONSerialization.data(withJSONObject: value)) ?? Data()
    }

    /// Build a fixture atlas checkout: real cli-contract dir + a fake apps/cli/dist/bin.js.
    static func makeFixtureCheckout(file: StaticString = #filePath) throws -> URL {
        let root = tempDir("fixture-checkout")
        let destSpecs = root.appendingPathComponent("docs/specs")
        try FileManager.default.createDirectory(at: destSpecs, withIntermediateDirectories: true)
        try FileManager.default.copyItem(at: cliContractDir(file: file), to: destSpecs.appendingPathComponent("cli-contract"))
        let dist = root.appendingPathComponent("apps/cli/dist")
        try FileManager.default.createDirectory(at: dist, withIntermediateDirectories: true)
        try "// fake bin.js\n".write(to: dist.appendingPathComponent("bin.js"), atomically: true, encoding: .utf8)
        return root
    }

    /// The db-status schema's first example, serialized — a probe-valid `brain db status --json` payload.
    static func dbStatusExampleJSON(file: StaticString = #filePath) throws -> String {
        let data = try contractSchema("db-status.schema.json", file: file)
        let obj = try JSONSerialization.jsonObject(with: data) as! [String: Any]
        let ex = (obj["examples"] as! [Any])[0]
        return String(decoding: try JSONSerialization.data(withJSONObject: ex), as: UTF8.self)
    }

    /// Escapes a string for embedding inside a single-quoted shell literal.
    private static func shSingleQuote(_ s: String) -> String {
        s.replacingOccurrences(of: "'", with: "'\\''")
    }

    /// A fake `node`/`brain` that prints the given JSON and exits 0, ignoring argv. Uses only shell
    /// builtins (printf) so it works even when PATH is restricted to the fixture bin dir.
    static func writeJSONEmitter(_ dir: URL, name: String, json: String) throws -> String {
        try writeScript(dir, name: name, body: "printf '%s\\n' '\(shSingleQuote(json))'\nexit 0\n")
    }

    /// A fake `atlas-signer` that prints a PEM on `pubkey`, else exits 2. Records argv to "<path>.argv".
    static func writeSigner(_ dir: URL, name: String = "signer") throws -> String {
        try writeScript(dir, name: name, body: """
        printf '%s\\n' "$*" > "$0.argv"
        if [ "$1" = "pubkey" ]; then
          printf -- '-----BEGIN PUBLIC KEY-----\\nMFkwEwYH\\n-----END PUBLIC KEY-----\\n'
          exit 0
        fi
        exit 2
        """)
    }

    /// Writes a fake `atlas-signer` at the repo-layout DEFAULT build-product path —
    /// `<root>/console/signer/.build/release/atlas-signer` — the real SwiftPM release product, NOT the
    /// `console/signer` package directory. Returns its absolute path.
    @discardableResult
    static func writeDefaultSigner(_ root: URL) throws -> String {
        let dir = root.appendingPathComponent(BinaryResolution.defaultSignerRelativePath).deletingLastPathComponent()
        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        return try writeSigner(dir, name: "atlas-signer")
    }

    /// A fake `brain` that records argv to "<path>.argv" then prints the JSON and exits 0 (builtins only).
    static func writeRecordingBrain(_ dir: URL, name: String, json: String) throws -> String {
        try writeScript(dir, name: name, body: "printf '%s\\n' \"$*\" > \"$0.argv\"\nprintf '%s\\n' '\(shSingleQuote(json))'\nexit 0\n")
    }

    static func readArgv(_ scriptPath: String) -> String {
        (try? String(contentsOf: URL(fileURLWithPath: scriptPath + ".argv"), encoding: .utf8))?
            .trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
    }
}

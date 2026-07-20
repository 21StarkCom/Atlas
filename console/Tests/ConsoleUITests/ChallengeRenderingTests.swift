import XCTest
import ConsoleCore
@testable import ConsoleUI

// P6-Task-2 — the challenge-display modal renders the full §7 set, control-safe and full-length.
final class ChallengeRenderingTests: XCTestCase {

    /// A challenge whose displayed fields embed raw C0/C1/ANSI-CSI/RTL-override glyphs + over-length text.
    private func hostileChallenge() throws -> AuthorizationChallenge {
        let ansi = "run\u{1B}[31m-danger\u{7F}"          // ESC-CSI + DEL
        let rtl = "safe\u{202E}reversed\u{202C}"         // RTL override + pop
        let longScope = String(repeating: "x", count: 5000)
        let json = try JSONSerialization.data(withJSONObject: [
            "schemaVersion": 1,
            "op": "git approve\u{0007}",                  // BEL
            "runId": "01ARZ3NDEKTSV4RRFFQ69G5FAV",
            "targetCommit": String(repeating: "a", count: 40),
            "canonicalBaseCommit": String(repeating: "b", count: 40),
            "intendedEffect": [
                "kind": ansi, "scope": longScope, "rtl": rtl,
                // Invisible-format smuggling: the TAG block (zero-width, encodes hidden ASCII — here
                // TAG a/l/l after a visible "notes") and a deprecated Cf format control. A committed
                // suffix hidden by either must surface as visible <U+XXXXX> tokens, never render-invisible.
                "tagged": "notes\u{E0061}\u{E006C}\u{E006C}",
                "deprecatedFormat": "on\u{206A}off",
            ],
            "nonce": String(repeating: "0", count: 32),
            "expiresAt": "2026-07-20T10:00:00.000Z",
            "payloadCanonicalization": "atlas-jcs-v1",
            "signingPayload": "payload-\(rtl)",
        ])
        return try JSONDecoder().decode(AuthorizationChallenge.self, from: json)
    }

    func testFullDisplaySetRenderedControlSafeAndUntruncated() throws {
        let c = try hostileChallenge()
        let fields = ChallengePresentation.fields(c)
        let labels = Set(fields.map(\.label))

        // The full §7 display set is present (incl. expiresAt + the signing-payload SHA-256).
        XCTAssertTrue(labels.contains("Operation"))
        XCTAssertTrue(labels.contains("Run"))
        XCTAssertTrue(labels.contains("Target commit"))
        XCTAssertTrue(labels.contains("Canonical base commit"))
        XCTAssertTrue(labels.contains("Expires at"))
        XCTAssertTrue(labels.contains("Payload canonicalization"))
        XCTAssertTrue(labels.contains("Signing payload SHA-256"))
        XCTAssertTrue(labels.contains(where: { $0.hasPrefix("Effect · ") }), "every intendedEffect field is shown")

        // The SHA-256 digest field carries a real sha256: hex.
        let digest = fields.first { $0.label == "Signing payload SHA-256" }!.value
        XCTAssertTrue(digest.hasPrefix("sha256:"))
        XCTAssertEqual(digest.count, "sha256:".count + 64)

        // No raw control byte reaches ANY rendered value; the escaped tokens are present instead.
        for field in fields {
            for scalar in field.value.unicodeScalars {
                let v = scalar.value
                XCTAssertFalse(v <= 0x1F || v == 0x7F || (v >= 0x80 && v <= 0x9F),
                               "control byte U+\(String(v, radix: 16)) leaked into '\(field.label)'")
                XCTAssertNotEqual(v, 0x202E, "RTL override leaked into '\(field.label)'")
            }
        }
        // The visible-escape tokens appear (ESC, DEL, BEL, RTL-override made visible).
        let all = fields.map(\.value).joined()
        XCTAssertTrue(all.contains("<U+001B>"), "ESC made visible")
        XCTAssertTrue(all.contains("<U+007F>"), "DEL made visible")
        XCTAssertTrue(all.contains("<U+202E>"), "RTL override made visible")
        // Category-based fail-closed classification: invisible Cf scalars an enumerated blocklist
        // would miss must also surface as tokens — a TAG-encoded hidden suffix must never render
        // invisibly next to the visible prefix it spoofs.
        XCTAssertTrue(all.contains("<U+E0061>"), "TAG block made visible (hidden-suffix smuggling)")
        XCTAssertTrue(all.contains("<U+206A>"), "deprecated Cf format control made visible")
        for field in fields {
            XCTAssertFalse(field.value.unicodeScalars.contains { $0.value >= 0xE0000 && $0.value <= 0xE007F },
                           "raw TAG scalar leaked into '\(field.label)'")
        }

        // Over-length values are shown IN FULL — never truncated.
        let scope = fields.first { $0.value.contains("xxxx") }!.value
        XCTAssertEqual(scope.filter { $0 == "x" }.count, 5000, "the 5000-char scope is rendered in full")
    }

    func testEmbeddedQuotesAndBackslashesCannotTerminateTheQuote() {
        // A value that tries to close its own quote and spoof a following "field".
        let hostile = #"real"} ,{"fake":"injected"#
        let rendered = String(ControlSafeText.render(hostile).characters)
        // The rendered string is wrapped in exactly one leading + trailing quote; every INNER quote is
        // backslash-escaped, so the value cannot visually terminate its quote.
        XCTAssertTrue(rendered.hasPrefix("\""))
        XCTAssertTrue(rendered.hasSuffix("\""))
        XCTAssertTrue(rendered.contains("\\\""), "embedded quote is escaped as \\\"")
        // Removing every escaped-quote pair, the interior holds NO bare double-quote.
        let interior = String(rendered.dropFirst().dropLast()).replacingOccurrences(of: "\\\"", with: "")
        XCTAssertFalse(interior.contains("\""), "no inner quote survives unescaped")
    }

    func testEmbeddedBackslashIsEscaped() {
        let rendered = ControlSafeText.plain(#"a\b"#)
        XCTAssertEqual(rendered, #"a\\b"#, "a literal backslash is doubled")
    }

    func testControlCharacterInIntendedEffectKeyIsEscapedInLabel() throws {
        // A hostile top-level intendedEffect KEY (not just a value) must be control-safe in its label.
        let json = try JSONSerialization.data(withJSONObject: [
            "schemaVersion": 1,
            "op": "git approve",
            "canonicalBaseCommit": String(repeating: "b", count: 40),
            "intendedEffect": ["ev\u{1B}il\u{202E}": "v", "kind": "integrate"],
            "nonce": String(repeating: "0", count: 32),
            "expiresAt": "2026-07-20T10:00:00.000Z",
            "payloadCanonicalization": "atlas-jcs-v1",
            "signingPayload": "p",
        ])
        let c = try JSONDecoder().decode(AuthorizationChallenge.self, from: json)
        let fields = ChallengePresentation.fields(c)
        for field in fields {
            for scalar in field.label.unicodeScalars {
                let v = scalar.value
                XCTAssertFalse(v <= 0x1F || v == 0x7F, "control byte leaked into label '\(field.label)'")
                XCTAssertNotEqual(v, 0x202E, "RTL override leaked into label '\(field.label)'")
            }
        }
        let all = fields.map(\.label).joined()
        XCTAssertTrue(all.contains("<U+001B>"), "hostile key's ESC made visible in the label")
        XCTAssertTrue(all.contains("<U+202E>"), "hostile key's RTL override made visible in the label")
    }

    func testRenderingIsDeterministicOverTheFrozenChallenge() throws {
        // The modal renders from a FROZEN in-memory representation (never re-reading challenge.json). The
        // rendering is therefore a pure function of that value — the byte-freeze itself is a PrivilegedFlow
        // guarantee (Phase 5); here we prove the display derivation is stable for equal inputs.
        let c = try hostileChallenge()
        XCTAssertEqual(ChallengePresentation.fields(c), ChallengePresentation.fields(c))
    }

    // MARK: - The bytes CONFIRMED are the bytes SIGNED (issue #253 mutation-after-confirm criterion)

    /// Drive a real PrivilegedFlow through Display, then MUTATE the on-disk `challenge.json` artifact
    /// before confirming, and assert the bytes piped to `atlas-signer sign` on stdin are byte-identical to
    /// the ORIGINALLY exported/displayed challenge — never the tampered file. This exercises the actual
    /// freeze-then-sign path (not a tautology): the flow reads the challenge once into frozen bytes at
    /// export, displays those, and pipes those same bytes on confirm regardless of any later disk mutation.
    func testMutatingChallengeArtifactAfterDisplayDoesNotChangeSignedBytes() async throws {
        let dir = UITestSupport.tempDir()
        let flowsRoot = UITestSupport.tempDir("atlas-console-flows")
        let original = UIChallenge.gitApprove()
        let runner = UIScriptedRunner(
            dir: dir,
            exportResults: [SpawnResult(exitCode: 6, stdout: original, stderr: Data())],
            signResults: [SpawnResult(exitCode: 0, stdout: Data("{}".utf8), stderr: Data())])
        let brain = try UITestSupport.binary()
        let router = OperationRouter(bundle: brain.bundle)
        let flow = try PrivilegedFlow(
            runner: runner, brain: brain, signer: brain, router: router,
            validator: SignerContractValidator(), configRoot: brain.bundle.checkoutRoot,
            flowsRoot: flowsRoot)

        await flow.begin(op: "git approve", focus: FocusContext(fields: ["runId": UIChallenge.runId]), entry: [:])
        // Reach Display.
        var reached = false
        for _ in 0..<200 {
            if case .display = await flow.state { reached = true; break }
            try? await Task.sleep(for: .milliseconds(25))
        }
        XCTAssertTrue(reached, "the flow reached Display")

        // Locate + TAMPER with the on-disk challenge.json under the per-flow temp dir.
        let fm = FileManager.default
        let challengeFiles = fm.enumerator(at: flowsRoot, includingPropertiesForKeys: nil)?
            .compactMap { $0 as? URL }.filter { $0.lastPathComponent == "challenge.json" } ?? []
        XCTAssertFalse(challengeFiles.isEmpty, "a challenge.json artifact was written")
        for f in challengeFiles {
            try Data(#"{"op":"tampered","malicious":true}"#.utf8).write(to: f)
        }

        // Confirm ⇒ sign. The stdin piped to the signer must be the ORIGINAL bytes, not the tampered file.
        await flow.confirm()
        XCTAssertEqual(runner.signStdins.first, original,
                       "the bytes signed are the displayed/frozen challenge — the disk mutation is ignored")
    }
}

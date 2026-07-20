import XCTest
import CryptoKit
@testable import SignerCore

/// A thread-safe capture buffer for the injected stdout/stderr sinks.
final class Buf: @unchecked Sendable {
    private let lock = NSLock()
    private var data = Data()
    func append(_ d: Data) { lock.lock(); data.append(d); lock.unlock() }
    var bytes: Data { lock.lock(); defer { lock.unlock() }; return data }
    var string: String { String(decoding: bytes, as: UTF8.self) }
    var isEmpty: Bool { bytes.isEmpty }
}

final class SignerCoreTests: XCTestCase {
    // A far-future fixed clock so the golden fixtures' expiresAt is always live.
    let liveClock: @Sendable () -> Date = { Date(timeIntervalSince1970: 0) } // 1970 — before the 2026 expiries

    func tempStoreDir() -> URL {
        let dir = FileManager.default.temporaryDirectory.appendingPathComponent("atlas-signer-test-\(UUID().uuidString)")
        return dir
    }

    struct Harness {
        let cli: SignerCLI
        let store: KeyStore
        let out: Buf
        let err: Buf
    }

    func makeHarness(stdin: Data = Data(), now: @escaping @Sendable () -> Date) -> Harness {
        let out = Buf(), err = Buf()
        let store = KeyStore(dir: tempStoreDir())
        let cli = SignerCLI(
            backend: SoftwareSigningBackend(),
            store: store,
            hostname: "testmac",
            now: now,
            readStdin: { stdin },
            writeStdout: { out.append($0) },
            writeStderr: { err.append(Data($0.utf8)) }
        )
        return Harness(cli: cli, store: store, out: out, err: err)
    }

    /// keygen with the software backend, returning the store seeded with a key.
    @discardableResult
    func seedKey(_ h: Harness, signerId: String? = nil) -> SignExit {
        var args = ["keygen"]
        if let signerId { args += ["--signer-id", signerId] }
        return h.cli.run(args)
    }

    // MARK: - Golden vectors (cross-implementation byte-identity)

    func loadVectors() throws -> [(kind: String, challenge: [String: Any], raw: Data)] {
        let url = try XCTUnwrap(Bundle.module.url(forResource: "signing-payload-vectors", withExtension: "json", subdirectory: "Fixtures"))
        let data = try Data(contentsOf: url)
        let obj = try XCTUnwrap(try JSONSerialization.jsonObject(with: data) as? [String: Any])
        let vectors = try XCTUnwrap(obj["vectors"] as? [[String: Any]])
        return try vectors.map { v in
            let kind = try XCTUnwrap(v["kind"] as? String)
            let ch = try XCTUnwrap(v["challenge"] as? [String: Any])
            let raw = try JSONSerialization.data(withJSONObject: ch)
            return (kind, ch, raw)
        }
    }

    func testGoldenVectorsRederiveByteIdentical() throws {
        let vectors = try loadVectors()
        XCTAssertEqual(vectors.count, 9, "all nine intendedEffect kinds must be covered")
        for v in vectors {
            let parsed = try ParsedChallenge(rawJSON: v.raw)
            let rederived = try SigningPayload.rederive(from: parsed.challenge)
            XCTAssertEqual(
                rederived, parsed.challenge.signingPayload,
                "\(v.kind): Swift re-derivation must byte-match the broker's buildSigningPayload"
            )
        }
    }

    // MARK: - Full sign flow

    /// The integrate golden vector as a challenge whose expiresAt is live under liveClock.
    func integrateChallenge() throws -> Data {
        let v = try loadVectors().first { $0.kind == "integrate" }!
        return v.raw
    }

    func testSignEmitsValidVerifiableResponse() throws {
        let raw = try integrateChallenge()
        let h = makeHarness(stdin: raw, now: liveClock)
        XCTAssertEqual(seedKey(h), .signed)
        // fresh harness for sign, same store
        let out = Buf(), err = Buf()
        let signCli = SignerCLI(
            backend: SoftwareSigningBackend(), store: h.store, hostname: "testmac",
            now: liveClock, readStdin: { raw }, writeStdout: { out.append($0) }, writeStderr: { err.append(Data($0.utf8)) }
        )
        let code = signCli.run(["sign"])
        XCTAssertEqual(code, .signed, "stderr: \(err.string)")

        // stdout is ONLY the response JSON; summary + digest on stderr.
        let resp = try XCTUnwrap(try JSONSerialization.jsonObject(with: out.bytes) as? [String: Any])
        XCTAssertEqual(resp["schemaVersion"] as? Int, 1)
        let sig = try XCTUnwrap(resp["signature"] as? String)
        XCTAssertTrue(sig.hasPrefix("p256:"), "signature must be p256: — got \(sig.prefix(12))")
        XCTAssertEqual(resp["signerId"] as? String, try h.store.loadConfig().signerId)
        XCTAssertTrue(err.string.contains("signingPayload sha256:"), "summary must show the payload digest on stderr")

        // The echoed challenge is byte-identical to the input (verbatim echo).
        let echoed = try XCTUnwrap(resp["challenge"] as? [String: Any])
        let inputCh = try XCTUnwrap(try JSONSerialization.jsonObject(with: raw) as? [String: Any])
        XCTAssertEqual(NSDictionary(dictionary: echoed), NSDictionary(dictionary: inputCh))

        // The p256 DER signature verifies over the signingPayload bytes.
        let pem = try h.store.loadConfig().publicKeyPem
        let pub = try P256.Signing.PublicKey(pemRepresentation: pem)
        let der = try XCTUnwrap(Base64URL.decode(String(sig.dropFirst("p256:".count))))
        let ecdsa = try P256.Signing.ECDSASignature(derRepresentation: der)
        let payload = Data((inputCh["signingPayload"] as! String).utf8)
        XCTAssertTrue(pub.isValidSignature(ecdsa, for: payload), "emitted signature must verify over signingPayload")
    }

    func testSignToOutFileLeavesStdoutEmpty() throws {
        let raw = try integrateChallenge()
        let h = makeHarness(stdin: raw, now: liveClock)
        XCTAssertEqual(seedKey(h), .signed)
        let outFile = FileManager.default.temporaryDirectory.appendingPathComponent("auth-\(UUID().uuidString).json")
        let out = Buf(), err = Buf()
        let signCli = SignerCLI(
            backend: SoftwareSigningBackend(), store: h.store, hostname: "testmac",
            now: liveClock, readStdin: { raw }, writeStdout: { out.append($0) }, writeStderr: { err.append(Data($0.utf8)) }
        )
        let code = signCli.run(["sign", "--out", outFile.path])
        XCTAssertEqual(code, .signed)
        XCTAssertTrue(out.isEmpty, "with --out, stdout MUST stay empty")
        XCTAssertTrue(FileManager.default.fileExists(atPath: outFile.path))
        let mode = try FileManager.default.attributesOfItem(atPath: outFile.path)[.posixPermissions] as? Int
        XCTAssertEqual(mode, 0o600, "the --out artifact must be 0600")
    }

    // MARK: - Exit codes

    func testEmptyStdinExit2() throws {
        let h = makeHarness(stdin: Data(), now: liveClock)
        XCTAssertEqual(seedKey(h), .signed)
        let out = Buf()
        let cli = SignerCLI(backend: SoftwareSigningBackend(), store: h.store, hostname: "t", now: liveClock,
                            readStdin: { Data() }, writeStdout: { out.append($0) }, writeStderr: { _ in })
        XCTAssertEqual(cli.run(["sign"]), .malformedChallenge)
        XCTAssertTrue(out.isEmpty, "stdout empty on failure")
    }

    func testMalformedChallengeExit2() throws {
        let h = makeHarness(now: liveClock)
        XCTAssertEqual(seedKey(h), .signed)
        let raw = Data(#"{"schemaVersion":1,"op":"git approve"}"#.utf8) // missing required fields
        let out = Buf()
        let cli = SignerCLI(backend: SoftwareSigningBackend(), store: h.store, hostname: "t", now: liveClock,
                            readStdin: { raw }, writeStdout: { out.append($0) }, writeStderr: { _ in })
        XCTAssertEqual(cli.run(["sign"]), .malformedChallenge)
        XCTAssertTrue(out.isEmpty)
    }

    func testRederiveMismatchExit2() throws {
        // Tamper signingPayload so it disagrees with the challenge's own fields.
        var ch = try XCTUnwrap(try JSONSerialization.jsonObject(with: integrateChallenge()) as? [String: Any])
        ch["signingPayload"] = "atlas.authz.v1\ngit approve\nTAMPERED"
        let raw = try JSONSerialization.data(withJSONObject: ch)
        let h = makeHarness(now: liveClock)
        XCTAssertEqual(seedKey(h), .signed)
        let out = Buf(), err = Buf()
        let cli = SignerCLI(backend: SoftwareSigningBackend(), store: h.store, hostname: "t", now: liveClock,
                            readStdin: { raw }, writeStdout: { out.append($0) }, writeStderr: { err.append(Data($0.utf8)) })
        XCTAssertEqual(cli.run(["sign"]), .malformedChallenge)
        XCTAssertTrue(out.isEmpty)
        XCTAssertTrue(err.string.contains("re-derived"), "must explain the payload mismatch")
    }

    func testExpiredChallengeExit3BeforePrompt() throws {
        let raw = try integrateChallenge() // expiresAt 2026-07-12
        let h = makeHarness(now: { Date(timeIntervalSince1970: 4_000_000_000) }) // year ~2096, well past
        XCTAssertEqual(seedKey(h), .signed)
        // A backend that FAILS if ever asked to sign — proves expiry is checked pre-prompt.
        let out = Buf()
        let cli = SignerCLI(backend: ExplodingBackend(), store: h.store, hostname: "t",
                            now: { Date(timeIntervalSince1970: 4_000_000_000) },
                            readStdin: { raw }, writeStdout: { out.append($0) }, writeStderr: { _ in })
        XCTAssertEqual(cli.run(["sign"]), .expired)
        XCTAssertTrue(out.isEmpty)
    }

    func testCancelledExit4() throws {
        let raw = try integrateChallenge()
        let store = KeyStore(dir: tempStoreDir())
        // seed with the software backend
        _ = SignerCLI(backend: SoftwareSigningBackend(), store: store, hostname: "t", now: liveClock,
                      readStdin: { Data() }, writeStdout: { _ in }, writeStderr: { _ in }).run(["keygen"])
        let out = Buf()
        let cli = SignerCLI(backend: CancellingBackend(), store: store, hostname: "t", now: liveClock,
                            readStdin: { raw }, writeStdout: { out.append($0) }, writeStderr: { _ in })
        XCTAssertEqual(cli.run(["sign"]), .cancelled)
        XCTAssertTrue(out.isEmpty)
    }

    func testKeyInvalidatedExit5() throws {
        let raw = try integrateChallenge()
        let store = KeyStore(dir: tempStoreDir())
        _ = SignerCLI(backend: SoftwareSigningBackend(), store: store, hostname: "t", now: liveClock,
                      readStdin: { Data() }, writeStdout: { _ in }, writeStderr: { _ in }).run(["keygen"])
        let out = Buf(), err = Buf()
        let cli = SignerCLI(backend: InvalidatedBackend(), store: store, hostname: "t", now: liveClock,
                            readStdin: { raw }, writeStdout: { out.append($0) }, writeStderr: { err.append(Data($0.utf8)) })
        XCTAssertEqual(cli.run(["sign"]), .keyInvalidated)
        XCTAssertTrue(out.isEmpty)
    }

    // MARK: - Control-safe rendering

    func testHostileFieldRendersControlSafe() throws {
        // A challenge whose scope carries ESC/CR/NL — the summary must show them
        // as <U+XXXX> tokens, never raw bytes that could rewrite the layout.
        let hostileScope = "note:\u{1B}[2Kx\r\ninjected"
        let base = "b7e23c9d4a1f6082e5c3d90a1b2c3d4e5f607182"
        let ch: [String: Any] = [
            "schemaVersion": 1, "op": "purge", "canonicalBaseCommit": base,
            "intendedEffect": ["kind": "erase", "oldHead": base, "replacementHead": base, "scope": hostileScope],
            "nonce": "9c1f7b2e4d6a8c0e1f3b5d7a9c1e2f40",
            "expiresAt": "2026-07-12T09:19:22.581Z", "payloadCanonicalization": "atlas-jcs-v1",
            "signingPayload": "x",
        ]
        let raw = try JSONSerialization.data(withJSONObject: ch)
        let parsed = try ParsedChallenge(rawJSON: raw)
        let summary = ApprovalSummary(challenge: parsed.challenge, signerId: "approver-se-testmac-v1")
        XCTAssertFalse(summary.text.contains("\u{1B}"), "no raw ESC in the rendered summary")
        XCTAssertFalse(summary.text.contains("\r"), "no raw CR in the rendered summary")
        XCTAssertTrue(summary.text.contains("<U+001B>"), "ESC must render as a visible token")
        XCTAssertTrue(summary.text.contains("<U+000D>") && summary.text.contains("<U+000A>"), "CR/LF visible")
        // The line count is stable — the injected NL cannot add a summary line.
        XCTAssertFalse(summary.lines.contains { $0.contains("injected") && !$0.contains("<U+") })
    }

    // MARK: - keygen / pubkey

    func testKeygenWritesConfigAndRefusesOverwrite() throws {
        let h = makeHarness(now: liveClock)
        XCTAssertEqual(h.cli.run(["keygen"]), .signed)
        let cfg = try h.store.loadConfig()
        XCTAssertEqual(cfg.signerId, "approver-se-testmac-v1")
        XCTAssertEqual(cfg.accessPolicy, "biometryCurrentSet")
        XCTAssertTrue(cfg.publicKeyPem.contains("BEGIN PUBLIC KEY"))
        XCTAssertTrue(h.out.string.contains("BEGIN PUBLIC KEY"), "PEM to stdout")
        XCTAssertTrue(h.err.string.contains("enroll-signer.sh"), "enroll runbook to stderr")
        // config.json is 0600
        let mode = try FileManager.default.attributesOfItem(atPath: h.store.configPath.path)[.posixPermissions] as? Int
        XCTAssertEqual(mode, 0o600)
        // refuse overwrite without --force
        let h2 = SignerCLI(backend: SoftwareSigningBackend(), store: h.store, hostname: "testmac", now: liveClock,
                           readStdin: { Data() }, writeStdout: { _ in }, writeStderr: { _ in })
        XCTAssertEqual(h2.run(["keygen"]), .internalFault)
    }

    func testKeygenForceBumpsVersion() throws {
        let h = makeHarness(now: liveClock)
        XCTAssertEqual(h.cli.run(["keygen"]), .signed) // v1
        let forced = SignerCLI(backend: SoftwareSigningBackend(), store: h.store, hostname: "testmac", now: liveClock,
                              readStdin: { Data() }, writeStdout: { _ in }, writeStderr: { _ in })
        XCTAssertEqual(forced.run(["keygen", "--force"]), .signed)
        XCTAssertEqual(try h.store.loadConfig().signerId, "approver-se-testmac-v2")
    }

    func testKeygenRejectsSuffixlessExplicitId() throws {
        let h = makeHarness(now: liveClock)
        XCTAssertEqual(h.cli.run(["keygen", "--signer-id", "approver-no-suffix"]), .internalFault)
    }

    func testPubkeyWritesPemAndIdToStderr() throws {
        let h = makeHarness(now: liveClock)
        XCTAssertEqual(h.cli.run(["keygen"]), .signed)
        let out = Buf(), err = Buf()
        let cli = SignerCLI(backend: SoftwareSigningBackend(), store: h.store, hostname: "testmac", now: liveClock,
                           readStdin: { Data() }, writeStdout: { out.append($0) }, writeStderr: { err.append(Data($0.utf8)) })
        XCTAssertEqual(cli.run(["pubkey"]), .signed)
        XCTAssertTrue(out.string.contains("BEGIN PUBLIC KEY"))
        XCTAssertTrue(err.string.contains("signerId: approver-se-testmac-v1"))
    }

    func testVersionHelpers() {
        XCTAssertEqual(versionSuffix(of: "approver-se-host-v3"), 3)
        XCTAssertNil(versionSuffix(of: "approver-se-host"))
        XCTAssertEqual(bumpVersion("approver-se-host-v3"), "approver-se-host-v4")
        XCTAssertEqual(bumpVersion("approver-se-host-v9"), "approver-se-host-v10")
    }
}

// MARK: - Test backends

/// Fails if ever asked to sign — proves expiry (etc.) is checked before prompting.
struct ExplodingBackend: SigningBackend {
    func generate() throws -> GeneratedKey { GeneratedKey(blob: Data(), publicKeyPEM: "") }
    func signDER(blob: Data, payload: Data, reason: String) throws -> Data {
        XCTFail("backend.signDER must not be called")
        throw SignerError(.internalFault, "unreachable")
    }
}

struct CancellingBackend: SigningBackend {
    func generate() throws -> GeneratedKey { GeneratedKey(blob: Data(), publicKeyPEM: "") }
    func signDER(blob: Data, payload: Data, reason: String) throws -> Data {
        throw SignerError(.cancelled, "user cancelled")
    }
}

struct InvalidatedBackend: SigningBackend {
    func generate() throws -> GeneratedKey { GeneratedKey(blob: Data(), publicKeyPEM: "") }
    func signDER(blob: Data, payload: Data, reason: String) throws -> Data {
        throw SignerError(.keyInvalidated, "biometry re-enrollment invalidated the key")
    }
}

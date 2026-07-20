import Foundation

/// Injectable IO + environment so the whole CLI is testable without touching the
/// real stdin/stdout/enclave/clock. `run` NEVER calls `exit()` — it returns the
/// `SignExit` code; the thin `atlas-signer` executable maps that to a process exit.
public struct SignerCLI: Sendable {
    let backend: any SigningBackend
    let store: KeyStore
    let hostname: String
    let now: @Sendable () -> Date
    let readStdin: @Sendable () -> Data
    let writeStdout: @Sendable (Data) -> Void
    let writeStderr: @Sendable (String) -> Void

    public init(
        backend: any SigningBackend,
        store: KeyStore,
        hostname: String,
        now: @escaping @Sendable () -> Date,
        readStdin: @escaping @Sendable () -> Data,
        writeStdout: @escaping @Sendable (Data) -> Void,
        writeStderr: @escaping @Sendable (String) -> Void
    ) {
        self.backend = backend
        self.store = store
        self.hostname = hostname
        self.now = now
        self.readStdin = readStdin
        self.writeStdout = writeStdout
        self.writeStderr = writeStderr
    }

    /// The fixed V1 access policy recorded in `config.json` + echoed by `pubkey`.
    static let accessPolicy = "biometryCurrentSet"

    public func run(_ args: [String]) -> SignExit {
        guard let sub = args.first else {
            writeStderr("usage: atlas-signer <keygen|pubkey|sign> [options]\n")
            return .malformedChallenge
        }
        let rest = Array(args.dropFirst())
        do {
            switch sub {
            case "keygen": return try keygen(rest)
            case "pubkey": return try pubkey(rest)
            case "sign": return try sign(rest)
            default:
                writeStderr("unknown subcommand \"\(sub)\" (expected keygen|pubkey|sign)\n")
                return .malformedChallenge
            }
        } catch let e as SignerError {
            writeStderr("atlas-signer: \(e.message)\n")
            return e.exit
        } catch {
            writeStderr("atlas-signer: internal fault: \(error)\n")
            return .internalFault
        }
    }

    // MARK: - keygen

    func keygen(_ args: [String]) throws -> SignExit {
        let opts = Options(args)
        let force = opts.flag("--force")

        let signerId: String
        if let explicit = opts.value("--signer-id") {
            guard versionSuffix(of: explicit) != nil else {
                throw SignerError(.internalFault, "--signer-id must carry a -vN suffix (e.g. approver-se-\(hostname)-v1)")
            }
            signerId = explicit
        } else if force, store.blobExists, let prior = try? store.loadConfig() {
            // --force rotation: derive the next -vN from the prior config's id.
            signerId = bumpVersion(prior.signerId)
        } else {
            signerId = "approver-se-\(hostname)-v1"
        }

        if store.blobExists && !force {
            throw SignerError(.internalFault, "a key already exists at \(store.blobPath.path); pass --force to rotate (re-key)")
        }

        let generated = try backend.generate() // fires Touch ID on the enclave backend
        let config = SignerConfig(
            signerId: signerId,
            accessPolicy: Self.accessPolicy,
            createdAt: iso8601(now()),
            publicKeyPem: generated.publicKeyPEM
        )
        try store.save(blob: generated.blob, config: config)

        // The PEM + id go to stdout; the enrollment runbook line to stderr.
        writeStdout(Data(generated.publicKeyPEM.utf8))
        writeStderr("signerId: \(signerId)\n")
        writeStderr("enroll this key (crosses into broker custody — must be a separate sudo step):\n")
        writeStderr("  atlas-signer pubkey --out approver.pem\n")
        writeStderr("  sudo provisioning/enroll-signer.sh --pubkey approver.pem --signer-id \(signerId) --alg p256 --presence\n")
        if force {
            writeStderr("after enrolling the new id, revoke the old one:\n")
            writeStderr("  sudo provisioning/enroll-signer.sh --revoke --signer-id <previous -vN id>\n")
        }
        return .signed
    }

    // MARK: - pubkey

    func pubkey(_ args: [String]) throws -> SignExit {
        let opts = Options(args)
        let config = try loadConfigOrThrow()
        let pem = config.publicKeyPem.hasSuffix("\n") ? config.publicKeyPem : config.publicKeyPem + "\n"
        if let out = opts.value("--out") {
            try writeFile(pem: pem, to: out, force: opts.flag("--force"))
        } else {
            writeStdout(Data(pem.utf8))
        }
        writeStderr("signerId: \(config.signerId)\n")
        writeStderr("accessPolicy: \(config.accessPolicy)\n")
        return .signed
    }

    // MARK: - sign

    func sign(_ args: [String]) throws -> SignExit {
        let opts = Options(args)
        let outPath = opts.value("--out")
        let outForce = opts.flag("--force")

        let raw = readStdin()
        guard !raw.isEmpty else {
            throw SignerError(.malformedChallenge, "empty stdin — expected one AuthorizationChallenge JSON")
        }
        let parsed = try ParsedChallenge(rawJSON: raw)
        let c = parsed.challenge

        // Re-derive and REFUSE on mismatch, BEFORE any display or prompt: the bytes
        // signed are provably the bytes shown.
        let rederived = try SigningPayload.rederive(from: c)
        guard rederived == c.signingPayload else {
            throw SignerError(
                .malformedChallenge,
                "re-derived signingPayload disagrees with the challenge — refusing to sign a payload that differs from its fields"
            )
        }

        // Expiry BEFORE prompting — never burn a touch on a dead challenge.
        guard let expiry = parseRFC3339Ms(c.expiresAt) else {
            throw SignerError(.malformedChallenge, "expiresAt is not an RFC-3339 ms timestamp: \(c.expiresAt)")
        }
        if expiry <= now() {
            throw SignerError(.expired, "challenge expired at \(c.expiresAt)")
        }

        let config = try loadConfigOrThrow()
        let blob = try store.loadBlob()

        // Informed-approval display → stderr, then the presence-gated signature.
        let summary = ApprovalSummary(challenge: c, signerId: config.signerId)
        writeStderr(summary.text + "\n")

        let derSig = try backend.signDER(
            blob: blob,
            payload: Data(c.signingPayload.utf8),
            reason: summary.localizedReason
        )
        let signature = "p256:" + Base64URL.encode(derSig)

        // Build the response echoing the challenge VERBATIM (byte-identical) so
        // the broker's recompute-and-compare and the Console's echo-equality both pass.
        let rawStr = String(decoding: parsed.rawJSON, as: UTF8.self)
        let response = "{\"schemaVersion\":1,\"challenge\":\(rawStr),\"signature\":\(jsonString(signature)),\"signerId\":\(jsonString(config.signerId))}"
        let responseData = Data((response + "\n").utf8)

        if let outPath {
            try writeResponse(responseData, to: outPath, force: outForce) // stdout stays EMPTY
        } else {
            writeStdout(responseData) // the ONLY thing on stdout
        }
        return .signed
    }

    // MARK: - helpers

    private func loadConfigOrThrow() throws -> SignerConfig {
        guard store.blobExists else {
            throw SignerError(.internalFault, "no signer key found at \(store.blobPath.path); run `atlas-signer keygen` first")
        }
        do {
            return try store.loadConfig()
        } catch {
            throw SignerError(.internalFault, "signer config unreadable: \(error)")
        }
    }

    private func writeFile(pem: String, to path: String, force: Bool) throws {
        let url = URL(fileURLWithPath: path)
        if FileManager.default.fileExists(atPath: url.path) && !force {
            throw SignerError(.internalFault, "refusing to overwrite \(path) without --force")
        }
        try Data(pem.utf8).write(to: url, options: .atomic)
        try? FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: url.path)
    }

    private func writeResponse(_ data: Data, to path: String, force: Bool) throws {
        let url = URL(fileURLWithPath: path)
        if FileManager.default.fileExists(atPath: url.path) && !force {
            throw SignerError(.internalFault, "refusing to overwrite \(path) without --force")
        }
        do {
            try data.write(to: url, options: .atomic)
            try FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: url.path)
        } catch let e as SignerError {
            throw e
        } catch {
            throw SignerError(.internalFault, "could not write \(path): \(error)")
        }
    }

    private func iso8601(_ d: Date) -> String {
        let f = ISO8601DateFormatter()
        f.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return f.string(from: d)
    }
}

// MARK: - free helpers

/// Minimal option parser: `--flag` and `--key value`.
struct Options {
    private let args: [String]
    init(_ args: [String]) { self.args = args }
    func flag(_ name: String) -> Bool { args.contains(name) }
    func value(_ name: String) -> String? {
        guard let i = args.firstIndex(of: name), i + 1 < args.count else { return nil }
        return args[i + 1]
    }
}

/// Parse an RFC-3339 UTC millisecond timestamp ending `Z` (the challenge form).
func parseRFC3339Ms(_ s: String) -> Date? {
    let f = ISO8601DateFormatter()
    f.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
    return f.date(from: s)
}

/// The trailing `-vN` version number of a signer id, or nil if absent/malformed.
func versionSuffix(of id: String) -> Int? {
    guard let r = id.range(of: "-v[0-9]+$", options: .regularExpression) else { return nil }
    return Int(id[r].dropFirst(2))
}

/// Bump `…-vN` → `…-v(N+1)`; if no suffix, append `-v2` (defensive — keygen
/// rejects a suffix-less explicit id, so this only ever sees a valid prior id).
func bumpVersion(_ id: String) -> String {
    guard let r = id.range(of: "-v[0-9]+$", options: .regularExpression), let n = Int(id[r].dropFirst(2)) else {
        return id + "-v2"
    }
    return String(id[..<r.lowerBound]) + "-v\(n + 1)"
}

/// JSON-encode a string value (quotes + escapes) for verbatim response assembly.
func jsonString(_ s: String) -> String {
    let data = (try? JSONEncoder().encode(s)) ?? Data("\"\"".utf8)
    return String(decoding: data, as: UTF8.self)
}

import Foundation
import Security

// P5-Task-4 — egress-gated actions + transient key handling.
//
// `query` / `index eval` mint an egress capability; they run behind an EXPLICIT user action only
// (never polled — see the cadence guard). The `ATLAS_EGRESS_CAPABILITY_KEY` is injected into the child
// env ONLY for these two commands, read on demand, held in process memory for the spawn's lifetime,
// and never cached, persisted (UserDefaults / cursor SQLite), or logged (it rides env, not argv).

/// The env var carrying the egress capability key.
public let EgressCapabilityEnvVar = "ATLAS_EGRESS_CAPABILITY_KEY"

/// Where the transient egress key is read from. Both are read-only to the Console.
public enum EgressKeyLocation: Sendable {
    /// Inherited from the operator's process environment. Works only when the Console is launched from a
    /// shell that exports the var; a Finder/Dock launch does NOT inherit shell exports (⇒ use keychain).
    /// The provider closure is injectable so tests supply an env without touching the real process env.
    case env(@Sendable () -> [String: String])
    /// A pre-existing operator-provisioned generic-password item, read via `SecItemCopyMatching` ONLY.
    /// The Console never `SecItemAdd`/`Update`/`Delete`.
    case keychain(service: String, account: String)

    /// The default env source (the real process environment).
    public static var processEnv: EgressKeyLocation { .env { ProcessInfo.processInfo.environment } }

    /// The default keychain item: service `com.atlas.console.egress-capability-key`, account = login name.
    public static var defaultKeychain: EgressKeyLocation {
        .keychain(service: "com.atlas.console.egress-capability-key", account: NSUserName())
    }
}

public enum EgressKeyError: Error, Equatable, Sendable {
    /// No key found in `env` mode. The hint points at the keychain source for a Finder/Dock launch.
    case keyUnavailableFromEnv(hint: String)
    /// The keychain item was not found (it must be provisioned out-of-band).
    case keychainItemNotFound(service: String, account: String)
    /// `SecItemCopyMatching` failed with an OS status.
    case keychainReadFailed(status: Int32)
    /// The keychain item held non-UTF-8 bytes.
    case keychainItemNotUTF8
}

/// Reads the transient egress key on demand and drops it after the body. The plaintext exists only for
/// the duration of `body`; nothing here retains, caches, or persists it.
public struct EgressKeyProvider: Sendable {
    private let source: EgressKeyLocation
    public init(source: EgressKeyLocation) { self.source = source }

    /// Map the persisted operator choice (`Settings.egressCapabilityKeySource`) to a concrete location:
    /// `.env` reads the given env provider (default: the real process env); `.keychain` reads the
    /// default login-keychain item.
    public init(
        settingsSource: EgressKeySource,
        envProvider: @escaping @Sendable () -> [String: String] = { ProcessInfo.processInfo.environment }
    ) {
        switch settingsSource {
        case .env: self.init(source: .env(envProvider))
        case .keychain: self.init(source: .defaultKeychain)
        }
    }

    /// Read the key, run `body` with it, and let it fall out of scope on return. Never logged.
    public func withKey<T>(_ body: (String) async throws -> T) async throws -> T {
        let key = try readKey()
        return try await body(key)
    }

    private func readKey() throws -> String {
        switch source {
        case .env(let provider):
            guard let value = provider()[EgressCapabilityEnvVar], !value.isEmpty else {
                throw EgressKeyError.keyUnavailableFromEnv(
                    hint: "\(EgressCapabilityEnvVar) is not set in the Console's environment. A Finder/Dock launch does not inherit shell exports — provision the key in the login keychain (service com.atlas.console.egress-capability-key) and switch the egress key source to keychain, or relaunch from a shell that exports it."
                )
            }
            return value
        case .keychain(let service, let account):
            return try Self.readKeychain(service: service, account: account)
        }
    }

    /// A strictly read-only keychain fetch — `SecItemCopyMatching` only; never Add/Update/Delete.
    private static func readKeychain(service: String, account: String) throws -> String {
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account,
            kSecReturnData as String: true,
            kSecMatchLimit as String: kSecMatchLimitOne,
        ]
        var item: CFTypeRef?
        let status = SecItemCopyMatching(query as CFDictionary, &item)
        switch status {
        case errSecSuccess:
            guard let data = item as? Data else { throw EgressKeyError.keychainReadFailed(status: status) }
            guard let s = String(data: data, encoding: .utf8) else { throw EgressKeyError.keychainItemNotUTF8 }
            return s
        case errSecItemNotFound:
            throw EgressKeyError.keychainItemNotFound(service: service, account: account)
        default:
            throw EgressKeyError.keychainReadFailed(status: Int32(status))
        }
    }
}

/// A validated `query` result (the schema-checked stdout bytes + the natural-language answer if present).
public struct QueryResult: Sendable, Equatable {
    public let data: Data
    public init(data: Data) { self.data = data }
}

/// A validated `index eval` result (the schema-checked stdout bytes).
public struct IndexEvalResult: Sendable, Equatable {
    public let data: Data
    public init(data: Data) { self.data = data }
}

/// A failed egress spawn. Carries ONLY content-free metadata — the machine `code`, `retryable`,
/// `retryAfterMs`, and the exit code — plus `scrubbedStderr` with the operand removed. It NEVER carries
/// the raw `ErrorEnvelope`: a CLI that echoes the query into the envelope `message`/`hint`/`details`
/// would otherwise reintroduce it onto the error surface. `code` is itself scrubbed defensively. Nothing
/// here is written verbatim to the unified log.
public enum EgressActionError: Error, Sendable, Equatable {
    case failed(command: String, exitCode: Int32, code: String?, retryable: Bool, retryAfterMs: Int?, scrubbedStderr: String)
    case spawn(command: String, detail: String)
    case invalidOutput(command: String)
}

/// Runs the two egress-minting commands with a scoped, transient key. Nothing else in the Console adds
/// the capability key to a child env.
public struct EgressAction: Sendable {
    public init() {}

    public func query(_ text: String, runner: ProcessRunner, brain: ResolvedBinary, key: EgressKeyProvider) async throws -> QueryResult {
        let data = try await run(
            command: "query", argv: ["query", text, "--json"],
            sensitiveOperand: text, runner: runner, brain: brain, key: key
        )
        return QueryResult(data: data)
    }

    /// `index eval` REQUIRES both `--queries <path>` and `--labels <path>` (per the schema's
    /// `x-atlas-contract.flags`, both `required:true`) — a bare `index eval --json` always exits 5
    /// (usage). The eval also intentionally emits its full success payload with `pass:false` at exit 1
    /// when the metrics fall below the graduation thresholds (mirroring `index verify`), so exit 1 with a
    /// schema-valid report is a SUCCESSFUL, report-bearing outcome — not a failure (unlike the other
    /// exit-1 error codes `eval-set-invalid`/`ambiguous-note`, which carry an error envelope, not the
    /// report, and therefore fail the schema gate and surface as `EgressActionError.failed`).
    public func indexEval(queries: URL, labels: URL, runner: ProcessRunner, brain: ResolvedBinary, key: EgressKeyProvider) async throws -> IndexEvalResult {
        let data = try await run(
            command: "index eval",
            argv: ["index", "eval", "--queries", queries.path, "--labels", labels.path, "--json"],
            sensitiveOperand: nil, reportBearingExitCodes: [1],
            runner: runner, brain: brain, key: key
        )
        return IndexEvalResult(data: data)
    }

    /// Spawn a minting command with the key scoped into the child env for THIS spawn only. On success
    /// (exit 0, or a `reportBearingExitCodes` exit whose stdout is a schema-valid report), strict-validate
    /// stdout against the command schema; on failure, scrub the operand from stderr before it reaches any
    /// error surface.
    private func run(
        command: String, argv: [String], sensitiveOperand: String?, reportBearingExitCodes: Set<Int32> = [],
        runner: ProcessRunner, brain: ResolvedBinary, key: EgressKeyProvider
    ) async throws -> Data {
        try await key.withKey { k in
            // Start from a non-egress base (any inherited key stripped), then inject the transient key
            // for THIS spawn only — so the exact bytes are known, never a stale inherited value.
            var env = ChildEnvironment.nonEgress(overlay: brain.baseEnv)
            env[EgressCapabilityEnvVar] = k // scoped to this spawn only
            let req = SpawnRequest(
                executable: brain.launch,
                arguments: argv,
                cwd: brain.bundle.checkoutRoot,
                environment: env,
                command: command,
                commandSchema: brain.bundle.schema(for: command)
            )
            let result: SpawnResult
            do {
                result = try await runner.run(req)
            } catch {
                throw EgressActionError.spawn(command: command, detail: "\(error)")
            }
            if result.exitCode == 0 {
                guard let schema = brain.bundle.schema(for: command),
                      let validator = try? SchemaValidator(schema: schema),
                      validator.validate(result.stdout).isValid else {
                    throw EgressActionError.invalidOutput(command: command)
                }
                return result.stdout
            }
            // A report-bearing exit code (e.g. `index eval` below-threshold ⇒ exit 1 + `pass:false`
            // report): a schema-valid stdout IS the successful outcome, not a failure. A non-report exit-1
            // (error envelope on stdout) fails the schema gate here and falls through to the failure path.
            if reportBearingExitCodes.contains(result.exitCode),
               let schema = brain.bundle.schema(for: command),
               let validator = try? SchemaValidator(schema: schema),
               validator.validate(result.stdout).isValid {
                return result.stdout
            }
            // Nonzero: extract ONLY content-free metadata (code/retryable/retryAfterMs) from the envelope
            // — never the raw envelope, whose message/hint/details could echo the query. Scrub the
            // operand from both the code (defensively) and stderr BEFORE any surface/log write.
            let parser = try? ErrorEnvelopeParser(schema: brain.bundle.errorEnvelopeSchema)
            let envelope = parser.flatMap { try? $0.parse(result.stderr) }
                ?? parser.flatMap { try? $0.parse(result.stdout) }
            let scrubbedCode = envelope.map { Self.scrub($0.code, removing: sensitiveOperand) }
            let scrubbed = Self.scrub(String(decoding: result.stderr, as: UTF8.self), removing: sensitiveOperand)
            throw EgressActionError.failed(
                command: command, exitCode: result.exitCode,
                code: scrubbedCode, retryable: envelope?.retryable ?? false,
                retryAfterMs: envelope?.retryAfterMs, scrubbedStderr: scrubbed
            )
        }
    }

    /// Replace every occurrence of the sensitive operand with a length-only marker so a CLI failure that
    /// echoes the query text cannot reintroduce it onto a surface or (via `detail`) a persistent sink.
    static func scrub(_ stderr: String, removing operand: String?) -> String {
        guard let operand, !operand.isEmpty else { return stderr }
        return stderr.replacingOccurrences(of: operand, with: "<redacted:operand len=\(operand.utf8.count)>")
    }
}

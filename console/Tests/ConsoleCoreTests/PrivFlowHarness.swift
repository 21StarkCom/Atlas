import Foundation
@testable import ConsoleCore

// MARK: - Privileged-flow fixtures (software-P-256 challenge/response bytes)

/// Builds schema-valid `AuthorizationChallenge` / `AuthorizationResponse` bytes for the privileged-flow
/// tests. The challenge passes `SignerContractValidator.validateChallenge`; the response echoes it
/// exactly (so the recursive echo check passes) with a `p256:` signature (SP-3).
enum PFx {
    static let runId = "01ARZ3NDEKTSV4RRFFQ69G5FAV"           // valid ULID
    static let targetCommit = String(repeating: "a", count: 40)
    static let baseCommit = String(repeating: "b", count: 40)
    static let nonce = String(repeating: "0", count: 32)

    /// A `git approve` integrate challenge bound to `runId`.
    static func challengeDict(
        op: String = "git approve",
        runId: String? = PFx.runId,
        canonicalization: String = "atlas-jcs-v1",
        nonce: String = PFx.nonce,
        expiresAt: String = "2026-07-20T10:00:00.000Z"
    ) -> [String: Any] {
        var d: [String: Any] = [
            "schemaVersion": 1,
            "op": op,
            "canonicalBaseCommit": baseCommit,
            "targetCommit": targetCommit,
            "intendedEffect": ["kind": "integrate", "tier": 1, "changePlanDigest": "sha256:\(String(repeating: "c", count: 8))"],
            "nonce": nonce,
            "expiresAt": expiresAt,
            "payloadCanonicalization": canonicalization,
            "signingPayload": "payload-\(nonce)",
        ]
        if let runId { d["runId"] = runId }
        return d
    }

    static func challenge(_ overrides: [String: Any] = [:]) -> Data {
        var d = challengeDict()
        for (k, v) in overrides { d[k] = v }
        return try! JSONSerialization.data(withJSONObject: d)
    }

    static func challengeCustom(_ dict: [String: Any]) -> Data {
        try! JSONSerialization.data(withJSONObject: dict)
    }

    static func response(for challengeDict: [String: Any], signature: String = "p256:AAAABBBBCCCC", signerId: String = "approver-1") -> Data {
        let d: [String: Any] = [
            "schemaVersion": 1,
            "challenge": challengeDict,
            "signature": signature,
            "signerId": signerId,
        ]
        return try! JSONSerialization.data(withJSONObject: d)
    }

    /// A brain error-envelope line for a given code / exit-context.
    /// A REAL exit-0 success payload for a privileged op, loaded from that command's own bound schema
    /// example. `PrivilegedFlow` strict-validates authorize stdout against the op's schema (an exit 0 with
    /// unparseable/foreign output is fail-OPEN and must not resolve to Done), so success fixtures have to
    /// be the actual command success object — not a placeholder like `{"code":"authz.ok"}`.
    static func successStdout(op: String = "git approve") -> Data {
        let file = op.replacingOccurrences(of: " ", with: "-") + ".schema.json"
        guard let schema = try? TestSupport.contractSchema(file),
              let obj = try? JSONSerialization.jsonObject(with: schema) as? [String: Any],
              let examples = obj["examples"] as? [Any], let first = examples.first,
              let data = try? JSONSerialization.data(withJSONObject: first) else {
            preconditionFailure("no schema example for `\(op)` — cannot build a valid success fixture")
        }
        return data
    }

    static func envelope(code: String, retryable: Bool = false, retryAfterMs: Int? = nil, message: String = "authz") -> Data {
        var d: [String: Any] = ["code": code, "message": message, "hint": "", "retryable": retryable]
        if let retryAfterMs { d["retryAfterMs"] = retryAfterMs }
        return try! JSONSerialization.data(withJSONObject: d)
    }
}

// MARK: - Scripted privileged-flow runner

/// A `ProcessRunner` scripting the three privileged-flow spawns by ROLE, detected from argv/executable:
/// `--export-challenge` ⇒ export, `--authorization` ⇒ authorize, else ⇒ sign. Each role pops from its
/// queue; env / argv / stdin are recorded for scoping + argv-reuse assertions.
final class PrivRunner: ProcessRunner, @unchecked Sendable {
    enum Role: Equatable { case export, authorize, sign, other }

    struct Call: Sendable {
        let role: PrivRunner.Role
        let executable: [String]
        let arguments: [String]
        let environment: [String: String]
        let stdin: Data?
    }

    private let lock = NSLock()
    private var exportQ: [SpawnResult]
    private var signQ: [SpawnResult]
    private var authorizeQ: [SpawnResult]
    private var otherResult: SpawnResult
    private var authorizeThrows: [Bool] // true ⇒ throw SpawnError (brain died) for that authorize call
    private(set) var calls: [Call] = []

    init(
        export: [SpawnResult] = [],
        sign: [SpawnResult] = [],
        authorize: [SpawnResult] = [],
        authorizeThrows: [Bool] = [],
        other: SpawnResult = SpawnResult(exitCode: 0, stdout: Data(), stderr: Data())
    ) {
        self.exportQ = export
        self.signQ = sign
        self.authorizeQ = authorize
        self.authorizeThrows = authorizeThrows
        self.otherResult = other
    }

    static func role(_ args: [String]) -> Role {
        if args.contains("--export-challenge") { return .export }
        if args.contains("--authorization") { return .authorize }
        if args.contains("sign") { return .sign }
        return .other
    }

    func run(_ req: SpawnRequest) async throws -> SpawnResult {
        let role = Self.role(req.arguments)
        try lock.withLock {
            calls.append(Call(role: role, executable: req.executable, arguments: req.arguments,
                              environment: req.environment, stdin: req.stdin))
            if role == .authorize, !authorizeThrows.isEmpty, authorizeThrows.removeFirst() {
                throw SpawnError.timedOut(.seconds(1))
            }
        }
        return lock.withLock {
            switch role {
            case .export: return exportQ.isEmpty ? otherResult : exportQ.removeFirst()
            case .sign: return signQ.isEmpty ? otherResult : signQ.removeFirst()
            case .authorize: return authorizeQ.isEmpty ? otherResult : authorizeQ.removeFirst()
            case .other: return otherResult
            }
        }
    }

    func stream(_ req: SpawnRequest) throws -> StreamHandle {
        fatalError("PrivRunner does not stream")
    }

    var callRoles: [Role] { lock.withLock { calls.map(\.role) } }
    func calls(for role: Role) -> [Call] { lock.withLock { calls.filter { $0.role == role } } }
}

// MARK: - Gated authorize runner (for actor-reentrancy / interleaving tests)

/// Scripts export + sign immediately, but PARKS the authorize spawn on a continuation until
/// `releaseAuthorize` is called — so a test can inject a concurrent `cancel()`/`begin()` while the flow
/// is suspended mid-authorize and prove the resumed continuation cannot revive the superseded flow.
final class GatedAuthorizeRunner: ProcessRunner, @unchecked Sendable {
    private let lock = NSLock()
    private var exportQ: [SpawnResult]
    private var signQ: [SpawnResult]
    private var authorizeCont: CheckedContinuation<SpawnResult, Never>?
    private var pendingResult: SpawnResult?
    private(set) var roles: [PrivRunner.Role] = []
    private var _authorizeEntered = false

    init(export: [SpawnResult], sign: [SpawnResult]) {
        self.exportQ = export
        self.signQ = sign
    }

    var authorizeEntered: Bool { lock.withLock { _authorizeEntered } }

    func run(_ req: SpawnRequest) async throws -> SpawnResult {
        let role = PrivRunner.role(req.arguments)
        lock.withLock { roles.append(role) }
        switch role {
        case .export: return lock.withLock { exportQ.isEmpty ? SpawnResult(exitCode: 0, stdout: Data(), stderr: Data()) : exportQ.removeFirst() }
        case .sign: return lock.withLock { signQ.isEmpty ? SpawnResult(exitCode: 0, stdout: Data(), stderr: Data()) : signQ.removeFirst() }
        case .authorize:
            return await withCheckedContinuation { (c: CheckedContinuation<SpawnResult, Never>) in
                let ready: SpawnResult? = lock.withLock {
                    _authorizeEntered = true
                    if let r = pendingResult { pendingResult = nil; return r }
                    authorizeCont = c
                    return nil
                }
                if let ready { c.resume(returning: ready) }
            }
        case .other: return SpawnResult(exitCode: 0, stdout: Data(), stderr: Data())
        }
    }

    func stream(_ req: SpawnRequest) throws -> StreamHandle { fatalError("no stream") }

    /// Release the parked authorize spawn with `result` (or arm it if authorize has not yet entered).
    func releaseAuthorize(_ result: SpawnResult) {
        let cont: CheckedContinuation<SpawnResult, Never>? = lock.withLock {
            if let c = authorizeCont { authorizeCont = nil; return c }
            pendingResult = result
            return nil
        }
        cont?.resume(returning: result)
    }
}

// MARK: - Shared flow constructor

enum PrivFlowKit {
    /// Build a `PrivilegedFlow` bound to the real repo bundle, with a scripted runner, a throwaway
    /// flows root, and a no-op sleeper (AuthorizeRetry asserted without real waits).
    static func make(
        runner: PrivRunner,
        flowsRoot: URL,
        maxAuthorizeRetries: Int = 5,
        file: StaticString = #filePath
    ) throws -> PrivilegedFlow {
        let brain = try Fx4.binary(file: file)
        let signer = try Fx4.binary(file: file)
        let router = OperationRouter(bundle: brain.bundle)
        return try PrivilegedFlow(
            runner: runner, brain: brain, signer: signer, router: router,
            validator: SignerContractValidator(),
            configRoot: brain.bundle.checkoutRoot, flowsRoot: flowsRoot,
            maxAuthorizeRetries: maxAuthorizeRetries, brainTimeout: .seconds(5),
            sleeper: { _ in }
        )
    }

    /// Same as `make` but accepts any `ProcessRunner` (e.g. the gated runner for interleaving tests).
    static func makeGeneric(
        runner: ProcessRunner,
        flowsRoot: URL,
        maxAuthorizeRetries: Int = 5,
        file: StaticString = #filePath
    ) throws -> PrivilegedFlow {
        let brain = try Fx4.binary(file: file)
        let signer = try Fx4.binary(file: file)
        let router = OperationRouter(bundle: brain.bundle)
        return try PrivilegedFlow(
            runner: runner, brain: brain, signer: signer, router: router,
            validator: SignerContractValidator(),
            configRoot: brain.bundle.checkoutRoot, flowsRoot: flowsRoot,
            maxAuthorizeRetries: maxAuthorizeRetries, brainTimeout: .seconds(5),
            sleeper: { _ in }
        )
    }

    static func flowsRoot() -> URL {
        let dir = TestSupport.tempDir("priv-flows")
        return dir
    }

    /// Count of leftover per-flow dirs under the flows root (0 ⇒ cleaned).
    static func leftoverCount(_ root: URL) -> Int {
        (try? FileManager.default.contentsOfDirectory(at: root, includingPropertiesForKeys: nil).count) ?? 0
    }
}

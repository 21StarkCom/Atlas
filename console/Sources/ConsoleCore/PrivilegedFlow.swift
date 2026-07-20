import Foundation

// P5-Task-2/3 — the export→sign→authorize privileged-flow state machine.
//
// Non-negotiables realized here:
//  - `--yes` NEVER authorizes; the ONLY authorization path is `--export-challenge` → sign →
//    `--authorization <path>`.
//  - A challenge is bound to the SAME argv it was exported for (`BoundInvocation`); export and
//    authorize argv are byte-identical apart from the trailing flag.
//  - Each flow runs in a per-flow temp dir (0700) removed on EVERY terminal transition — an abnormal
//    termination cannot leave a signed authorization artifact behind past the next launch sweep.
//  - The exported challenge bytes are read ONCE into a frozen in-memory representation; the same frozen
//    bytes are piped to the signer (mutating `challenge.json` afterward cannot change what is signed).
//  - A broker restart (nonce_expired/nonce_unknown) VOIDS the challenge ⇒ re-export, never resubmit.

/// The privileged-flow states (plan §P5-Task-2). `retry` is reserved for the Export retry affordance
/// surface; the flow itself lands a retryable export in `failed` with a re-initiate hint.
public enum PrivilegedFlowState: Sendable, Equatable {
    case idle
    case export(op: String)
    case display(AuthorizationChallenge)
    case sign
    case authorize
    case done
    case authorizeRetry
    case retry
    case failed(reason: String)
}

/// The export→sign→authorize driver. Holds no broker/signing credential and opens no socket — it only
/// shells to the resolved `brain` (export/authorize) and `atlas-signer` (sign) through the shared
/// logging runner.
public actor PrivilegedFlow {
    /// Canonicalization ids the Console will display/authorize. A challenge naming anything else fails
    /// the Display consistency gate (`challenge-mismatch`) — the broker/signer own the full crypto path,
    /// the Console adds this cheap contextual guard. `atlas-jcs-v1` is the V1 canonical serialization.
    public static let supportedCanonicalizations: Set<String> = ["atlas-jcs-v1"]

    private let runner: ProcessRunner
    private let brain: ResolvedBinary
    private let signer: ResolvedBinary
    private let router: OperationRouter
    private let validator: SignerContractValidator
    /// The checkout root derived from the resolved brain contract anchor — NOT `Settings.atlasRoot`, so
    /// an override/env-resolved brain with `atlasRoot` nil still yields a complete `--config`.
    private let configRoot: URL
    /// The one Console-owned parent for all per-flow temp dirs; launch sweeps it.
    private let flowsRoot: URL
    /// Injectable backoff sleep (milliseconds) so AuthorizeRetry is asserted without real waits.
    private let sleeper: @Sendable (Int) async -> Void
    private let maxAuthorizeRetries: Int
    private let brainTimeout: Duration?
    /// The bound error-envelope parser. Construction is REQUIRED to succeed at init (a malformed bound
    /// `error-envelope.schema.json` throws), so the Authorize matrix can never silently disable parsing
    /// and downgrade a definitive exit 4/6 into an indeterminate AuthorizeRetry — a fail-open the flow
    /// must never take. It is therefore non-optional: the flow cannot even be constructed without it.
    private let envelopeParser: ErrorEnvelopeParser

    private var _state: PrivilegedFlowState = .idle
    private var invocation: BoundInvocation?
    private var tempDir: URL?
    private var frozenChallengeBytes: Data?
    private var frozenChallenge: AuthorizationChallenge?
    private var responseBytes: Data?
    /// A per-flow generation counter. Every external entry point (`begin`/`handleExit6`/`cancel`)
    /// increments it and captures the fresh value; each private step guards `isActive(gen)` after every
    /// `await`, so a continuation resumed after a NEW begin/cancel cannot revive a superseded flow or
    /// authorize invocation A against flow B's directory/state. Re-export (same logical flow) keeps its gen.
    private var generation = 0

    public var state: PrivilegedFlowState { _state }

    /// Authoritative "a flow is in progress" — read on the actor, not from an async-mirrored copy.
    /// The settings-cutover gate MUST consult this (a mirror lags the actor by a task hop, so a
    /// begin→apply interleaving could slip a cutover past a mirror-based gate mid-export).
    public var isInFlight: Bool {
        switch _state {
        case .idle, .done, .failed: return false
        case .export, .display, .sign, .authorize, .authorizeRetry, .retry: return true
        }
    }

    /// Every state transition is published here so the UI observes transitions without polling. The
    /// stream is unbounded/newest-buffering; terminal states (`done`/`failed`) are delivered too.
    public nonisolated let stateChanges: AsyncStream<PrivilegedFlowState>
    private let stateContinuation: AsyncStream<PrivilegedFlowState>.Continuation

    /// Set `_state` and publish it. The single funnel for every transition.
    private func transition(to newState: PrivilegedFlowState) {
        _state = newState
        stateContinuation.yield(newState)
    }

    /// True iff `gen` is still the active flow generation (no begin/cancel intervened across an await).
    private func isActive(_ gen: Int) -> Bool { gen == generation }

    public init(
        runner: ProcessRunner,
        brain: ResolvedBinary,
        signer: ResolvedBinary,
        router: OperationRouter,
        validator: SignerContractValidator,
        configRoot: URL,
        flowsRoot: URL? = nil,
        maxAuthorizeRetries: Int = 5,
        brainTimeout: Duration? = .seconds(120),
        sleeper: @escaping @Sendable (Int) async -> Void = { ms in
            if ms > 0 { try? await Task.sleep(for: .milliseconds(ms)) }
        }
    ) throws {
        self.runner = runner
        self.brain = brain
        self.signer = signer
        self.router = router
        self.validator = validator
        self.configRoot = configRoot
        self.flowsRoot = flowsRoot ?? Self.defaultFlowsRoot
        self.maxAuthorizeRetries = maxAuthorizeRetries
        self.brainTimeout = brainTimeout
        self.sleeper = sleeper
        // REQUIRED — a malformed bound envelope schema fails the flow at construction, never at runtime.
        self.envelopeParser = try ErrorEnvelopeParser(schema: brain.bundle.errorEnvelopeSchema)
        var cont: AsyncStream<PrivilegedFlowState>.Continuation!
        self.stateChanges = AsyncStream(bufferingPolicy: .unbounded) { cont = $0 }
        self.stateContinuation = cont
    }

    /// `~/Library/Caches/com.atlas.console/flows/`.
    public static var defaultFlowsRoot: URL {
        let caches = FileManager.default.urls(for: .cachesDirectory, in: .userDomainMask).first
            ?? FileManager.default.temporaryDirectory
        return caches.appendingPathComponent("com.atlas.console/flows", isDirectory: true)
    }

    /// Launch-time sweep: remove any leftover per-flow dirs so a crash/kill cannot leave a signed
    /// authorization artifact behind past the next start. Idempotent; tolerant of an absent parent.
    public static func sweepLeftoverFlows(root: URL) {
        let fm = FileManager.default
        guard let entries = try? fm.contentsOfDirectory(at: root, includingPropertiesForKeys: nil) else { return }
        for entry in entries { try? fm.removeItem(at: entry) }
    }

    // MARK: - Entry points

    /// Begin a UI-initiated privileged flow: bind operands, export, gate, and land in Display (or Failed).
    public func begin(op: String, focus: FocusContext, entry: [String: String]) async {
        generation += 1
        let gen = generation
        // A new begin supersedes any active flow: clear the PREVIOUS flow's challenge/authorization temp
        // dir + frozen bytes up front, so even a routing failure (which never spawns and so never creates
        // a fresh dir) cannot leave the prior flow's signed artifacts behind. `failCleanup` below is then a
        // no-op on the (already nil) temp dir, and the terminal `failed` transition is still published.
        cleanup()
        let inv: BoundInvocation
        do {
            inv = try router.bind(op, focus: focus, entry: entry)
        } catch RoutingError.unsupportedPrivilegedCommand {
            failCleanup("unsupported privileged command: \(op)")
            return
        } catch RoutingError.missingOperand(_, let operand) {
            failCleanup("routing: missing operand \(operand) for \(op)")
            return
        } catch RoutingError.cardinality(_, let group, let present) {
            failCleanup("routing: exactly one of \(group) required for \(op) (present: \(present))")
            return
        } catch {
            failCleanup("routing: \(error)")
            return
        }
        invocation = inv
        await performExportAndDisplay(gen: gen)
    }

    /// P5-Task-3 exit-6 backstop: a broker `exit 6` refusing a mutation for want of authorization enters
    /// the flow by REUSING the refused invocation's exact argv — no descriptor, no membership list. The
    /// caller constructs the `BoundInvocation` from the argv it just ran. A fresh per-flow generation.
    public func handleExit6(refused: BoundInvocation, envelope: ErrorEnvelope) async {
        generation += 1
        let gen = generation
        invocation = refused
        await performExportAndDisplay(gen: gen)
    }

    /// Display → Sign: pipe the frozen challenge bytes to the signer and branch on its exit table.
    public func confirm() async {
        guard case .display = _state, let inv = invocation,
              let chBytes = frozenChallengeBytes, let ch = frozenChallenge else { return }
        let gen = generation
        transition(to: .sign)
        let signResult: SpawnResult
        do {
            signResult = try await runner.run(signerRequest(stdin: chBytes))
        } catch {
            guard isActive(gen) else { return }
            failCleanup("sign: spawn \(spawnDetail(error))")
            return
        }
        guard isActive(gen) else { return } // a begin/cancel superseded this flow across the sign await
        switch SignerExit.interpret(signResult.exitCode) {
        case .known(.signed):
            let respBytes = signResult.stdout
            guard validator.validateResponse(respBytes, echoing: ch).isValid else {
                failCleanup("sign: malformed response (schema or echo mismatch)")
                return
            }
            responseBytes = respBytes
            await performAuthorize(inv: inv, gen: gen)
        case .known(.internalFault):
            failCleanup("sign: signer exit 1 (internal fault)")
        case .known(.malformed):
            failCleanup("sign: signer exit 2 (malformed challenge or re-derivation refuse)")
        case .known(.expired):
            // exit 3 — challenge expired (checked pre-prompt) ⇒ re-export a fresh challenge (same flow).
            await performExportAndDisplay(gen: gen)
        case .known(.cancelled):
            // exit 4 — operator cancel / biometry declined ⇒ Idle.
            cancelCleanup()
        case .known(.keyInvalidated):
            failCleanup("sign: signer exit 5 (signing key invalidated) — see the SP-3 re-enroll runbook")
        case .unrecognized(let c):
            failCleanup("sign: signer exit \(c) (unrecognized)")
        }
    }

    /// Display → Idle on operator cancel; temp-dir cleanup. Bumps the generation so an in-flight step
    /// resumed after this cancel cannot mutate state.
    public func cancel() async {
        generation += 1
        cancelCleanup()
    }

    // MARK: - Export + Display gate

    private func performExportAndDisplay(gen: Int) async {
        guard let inv = invocation else { failCleanup("export: no bound invocation"); return }
        do {
            try freshTempDir()
        } catch {
            failCleanup("export: temp-dir setup failed: \(error)")
            return
        }
        transition(to: .export(op: inv.op))

        let argv = inv.exportArgv + configArgs()
        let result: SpawnResult
        do {
            result = try await runner.run(brainRequest(op: inv.op, argv: argv))
        } catch {
            guard isActive(gen) else { return }
            failCleanup("export: spawn \(spawnDetail(error))")
            return
        }
        guard isActive(gen) else { return } // superseded across the export await

        let challengeBytes = result.stdout
        if result.exitCode == 6,
           validator.validateChallenge(challengeBytes).isValid,
           let challenge = try? JSONDecoder().decode(AuthorizationChallenge.self, from: challengeBytes) {
            if let reason = consistencyGateFailure(challenge: challenge, invocation: inv) {
                failCleanup("challenge-mismatch: \(reason)")
                return
            }
            // Persist + freeze the challenge ONLY after the gate passes. A failed 0600 write fails closed.
            do {
                try writeArtifact("challenge.json", challengeBytes)
            } catch {
                failCleanup("export: challenge artifact write failed: \(error)")
                return
            }
            frozenChallengeBytes = challengeBytes
            frozenChallenge = challenge
            transition(to: .display(challenge))
            return
        }

        // Not a valid minted challenge: inspect the error envelope for a retry affordance.
        let env = parseEnvelope(result)
        if env?.retryable == true {
            failCleanup("export: exit=\(result.exitCode) code=\(env?.code ?? "?") retryable — re-initiate")
        } else {
            failCleanup("export: exit=\(result.exitCode) code=\(env?.code ?? "no-challenge-minted")")
        }
    }

    /// The cheap contextual gate (op / bound-operand / canonicalization). The full cryptographic binding
    /// of displayed fields → signed bytes is the signer's duty (SP-3); this never runs a second crypto
    /// path. Any mismatch is a terminal `challenge-mismatch` that never reaches Display.
    private func consistencyGateFailure(challenge: AuthorizationChallenge, invocation: BoundInvocation) -> String? {
        if challenge.op != invocation.op {
            return "op \(challenge.op) != invocation \(invocation.op)"
        }
        if let cRun = challenge.runId, let oRun = invocation.operands["runId"], cRun != oRun {
            return "runId \(cRun) != operand \(oRun)"
        }
        if let cTarget = challenge.targetCommit, let oTarget = invocation.operands["targetCommit"], cTarget != oTarget {
            return "targetCommit \(cTarget) != operand \(oTarget)"
        }
        if !Self.supportedCanonicalizations.contains(challenge.payloadCanonicalization) {
            return "unsupported payloadCanonicalization \(challenge.payloadCanonicalization)"
        }
        return nil
    }

    // MARK: - Authorize + AuthorizeRetry

    private enum AuthorizeOutcome {
        case done
        case reExport
        case reconcile(String)
        case fail(String)
        case retry(Int) // retryAfterMs floor
    }

    private func performAuthorize(inv: BoundInvocation, gen: Int) async {
        guard let respBytes = responseBytes, let dir = tempDir else {
            failCleanup("authorize: no response artifact")
            return
        }
        let authPath = dir.appendingPathComponent("authorization.json")
        do {
            try writeArtifact("authorization.json", respBytes) // written once; the SAME artifact is resubmitted
        } catch {
            failCleanup("authorize: authorization artifact write failed: \(error)")
            return
        }
        let argv = inv.authorizeArgv(authorizationPath: authPath) + configArgs()

        var attempt = 0
        transition(to: .authorize)
        while true {
            var result: SpawnResult?
            do {
                result = try await runner.run(brainRequest(op: inv.op, argv: argv))
            } catch {
                result = nil // brain died / timed out ⇒ indeterminate after a possible commit
            }
            guard isActive(gen) else { return } // superseded across the authorize await
            switch classifyAuthorize(result, op: inv.op) {
            case .done:
                transition(to: .done)
                cleanup()
                return
            case .reExport:
                // Broker restart voided the nonce ⇒ re-export; NEVER resubmit the stale artifact.
                await performExportAndDisplay(gen: gen)
                return
            case .reconcile(let code):
                failCleanup("authorize: \(code) — nonce spent on an incomplete op; reconcile via read commands, then re-export")
                return
            case .fail(let detail):
                failCleanup("authorize: \(detail)")
                return
            case .retry(let retryAfterMs):
                attempt += 1
                if attempt > maxAuthorizeRetries {
                    failCleanup("authorize: indeterminate after \(maxAuthorizeRetries) retries")
                    return
                }
                // Publish AuthorizeRetry IMMEDIATELY on selecting the retry — BEFORE the backoff sleep —
                // so an observer sees the retry state throughout the wait, never a stale Authorize. Only
                // then sleep the `retryAfterMs` floor and resubmit the EXACT same argv + artifact.
                transition(to: .authorizeRetry)
                await sleeper(retryAfterMs)
                guard isActive(gen) else { return } // superseded across the backoff sleep
                continue
            }
        }
    }

    /// The TOTAL authorize outcome matrix over `(brain exitCode, envelope?)`. Every combination resolves
    /// to exactly one outcome — NO silent default treats a definitive failure as indeterminate:
    ///  - brain died (no result) ⇒ indeterminate ⇒ AuthorizeRetry (a possible commit was lost).
    ///  - exit 0 ⇒ Done (authz.ok, incl. noop:true idempotent replay).
    ///  - a parseable envelope: `authz.nonce_expired`/`authz.nonce_unknown` ⇒ re-export; `authz.nonce_replayed`
    ///    ⇒ reconcile; exit 4/6 + `retryable:true` ⇒ AuthorizeRetry; anything else ⇒ Failed.
    ///  - NO parseable envelope: ONLY exit 4/6 is indeterminate (⇒ AuthorizeRetry, a possible commit);
    ///    a definitive exit (1/2/3/5) or an UNKNOWN code ⇒ Failed (never silently retried).
    private func classifyAuthorize(_ result: SpawnResult?, op: String) -> AuthorizeOutcome {
        guard let result else { return .retry(0) } // brain died / no result ⇒ indeterminate
        if result.exitCode == 0 {
            // A privileged mutation reporting success must PROVE it: validate stdout against the op's own
            // bound command schema. Treating any exit 0 as Done is fail-OPEN — malformed or empty output
            // from a half-completed handler would be accepted as a completed mutation.
            guard let schema = brain.bundle.schema(for: op) else {
                return .fail("authorize: no bound schema for `\(op)` — cannot verify success output")
            }
            guard let validator = try? SchemaValidator(schema: schema) else {
                return .fail("authorize: unusable schema for `\(op)`")
            }
            guard validator.validate(result.stdout).isValid else {
                return .fail("authorize: exit 0 but stdout failed `\(op)` schema validation")
            }
            return .done
        }
        if let env = parseEnvelope(result) {
            switch env.code {
            case "authz.nonce_expired", "authz.nonce_unknown":
                return .reExport
            case "authz.nonce_replayed":
                return .reconcile(env.code)
            default:
                if (result.exitCode == 4 || result.exitCode == 6), env.retryable {
                    return .retry(env.retryAfterMs ?? 0)
                }
                return .fail("exit=\(result.exitCode) code=\(env.code)")
            }
        }
        // No parseable envelope: only exit 4/6 is indeterminate (a possible commit); every definitive
        // exit (1/2/3/5) and every UNKNOWN code fails closed — never a silent retry.
        if result.exitCode == 4 || result.exitCode == 6 { return .retry(0) }
        return .fail("exit=\(result.exitCode) no-parseable-envelope")
    }

    // MARK: - Spawn requests

    private func configArgs() -> [String] {
        ["--config", configRoot.appendingPathComponent("brain.config.yaml").path]
    }

    private func childEnv() -> [String: String] {
        // A privileged export/sign/authorize spawn is a NON-egress spawn: the shared builder strips any
        // inherited ATLAS_EGRESS_CAPABILITY_KEY so a shell-launched Console never forwards it to brain or
        // the signer. Only EgressAction injects that key, and only for its two minting commands.
        ChildEnvironment.nonEgress(overlay: brain.baseEnv)
    }

    private func brainRequest(op: String, argv: [String]) -> SpawnRequest {
        SpawnRequest(
            executable: brain.launch,
            arguments: argv,
            cwd: tempDir ?? configRoot,
            environment: childEnv(),
            timeout: brainTimeout,
            command: op,
            commandSchema: brain.bundle.schema(for: op)
        )
    }

    private func signerRequest(stdin: Data) -> SpawnRequest {
        // Pipe the frozen challenge bytes on stdin; NO `--out` (the response is the sole stdout content).
        // No timeout: the signer may block on an OS presence / biometry prompt.
        SpawnRequest(
            executable: signer.launch,
            arguments: ["sign"],
            cwd: tempDir ?? configRoot,
            environment: childEnv(),
            stdin: stdin,
            timeout: nil,
            command: "atlas-signer sign",
            commandSchema: nil
        )
    }

    private func parseEnvelope(_ r: SpawnResult) -> ErrorEnvelope? {
        if let e = try? envelopeParser.parse(r.stdout) { return e }
        if let e = try? envelopeParser.parse(r.stderr) { return e }
        return nil
    }

    private func spawnDetail(_ error: Error) -> String {
        switch error {
        case SpawnError.timedOut(let d): return "timed-out=\(d)"
        case is CancellationError: return "cancelled"
        default: return "\(error)"
        }
    }

    // MARK: - Temp-dir lifecycle

    /// Errors while establishing the fail-closed per-flow scratch surface. The flow must NEVER advance to
    /// sign/authorize without a real 0700 directory and a real 0600 artifact on disk.
    enum FlowIOError: Error, CustomStringConvertible {
        case tempDirNotCreated(String)
        case tempDirNotPrivate(String, mode: Int)
        case artifactNoTempDir
        case artifactNotWritten(String, underlying: String)
        case artifactNotPrivate(String, mode: Int)
        var description: String {
            switch self {
            case .tempDirNotCreated(let p): return "temp dir not created at \(p)"
            case .tempDirNotPrivate(let p, let m): return "temp dir \(p) not 0700 (mode \(String(m, radix: 8)))"
            case .artifactNoTempDir: return "no temp dir for artifact"
            case .artifactNotWritten(let n, let u): return "artifact \(n) not written: \(u)"
            case .artifactNotPrivate(let n, let m): return "artifact \(n) not 0600 (mode \(String(m, radix: 8)))"
            }
        }
    }

    /// Discard any prior per-flow dir (re-export path) and create a fresh 0700 dir — THROWING and
    /// verified. A failed create or a directory that is not actually private fails closed before any spawn.
    private func freshTempDir() throws {
        if let dir = tempDir { try? FileManager.default.removeItem(at: dir) }
        responseBytes = nil
        tempDir = nil
        let fm = FileManager.default
        let dir = flowsRoot.appendingPathComponent(UUID().uuidString, isDirectory: true)
        do {
            try fm.createDirectory(at: dir, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
        } catch {
            throw FlowIOError.tempDirNotCreated("\(dir.path): \(error)")
        }
        // From here the dir exists on disk. Every remaining check is MANDATORY and fails CLOSED — a
        // swallowed chmod, an unreadable stat, or a non-exact mode all REJECT (never fall through to a
        // world-readable scratch dir). Any failure removes the locally-created dir before rethrowing, so a
        // rejected flow never leaves its directory behind.
        do {
            var isDir: ObjCBool = false
            guard fm.fileExists(atPath: dir.path, isDirectory: &isDir), isDir.boolValue else {
                throw FlowIOError.tempDirNotCreated(dir.path)
            }
            // chmod is MANDATORY: intermediate dirs may pre-exist with looser perms — a failed set is fatal.
            do { try fm.setAttributes([.posixPermissions: 0o700], ofItemAtPath: dir.path) }
            catch { throw FlowIOError.tempDirNotPrivate(dir.path, mode: -1) }
            // stat is MANDATORY and the mode must be EXACTLY 0700 — a missing/uncastable mode REJECTS.
            guard let mode = try fm.attributesOfItem(atPath: dir.path)[.posixPermissions] as? Int else {
                throw FlowIOError.tempDirNotPrivate(dir.path, mode: -1)
            }
            guard mode & 0o7777 == 0o700 else { throw FlowIOError.tempDirNotPrivate(dir.path, mode: mode) }
        } catch {
            try? fm.removeItem(at: dir)
            throw error
        }
        tempDir = dir
    }

    /// Write a 0600 artifact into the per-flow dir — THROWING and verified. A failed write or a file that
    /// is not actually private fails closed (the flow never advances on a phantom artifact).
    private func writeArtifact(_ name: String, _ data: Data) throws {
        guard let dir = tempDir else { throw FlowIOError.artifactNoTempDir }
        let fm = FileManager.default
        let url = dir.appendingPathComponent(name)
        do {
            try data.write(to: url, options: .atomic)
        } catch {
            throw FlowIOError.artifactNotWritten(name, underlying: "\(error)")
        }
        // MANDATORY, fail-closed, and self-cleaning: the atomic write lands with the umask default, so the
        // chmod is REQUIRED (a swallowed failure could leave a group/other-readable artifact); the stat is
        // REQUIRED and the mode must be EXACTLY 0600. Any failure removes the just-written artifact.
        do {
            do { try fm.setAttributes([.posixPermissions: 0o600], ofItemAtPath: url.path) }
            catch { throw FlowIOError.artifactNotPrivate(name, mode: -1) }
            guard fm.fileExists(atPath: url.path) else {
                throw FlowIOError.artifactNotWritten(name, underlying: "absent after write")
            }
            guard let mode = try fm.attributesOfItem(atPath: url.path)[.posixPermissions] as? Int else {
                throw FlowIOError.artifactNotPrivate(name, mode: -1)
            }
            guard mode & 0o7777 == 0o600 else { throw FlowIOError.artifactNotPrivate(name, mode: mode) }
        } catch {
            try? fm.removeItem(at: url)
            throw error
        }
    }

    private func cleanup() {
        if let dir = tempDir { try? FileManager.default.removeItem(at: dir) }
        tempDir = nil
        frozenChallengeBytes = nil
        frozenChallenge = nil
        responseBytes = nil
    }

    private func failCleanup(_ reason: String) {
        cleanup()
        transition(to: .failed(reason: reason))
    }

    private func cancelCleanup() {
        cleanup()
        transition(to: .idle)
    }
}

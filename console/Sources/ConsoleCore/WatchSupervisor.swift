import Foundation

// MARK: - Backoff delay

extension BackoffPolicy {
    /// The backoff delay (ms) for a 1-based `attempt`: `initial * multiplier^(attempt-1)`, capped, then
    /// ±`jitterFraction`. `retryAfterMs` (envelope-provided) is a FLOOR — the delay is never shorter.
    /// Pure + deterministic given `rng`, so tests assert the progression + band directly.
    public func delayMs(attempt: Int, retryAfterMs: Int?, using rng: inout some RandomNumberGenerator) -> Int {
        let initialMs = Self.milliseconds(initial)
        let capMs = Self.milliseconds(cap)
        let exponent = max(0, attempt - 1)
        let base = min(initialMs * pow(multiplier, Double(exponent)), capMs)
        let low = base * (1.0 - jitterFraction)
        let high = base * (1.0 + jitterFraction)
        // The jittered base is bounded by `cap × (1 + jitterFraction)` (a few tens of thousands of ms),
        // so this `Int(...)` conversion is always safe. The `retryAfterMs` floor is schema-UNBOUNDED
        // (up to `Int.max`), so it is applied in INTEGER space — never via `Double(floorMs)`, which would
        // round `Int.max` above the representable range and TRAP on the round-trip back to `Int`.
        let jittered = Int(Double.random(in: low...high, using: &rng).rounded())
        guard let floorMs = retryAfterMs else { return jittered }
        return max(jittered, floorMs)
    }

    private static func milliseconds(_ d: Duration) -> Double {
        let c = d.components
        return Double(c.seconds) * 1000.0 + Double(c.attoseconds) / 1_000_000_000_000_000.0
    }
}

// MARK: - Watch options

/// The optional watch tuning flags. A `nil` value OMITS the flag (the CLI owns its default), preserving
/// the `WatchOptionPolicy` omission contract all the way through argv construction.
public struct WatchOptions: Sendable, Equatable {
    public var pollMs: Int?
    public var heartbeatSeconds: Int?
    public init(pollMs: Int? = nil, heartbeatSeconds: Int? = nil) {
        self.pollMs = pollMs
        self.heartbeatSeconds = heartbeatSeconds
    }
}

// MARK: - Exit classification

/// The total classification of a completed watch run over `(exitCode, envelope?)`. Every pair maps to
/// exactly one case — no silent default.
public enum ExitClass: Equatable, Sendable {
    /// exit 0 — a clean detach (EPIPE/SIGTERM/SIGINT). No restart, no error surface.
    case cleanDetach
    /// Structurally terminal or a non-retryable envelope. Carries the exit code, the `code` reason, and
    /// the envelope's `hint` (the transient remediation diagnostic — `nil` when there is no envelope, so
    /// it is never fabricated). The captured `stderr` is threaded separately (it is not classification
    /// input) and lands on the `SupervisorState.failed` error surface.
    case terminal(Int32, code: String, hint: String?)
    /// A retryable fault; `retryAfterMs` is an optional floor for the backoff delay, `code` is the actual
    /// failure identity (the envelope `code`, or `exit-<n>` for a dropped stream) surfaced on `.retrying`.
    case retryable(retryAfterMs: Int?, code: String)
    /// A framing / strict-decode failure on a stream line (surfaced while the child was alive). Carries
    /// the offending stage name.
    case contractMismatch(String)
}

// MARK: - Supervisor state

/// The user-visible supervisor state.
public enum SupervisorState: Equatable, Sendable {
    case idle
    case streaming
    /// A retry is scheduled: attempt number (1-based, counting the initial failed run), the next-retry
    /// wall-clock instant (ms since epoch), and the last exit code / envelope `code`.
    case retrying(attempt: Int, nextAtEpochMs: Int, lastCode: String)
    /// Terminal failure: the exit code, a `code`/reason string, the envelope `hint` (transient
    /// remediation, `nil` when absent — never fabricated), and the child's full captured `stderr`
    /// (UTF-8-decoded, empty when none). The contract requires exit, code/hint, AND stderr on the error
    /// surface, so none of these transient diagnostics are discarded.
    case failed(exit: Int32, code: String, hint: String?, stderr: String)
    /// Terminal contract-mismatch: the offending stage (framing/decode) + the child's captured stderr.
    case contractMismatch(stage: String, stderr: String)
    /// A clean detach — the watch exited 0 (a `stop()` or a deliberate detach).
    case detached
}

// MARK: - WatchSupervisor

/// The gated-backoff supervisor for the single periodically-polling subprocess (`brain watch --json`).
/// Spawns, streams typed events out, classifies the exit exhaustively, and either respawns behind a
/// gated exponential backoff or enters a terminal state. Backoff + the consecutive-failure counter
/// reset ONLY on a proven-healthy run (a `hello` followed by its first attached `heartbeat`), so a
/// watcher that repeatedly hellos then immediately faults still reaches the terminal cap.
public actor WatchSupervisor {
    private let runner: ProcessRunner
    private let binary: ResolvedBinary
    private let policy: BackoffPolicy
    private let transport: WatchTransport
    private let commandSchema: Data?
    /// The recurring command this supervisor spawns, ADMITTED through the enforcing `PeriodicScheduler` at
    /// init — not a bare literal. A supervisor asked to periodically spawn anything but `watch` throws
    /// `PeriodicScheduler.SchedulingError` at construction, so a timer-driven audited read is impossible at
    /// the spawn boundary (the only place a periodic subprocess is born), not merely discouraged.
    private let periodicCommand: String
    /// Injected sleeper (ms) — tests pass a recording no-op so backoff is asserted without real waits.
    private let sleeper: @Sendable (Int) async -> Void
    /// The SIGTERM→SIGKILL grace period for reaping a child that ignores SIGTERM (contract-mismatch reap
    /// and `stop()`). Injected short in tests so the never-hang guarantee is asserted without a real wait.
    private let reapGrace: Duration

    private var _state: SupervisorState = .idle
    private var stopped = false
    private var currentHandle: StreamHandle?
    /// Single-flight guard for `run` — set before the first suspension so concurrent callers cannot
    /// start overlapping watch lifecycles (which would orphan a spawned child).
    private var isRunning = false
    private var rng: any RandomNumberGenerator = SystemRandomNumberGenerator()

    /// The in-flight backoff sleep's completion continuation, if a retry is currently waiting. `stop()`
    /// resumes it so a pending backoff is interrupted immediately (never a 30 s / unbounded `retryAfterMs`
    /// stall on the run loop).
    private var backoffContinuation: CheckedContinuation<Void, Never>?
    private var backoffTask: Task<Void, Never>?

    /// First-spawn readiness. Resolves `true` the first time `runner.stream()` returns a handle (the
    /// watcher has actually spawned), or `false` if the supervisor reaches a terminal state before ANY
    /// spawn succeeds. The coordinator awaits this on initial start so persisted settings can never name a
    /// configuration whose watcher never launched (a stream-launch failure must not commit).
    private var readyResolved = false
    private var readyValue = false
    private var readyWaiters: [CheckedContinuation<Bool, Never>] = []

    private func signalReady(_ value: Bool) {
        guard !readyResolved else { return }
        readyResolved = true
        readyValue = value
        let waiters = readyWaiters
        readyWaiters.removeAll()
        for w in waiters { w.resume(returning: value) }
    }

    /// Await the first-spawn readiness signal (see `readyResolved`). Idempotent — every caller gets the
    /// same resolved value once it lands.
    public func awaitReady() async -> Bool {
        if readyResolved { return readyValue }
        return await withCheckedContinuation { readyWaiters.append($0) }
    }

    private let eventContinuation: AsyncStream<WatchEvent>.Continuation
    /// The post-coordination event stream the coordinator/reducers consume. Created once, never finished
    /// between runs (a `stop()` + re-`run()` for a new incarnation keeps yielding on the same stream).
    public nonisolated let events: AsyncStream<WatchEvent>

    private let stateContinuation: AsyncStream<SupervisorState>.Continuation
    /// Every state transition, in order, for the UI. Published on each `_state` change (streaming →
    /// retrying → failed/…), so a retry is user-visible (attempt / nextAt / lastCode), never a silent loop.
    public nonisolated let stateChanges: AsyncStream<SupervisorState>

    public var state: SupervisorState { _state }

    public init(
        runner: ProcessRunner,
        binary: ResolvedBinary,
        policy: BackoffPolicy = .default,
        reapGrace: Duration = .seconds(2),
        periodicCommand: String = "watch",
        sleeper: (@Sendable (Int) async -> Void)? = nil
    ) throws {
        // Admit the recurring command through the enforcing scheduler. Anything but `watch` throws here,
        // so a supervisor that would periodically spawn an audited read can never be constructed.
        var scheduler = PeriodicScheduler()
        try scheduler.register(command: periodicCommand)
        self.periodicCommand = periodicCommand
        self.runner = runner
        self.binary = binary
        self.policy = policy
        self.reapGrace = reapGrace
        self.transport = try WatchTransport(
            watchSchema: binary.bundle.watchSchema,
            errorEnvelopeSchema: binary.bundle.errorEnvelopeSchema
        )
        self.commandSchema = binary.bundle.schema(for: "watch")
        self.sleeper = sleeper ?? { ms in try? await Task.sleep(for: .milliseconds(ms)) }
        var cont: AsyncStream<WatchEvent>.Continuation!
        self.events = AsyncStream { cont = $0 }
        self.eventContinuation = cont
        var stateCont: AsyncStream<SupervisorState>.Continuation!
        self.stateChanges = AsyncStream { stateCont = $0 }
        self.stateContinuation = stateCont
    }

    /// Assigns the state AND publishes it on `stateChanges`, so every transition is observable.
    private func emit(_ newState: SupervisorState) {
        _state = newState
        stateContinuation.yield(newState)
        // A terminal state reached before any successful spawn resolves readiness as `false`, so the
        // coordinator's `awaitReady()` never hangs when the watcher never launches.
        switch newState {
        case .failed, .contractMismatch, .detached: signalReady(false)
        default: break
        }
    }

    /// Spawn → classify → backoff/terminal loop. The resume plan is passed at run time, never baked at
    /// init, so a re-attach for a new incarnation re-invokes `run` with a fresh `ResumeArg`.
    public func run(resumeArg: ResumeArg, options: WatchOptions) async {
        // Single-flight: the actor's `await`s make `run` reentrant, so a second concurrent caller would
        // spawn a second watcher, overwrite `currentHandle`, and orphan the first child unreaped. The
        // guard is set BEFORE the first suspension point, so it is decided under actor isolation.
        guard !isRunning else { return }
        isRunning = true
        defer { isRunning = false }
        stopped = false
        var consecutiveFailures = 0

        while !stopped {
            emit(.streaming)
            let outcome = await streamOnce(resumeArg: resumeArg, options: options)
            let stderr = Self.decodeStderr(outcome.stderr)

            switch outcome.exitClass {
            case .cleanDetach:
                emit(.detached)
                return
            case .terminal(let exit, let code, let hint):
                emit(.failed(exit: exit, code: code, hint: hint, stderr: stderr))
                return
            case .contractMismatch(let stage):
                emit(.contractMismatch(stage: stage, stderr: stderr))
                return
            case .retryable(let retryAfterMs, _):
                if stopped { emit(.detached); return }
                // A proven-healthy run clears the storm counter; a bare-hello-then-fault run does NOT.
                if outcome.provenHealthy { consecutiveFailures = 0 }
                consecutiveFailures += 1
                // Counter counts consecutive failed runs INCLUDING the initial one; the Nth failure
                // (N = cap) spawns no further attempt.
                if consecutiveFailures >= ConsoleConstants.watchMaxConsecutiveFailures {
                    emit(.failed(exit: -1, code: "watch-retry-cap-exhausted", hint: nil, stderr: stderr))
                    return
                }
                let delay = policy.delayMs(attempt: consecutiveFailures, retryAfterMs: retryAfterMs, using: &rng)
                // `delay` can be as large as an unbounded `retryAfterMs` floor (up to `Int.max`); a plain
                // `now + delay` would TRAP on overflow. Saturate to `Int.max` — the banner value is a hint,
                // never load-bearing for scheduling (the sleeper owns the wait).
                let (sum, overflow) = Self.nowEpochMs().addingReportingOverflow(delay)
                let nextAt = overflow ? Int.max : sum
                emit(.retrying(attempt: consecutiveFailures, nextAtEpochMs: nextAt, lastCode: lastCode(for: outcome.exitClass)))
                await backoffSleep(delay)
                if stopped { emit(.detached); return }
            }
        }
        emit(.detached)
    }

    /// SIGTERM (escalating to SIGKILL after the grace period) the live watch, wake any in-flight backoff
    /// sleep, await the child's exit, and cease all respawns. Leaves the shared `events` stream open so a
    /// subsequent `run()` (new incarnation) can keep yielding. Never hangs: a TERM-resistant child is
    /// reaped by the bounded escalation, and a pending backoff is interrupted immediately.
    public func stop() async {
        stopped = true
        wakeBackoff()
        if let handle = currentHandle { _ = await reap(handle) }
    }

    // MARK: - Interruptible backoff

    /// Sleeps the backoff `delay` (via the injected `sleeper`), but resolves EARLY if `stop()` wakes it —
    /// so a `stop()` during `.retrying` never blocks the run loop for the full (possibly unbounded
    /// `retryAfterMs`) delay. The `sleeper` runs in a child task that is cancelled once either the sleep
    /// completes or `stop()` fires.
    private func backoffSleep(_ delay: Int) async {
        let sleeper = self.sleeper
        backoffTask = Task { await sleeper(delay) }
        await withCheckedContinuation { (cont: CheckedContinuation<Void, Never>) in
            backoffContinuation = cont
            let task = backoffTask
            Task { await task?.value; self.wakeBackoff() }
        }
        backoffTask?.cancel()
        backoffTask = nil
    }

    /// Resumes a waiting backoff continuation exactly once (whichever of sleep-completion or `stop()` fires
    /// first wins). Idempotent — the second caller sees a nil continuation and no-ops.
    private func wakeBackoff() {
        backoffTask?.cancel()
        if let cont = backoffContinuation {
            backoffContinuation = nil
            cont.resume()
        }
    }

    /// Bounded SIGTERM→SIGKILL reap: terminate, schedule a SIGKILL backstop after `reapGrace`, and await
    /// completion. If SIGTERM lands the child within the grace window the backstop is cancelled; a
    /// TERM-resistant child is SIGKILLed, so `completion()` is always guaranteed to resolve.
    private func reap(_ handle: StreamHandle) async -> StreamCompletion {
        handle.terminate()
        let grace = reapGrace
        let escalate = Task { try? await Task.sleep(for: grace); handle.forceKill() }
        // SIGKILL kills the direct child, but `completion()` also waits for stderr EOF — and a descendant
        // that inherited the pipe can hold its write end open indefinitely, so EOF may never arrive. A
        // second backstop finalizes the handle with whatever was captured, making the reap TRULY bounded:
        // `stop()` / contract-mismatch handling can never hang on a surviving grandchild.
        let finalize = Task { try? await Task.sleep(for: grace * 2); handle.finalizeNow() }
        let completion = await handle.completion()
        escalate.cancel()
        finalize.cancel()
        return completion
    }

    // MARK: - One spawn

    /// The result of one spawn: the classified exit, whether it was proven healthy, and the child's full
    /// captured stderr (carried so a terminal state can surface it — never swallowed).
    private struct RunOutcome {
        let exitClass: ExitClass
        let provenHealthy: Bool
        let stderr: Data
    }

    /// Spawns one watch, streams its events out, and returns the classified exit + whether the run was
    /// proven healthy (a `hello` followed by its first attached `heartbeat`) + the captured stderr.
    private func streamOnce(resumeArg: ResumeArg, options: WatchOptions) async -> RunOutcome {
        let req = SpawnRequest(
            executable: binary.launch,
            arguments: Self.watchArgs(resumeArg: resumeArg, options: options),
            cwd: binary.bundle.checkoutRoot,
            environment: ChildEnvironment.nonEgress(inherited: binary.baseEnv),
            command: periodicCommand,
            commandSchema: commandSchema
        )

        let handle: StreamHandle
        do {
            handle = try runner.stream(req)
        } catch {
            // Spawn failure with no stream/envelope — treat as a retryable transient (dropped stream shape).
            return RunOutcome(exitClass: .retryable(retryAfterMs: nil, code: "spawn-failed"),
                              provenHealthy: false, stderr: Data())
        }
        currentHandle = handle
        defer { currentHandle = nil }
        // The watcher has actually spawned (runner.stream returned a handle) — resolve first-spawn
        // readiness so the coordinator's start() can prove the watcher launched before committing.
        signalReady(true)

        var lastEnvelope: ErrorEnvelope?
        var sawHello = false
        var provenHealthy = false
        var mismatchStage: String?

        do {
            for try await item in transport.items(from: handle) {
                switch item {
                case .event(let ev):
                    if case .hello = ev { sawHello = true }
                    if case .heartbeat(let hb) = ev, sawHello, hb.ledger.attached {
                        provenHealthy = true // a sustained stream: hello + its first attached heartbeat
                    }
                    eventContinuation.yield(ev)
                case .terminalEnvelope(let env):
                    lastEnvelope = env
                }
            }
        } catch {
            // A framing / strict-decode failure while the child may still be alive: reap the child with a
            // bounded SIGTERM→SIGKILL escalation, then classify as a terminal contract mismatch. A
            // TERM-resistant child is SIGKILLed, so this NEVER waits indefinitely on completion.
            mismatchStage = Self.mismatchStage(error)
            _ = await reap(handle)
        }

        let completion = await handle.completion()
        if let stage = mismatchStage {
            return RunOutcome(exitClass: .contractMismatch(stage), provenHealthy: provenHealthy,
                              stderr: completion.stderr)
        }
        return RunOutcome(exitClass: Self.classify(exit: completion.exitCode, envelope: lastEnvelope),
                          provenHealthy: provenHealthy, stderr: completion.stderr)
    }

    // MARK: - Classification (total over (exitCode, envelope?))

    /// Every `(exitCode, envelope?)` pair maps to exactly one `ExitClass` — no silent default.
    static func classify(exit: Int32, envelope: ErrorEnvelope?) -> ExitClass {
        // Clean detach.
        if exit == 0 { return .cleanDetach }
        // Structurally terminal by exit code alone (usage / config-vault-lock): zero restarts. The
        // envelope `code`/`hint` are still carried when present (never a fabricated hint when absent).
        if exit == 5 { return .terminal(exit, code: envelope?.code ?? "usage", hint: envelope?.hint) }
        if exit == 2 { return .terminal(exit, code: envelope?.code ?? "config-or-vault-or-lock", hint: envelope?.hint) }
        // Any other nonzero exit — decided by the final envelope when present.
        if let env = envelope {
            return env.retryable ? .retryable(retryAfterMs: env.retryAfterMs, code: env.code)
                                 : .terminal(exit, code: env.code, hint: env.hint)
        }
        // No parseable envelope: an on-contract brain code (1/3/4/6) with a dropped stream is the
        // expected-retryable shape (exit 4 / dropped stream) ⇒ retry; an OFF-contract code with no
        // envelope is a bug surface ⇒ terminal fail-fast, never a retry loop.
        if BrainExit(rawValue: exit) != nil {
            return .retryable(retryAfterMs: nil, code: "exit-\(exit)")
        }
        // No envelope ⇒ no hint to carry (never fabricated).
        return .terminal(exit, code: "off-contract-exit-no-envelope", hint: nil)
    }

    // MARK: - argv

    static func watchArgs(resumeArg: ResumeArg, options: WatchOptions) -> [String] {
        var args = ["watch", "--json"]
        if let pollMs = options.pollMs { args += ["--poll-ms", String(pollMs)] }
        if let hb = options.heartbeatSeconds { args += ["--heartbeat-seconds", String(hb)] }
        if case .sinceSeq(let seq) = resumeArg { args += ["--since-seq", String(seq)] }
        return args
    }

    // MARK: - Helpers

    private func lastCode(for cls: ExitClass) -> String {
        switch cls {
        case .terminal(_, let code, _): return code
        case .retryable(_, let code): return code
        case .contractMismatch(let stage): return stage
        case .cleanDetach: return "clean-detach"
        }
    }

    /// Decodes captured stderr for the error surface (UTF-8, lossy). Empty stderr ⇒ empty string.
    private static func decodeStderr(_ data: Data) -> String {
        String(decoding: data, as: UTF8.self)
    }

    private static func mismatchStage(_ error: Error) -> String {
        switch error {
        case is WatchDecodeError: return "decode"
        case let e as StreamParseError:
            switch e {
            case .blankLine: return "framing:blank-line"
            case .notJSONObject: return "framing:not-json-object"
            case .unclassifiable: return "decode:unclassifiable"
            }
        default: return "stream"
        }
    }

    /// Monotonic-ish wall-clock ms for the `nextAt` display hint. Not load-bearing for scheduling (the
    /// injected sleeper owns the wait) — purely a banner value.
    private static func nowEpochMs() -> Int {
        Int(Date().timeIntervalSince1970 * 1000.0)
    }
}

import Foundation

// MARK: - Errors

/// Failures the attach sequence raises before a live stream exists.
public enum AttachError: Error, Equatable, Sendable {
    /// The `--once` hello probe produced no parseable `hello` line.
    case noHello(detail: String)
    /// The `--once` probe exited non-zero.
    case onceProbeFailed(exit: Int32)
    /// The persisted resume cursor could not be loaded — surfaced instead of silently degrading to a
    /// live-only attach (which would skip the offline tail). Carries the underlying store message.
    case cursorLoadFailed(message: String)
    /// `start()` was called after the coordinator latched a terminal failure (a replacement-generation
    /// cursor-load failure) — it is unrecoverable and will not spawn again.
    case terminated
    /// The supervisor reached a terminal state before its watcher ever spawned (`runner.stream` never
    /// succeeded) — start() must NOT report success, so the caller never commits an unproven config.
    case watcherDidNotLaunch
}

// MARK: - Coordinator state

/// The coordinator's observable lifecycle, so a storage failure is surfaced as a typed terminal/degraded
/// state rather than silently swallowed into a valid-looking resume. Published on `stateChanges`.
public enum CoordinatorState: Equatable, Sendable {
    case idle
    /// Running the once-hello → cursor → plan → spawn sequence.
    case attaching
    /// A live stream is running; events flow to the reducers.
    case live
    /// A checkpoint write failed — resume state may lag, but the stream keeps running. Non-terminal
    /// (a later checkpoint can recover); surfaced so the UI can warn.
    case degraded(reason: String)
    /// A terminal failure (cursor-load or a replacement-generation failure): the coordinator stopped.
    case failed(reason: String)
}

// MARK: - AttachCoordinator

/// The SOLE owner of the attach/cursor/checkpoint sequence — the seam the supervisor, cursor store, and
/// resume planner deliberately do not wire themselves. It:
///   (1) spawns `brain watch --json --once`, reads exactly one `hello` (exit 0);
///   (2) derives the `IncarnationKey` from `hello.ledger.path` (detached ⇒ skip cursor, plan live-only);
///   (3) loads the persisted cursor;
///   (4) plans the `ResumeArg` via `ResumePlanner`;
///   (5) spawns the live stream through `WatchSupervisor` with that plan + effective option flags;
///   (6) consumes the supervisor's events, forwarding them, and CHECKPOINTS the cursor store ONLY on
///       safe attached heartbeats (never the pre-replay `min(n, prefix)` hello value, never a detached
///       heartbeat) — so it is the sole checkpoint writer, and no cursor is ever persisted above the
///       contiguous-prefix safe checkpoint.
///
/// On a fresh `hello` it always rebaselines (a Phase-6 reducer concern), but stops + re-plans ONLY for an
/// actual incarnation transition — a detached↔attached flip or a changed `ledger.path` (key mismatch).
/// The generation's own startup `hello` and any same-incarnation re-`hello` (e.g. after a supervisor
/// retry) rebaseline in place, never tearing down the watcher.
public actor AttachCoordinator {
    private let runner: ProcessRunner
    private let binary: ResolvedBinary
    private let cursors: any CursorStoring
    private let settings: Settings
    private let supervisor: WatchSupervisor
    private let onceDecoder: WatchEventDecoder
    private let commandSchema: Data?
    /// The schema-derived watch-option bounds. Persisted `Settings` are `Codable` from `UserDefaults`, so
    /// an out-of-range `pollMs`/`heartbeatSeconds` must be validated HERE — at the settings→argv boundary —
    /// before it can reach the CLI (an out-of-range value is dropped, so the flag is omitted).
    private let watchOptionPolicy: WatchOptionPolicy

    /// The current live incarnation's key; `nil` while detached / live-only (no cursor).
    private var currentIncarnationKey: String?
    private var supervisorTask: Task<Void, Never>?
    private var consumeTask: Task<Void, Never>?
    private var started = false
    /// Single-flight guard for `start()`. `started` is only set AFTER the awaits, so without this a second
    /// concurrent `start()` would pass the `started` check and spawn an overlapping watch lifecycle.
    private var attaching = false
    /// Raised on an incarnation transition: discard old-generation events (of every type) until the
    /// replacement generation's hello arrives. See `handle(_:)`.
    private var discardingUntilHello = false
    /// A one-way terminal latch. Set when a cursor-load failure (startup or a replacement generation) makes
    /// the coordinator unrecoverable. Once latched, no event is processed and no generation is ever spawned
    /// again — so a hello buffered behind a failed transition can never silently start a new watch while
    /// the lifecycle is `.failed`.
    private var terminated = false
    private var _state: CoordinatorState = .idle

    // MARK: - Consumer acknowledgement (no checkpoint before consumption)
    //
    // A yielded event is merely ENQUEUED on `events`; without a handshake the coordinator could checkpoint
    // the cursor before the reducer consumer drained the preceding replay events. When a consumer opts in
    // via `enableConsumerAcks()` and calls `consumed()` after handling each event, the coordinator awaits
    // that the consumer has drained every event yielded so far BEFORE it checkpoints — so the cursor can
    // never advance past state the reducers have actually observed.
    private var ackEnabled = false
    private var yieldedOrdinal = 0
    private var consumedOrdinal = 0
    /// A waiter resumes with `true` when the consumer has genuinely drained to its threshold, and with
    /// `false` when the barrier is ABORTED by `stop()` — the caller must then abandon the checkpoint (the
    /// consumer may have been cancelled without acknowledging, so advancing the cursor would step past
    /// unconsumed state).
    private var ackWaiters: [(threshold: Int, cont: CheckedContinuation<Bool, Never>)] = []
    /// Latched by `stop()`: once stopping, no checkpoint barrier is ever satisfied — a fresh
    /// `awaitConsumedAll()` returns `false` immediately and every suspended waiter is failed.
    private var stopping = false

    /// Opt into the consumption-before-checkpoint barrier. The consumer MUST then call `consumed()` after
    /// handling each event, or a checkpoint will block waiting for the ack.
    public func enableConsumerAcks() { ackEnabled = true }

    /// Acknowledge that the consumer finished handling one more forwarded event. Resumes any checkpoint
    /// waiter whose threshold is now met (with `true` — a genuine drain, not a stop-abort).
    public func consumed() {
        consumedOrdinal += 1
        ackWaiters.removeAll { waiter in
            if consumedOrdinal >= waiter.threshold { waiter.cont.resume(returning: true); return true }
            return false
        }
    }

    /// Forward an event on the public stream, counting it so the checkpoint barrier can wait for the
    /// consumer to catch up to this ordinal.
    private func forward(_ event: WatchEvent) {
        yieldedOrdinal += 1
        eventContinuation.yield(event)
    }

    /// Suspend until the consumer has acknowledged every event yielded so far. Returns `true` when the
    /// consumer genuinely drained to the current ordinal, `false` when the barrier was ABORTED by `stop()`
    /// (a no-op returning `true` when acks are not enabled, so non-UI callers that read `events` directly
    /// are unaffected). A `false` result means the caller MUST NOT checkpoint — the consumer may be gone
    /// without having acknowledged the pending events.
    private func awaitConsumedAll() async -> Bool {
        guard ackEnabled else { return true }
        if stopping { return false }
        guard consumedOrdinal < yieldedOrdinal else { return true }
        let threshold = yieldedOrdinal
        return await withCheckedContinuation { (cont: CheckedContinuation<Bool, Never>) in
            ackWaiters.append((threshold, cont))
        }
    }

    public var state: CoordinatorState { _state }

    private let eventContinuation: AsyncStream<WatchEvent>.Continuation
    /// The post-coordination stream the reducers consume (Phase 6).
    public nonisolated let events: AsyncStream<WatchEvent>

    private let stateContinuation: AsyncStream<CoordinatorState>.Continuation
    /// Every coordinator-lifecycle transition, so a storage failure surfaces as a typed degraded/terminal
    /// state instead of an invisible swallow.
    public nonisolated let stateChanges: AsyncStream<CoordinatorState>

    public init(
        runner: ProcessRunner,
        binary: ResolvedBinary,
        cursors: any CursorStoring,
        settings: Settings,
        supervisor: WatchSupervisor
    ) throws {
        self.runner = runner
        self.binary = binary
        self.cursors = cursors
        self.settings = settings
        self.supervisor = supervisor
        self.onceDecoder = try WatchEventDecoder(schema: binary.bundle.watchSchema)
        self.commandSchema = binary.bundle.schema(for: "watch")
        self.watchOptionPolicy = try WatchOptionPolicy(watchSchema: binary.bundle.watchSchema)
        var cont: AsyncStream<WatchEvent>.Continuation!
        self.events = AsyncStream { cont = $0 }
        self.eventContinuation = cont
        var stateCont: AsyncStream<CoordinatorState>.Continuation!
        self.stateChanges = AsyncStream { stateCont = $0 }
        self.stateContinuation = stateCont
    }

    /// Assigns + publishes the coordinator state.
    private func emit(_ newState: CoordinatorState) {
        _state = newState
        stateContinuation.yield(newState)
    }

    /// Once-hello → cursor → plan → `supervisor.run(...)`. The event consumer subscribes FIRST, then the
    /// supervisor task is started and retained WITHOUT awaiting its terminal completion, so a healthy
    /// watch streams indefinitely while its events flow to the reducers.
    public func start() async throws {
        // A latched terminal failure is unrecoverable — never silently no-op into a fake success, and
        // never spawn again.
        guard !terminated else { throw AttachError.terminated }
        guard !started else { return }
        // Single-flight, decided BEFORE the first suspension point (actor reentrancy would otherwise let a
        // concurrent caller past the `started` check — which is only set after the awaits below — and
        // spawn a second, overlapping watch lifecycle).
        guard !attaching else { return }
        attaching = true
        defer { attaching = false }
        emit(.attaching)
        // The event consumer subscribes FIRST and is created exactly once — a failed startup parks it on
        // the (still-empty) supervisor stream, ready for a retry, so there is never a second iterator on
        // the single-consumer `AsyncStream`.
        if consumeTask == nil { consumeTask = Task { await self.consume() } }
        do {
            try await beginGeneration(from: nil)
        } catch {
            // A failed startup (bad `--once` probe or an unreadable cursor) must NOT leave `started=true` —
            // a later `start()` would then silently no-op. Leave `started=false` so a retry proceeds, keep
            // the parked consumer, surface the failure, and rethrow.
            emit(.failed(reason: "\(error)"))
            throw error
        }
        started = true
        emit(.live)
    }

    /// SIGTERM the live watch, await its exit + run-loop task, and finish the coordinator's event stream.
    /// The caller awaits this before any rebuild.
    public func stop() async {
        // Latch stopping FIRST so no in-flight or subsequent heartbeat can checkpoint past this point.
        stopping = true
        await supervisor.stop()
        await supervisorTask?.value
        consumeTask?.cancel()
        // ABORT any checkpoint barrier still waiting on a consumer ack — the consumer is being cancelled,
        // so it may never acknowledge the pending events. Resume every waiter with `false` so the suspended
        // `awaitConsumedAll()` returns "aborted" and its caller SKIPS the checkpoint (never advancing the
        // cursor past state the reducers have not actually consumed) rather than proceeding as if drained.
        let waiters = ackWaiters
        ackWaiters.removeAll()
        for w in waiters { w.cont.resume(returning: false) }
        eventContinuation.finish()
    }

    // MARK: - Generation lifecycle

    /// Runs the once-hello → cursor → plan sequence and starts a fresh supervisor run. `transitionHello`
    /// is the mid-stream hello that triggered a re-plan (nil for the initial start, which uses a fresh
    /// `--once` probe).
    private func beginGeneration(from transitionHello: HelloPayload?) async throws {
        let hello: HelloPayload
        if let transitionHello {
            hello = transitionHello
        } else {
            hello = try await readOnceHello()
        }

        let key: String?
        let resumeArg: ResumeArg
        if hello.ledger.attached {
            let k = IncarnationKey.derive(ledgerPath: hello.ledger.path)
            // A cursor-load failure is NOT silently degraded to `-1` (unseen ⇒ live-only), which would
            // skip the offline tail. Surface it as a typed terminal failure so resume behaviour is never
            // fabricated from a storage error.
            let cursor: Int
            do {
                cursor = try cursors.load(incarnationKey: k)
            } catch {
                throw AttachError.cursorLoadFailed(message: "\(error)")
            }
            key = k
            resumeArg = ResumePlanner.plan(mode: settings.resumeMode, persistedCursor: cursor)
        } else {
            // Detached ⇒ skip the cursor entirely; plan live-only (nil cursor).
            key = nil
            resumeArg = ResumePlanner.plan(mode: settings.resumeMode, persistedCursor: nil)
        }
        currentIncarnationKey = key

        // Validate persisted overrides against the schema-derived bounds at the boundary — an out-of-range
        // value is dropped (flag omitted), never passed straight through to the CLI.
        let options = watchOptionPolicy.watchOptions(from: settings)
        let supervisor = self.supervisor
        supervisorTask = Task { await supervisor.run(resumeArg: resumeArg, options: options) }

        // On the INITIAL start, prove the watcher actually spawned (runner.stream succeeded) before
        // returning — so start() only reports success on a launched watcher, and a caller can never
        // persist a configuration whose stream never launched. A mid-stream transition (transitionHello
        // set) is already running on a proven watcher, so it does not re-gate.
        if transitionHello == nil {
            let ready = await supervisor.awaitReady()
            if !ready { throw AttachError.watcherDidNotLaunch }
        }
    }

    /// Spawns `brain watch --json --once` and decodes exactly one `hello`.
    private func readOnceHello() async throws -> HelloPayload {
        let req = SpawnRequest(
            executable: binary.launch,
            arguments: ["watch", "--json", "--once"],
            cwd: binary.bundle.checkoutRoot,
            environment: ChildEnvironment.nonEgress(inherited: binary.baseEnv),
            command: "watch",
            commandSchema: commandSchema
        )
        let result = try await runner.run(req)
        guard result.exitCode == 0 else { throw AttachError.onceProbeFailed(exit: result.exitCode) }
        let lines = result.stdout.split(separator: 0x0A, omittingEmptySubsequences: true)
        guard let first = lines.first else { throw AttachError.noHello(detail: "empty --once output") }
        let event = try onceDecoder.decode(Data(first))
        guard case .hello(let hello) = event else {
            throw AttachError.noHello(detail: "first --once line was not a hello")
        }
        return hello
    }

    // MARK: - Event consumption

    private func consume() async {
        // NB: the public `events` continuation is finished ONLY by `stop()`, never here. On a startup
        // rollback the consumer is cancelled (the loop ends), but `events` must stay open so a subsequent
        // successful `start()` retry keeps delivering. The supervisor's own `events` stream stays open
        // across its `stop()`/re-`run()`, so this loop only ends on cancellation.
        for await event in supervisor.events {
            await handle(event)
        }
    }

    private func handle(_ event: WatchEvent) async {
        // Terminal latch: once the coordinator has failed unrecoverably, no further event is processed
        // and — critically — no buffered hello can start another generation.
        guard !terminated else { return }
        // Generation barrier. The supervisor stream is shared and untagged, so after an incarnation
        // transition it can still hold events produced by the OLD watch — of ANY type (audit rows, daemon,
        // backup, watch.error), not just heartbeats. Every generation begins with a hello, so discarding
        // everything up to the next hello drops exactly the invalidated leftovers and nothing else.
        if discardingUntilHello {
            guard case .hello = event else { return }
            discardingUntilHello = false
        }
        switch event {
        case .hello(let hello):
            await handleHello(hello)
            // A transition that terminated the coordinator must NOT forward the invalidating hello — the
            // lifecycle is `.failed`. A successful (re)baseline forwards the hello as the new baseline.
            guard !terminated else { return }
            forward(event)
        case .heartbeat(let hb):
            // Generation guard, applied BEFORE forwarding: the shared, untagged supervisor stream can
            // queue an OLD-generation heartbeat behind a transition hello. Once the active generation has
            // flipped, that stale heartbeat is an invalidated-generation leftover — it must reach neither
            // the reducers (forwarded) NOR the cursor store (checkpointed). A heartbeat belongs to the
            // active generation iff its own ledger identity matches: an attached heartbeat's path must
            // derive the active key; a detached heartbeat is in-generation only while live-only (key nil).
            guard heartbeatIsCurrentGeneration(hb) else { return }
            forward(event)
            // Checkpoint ONLY on a safe attached heartbeat carrying resume.auditHeadSeq. A detached
            // heartbeat, or a heartbeat with no resume, is forwarded (for the UI) but never checkpoints.
            // The hello's pre-replay min(n, prefix) value is never persisted — only heartbeats reach here.
            guard hb.ledger.attached, let resume = hb.resume, let key = currentIncarnationKey else { return }
            // Do not advance the cursor before the reducers have consumed the preceding replay events
            // (and this heartbeat). When acks are enabled this suspends until the consumer catches up; a
            // `false` result means the barrier was ABORTED by `stop()` — abandon the checkpoint entirely
            // rather than advancing the cursor past state the consumer never acknowledged.
            guard await awaitConsumedAll() else { return }
            // A stop() may have latched between the suspension and here — re-check the terminal latch.
            guard !stopping else { return }
            do {
                try cursors.checkpoint(incarnationKey: key, seq: resume.auditHeadSeq, updatedAt: hb.at)
                if case .degraded = _state { emit(.live) } // recovered
            } catch {
                // A checkpoint failure is non-terminal (a later heartbeat can recover) but must be visible,
                // never a silent swallow that hides resume-state drift.
                emit(.degraded(reason: "checkpoint failed: \(error)"))
            }
        default:
            // Non-ledger events (audit rows, etc.) belong to the streaming generation; forward them.
            forward(event)
        }
    }

    /// Whether a heartbeat belongs to the CURRENT generation (so it may be forwarded/checkpointed). An
    /// attached heartbeat matches only when its ledger path derives the active incarnation key; a detached
    /// heartbeat matches only while the coordinator is live-only (no active key). Any other pairing is a
    /// buffered old-generation leftover from before an incarnation transition.
    private func heartbeatIsCurrentGeneration(_ hb: HeartbeatPayload) -> Bool {
        if hb.ledger.attached {
            return IncarnationKey.derive(ledgerPath: hb.ledger.path) == currentIncarnationKey
        }
        return currentIncarnationKey == nil
    }

    /// A fresh hello: rebaseline (Phase-6 reducer concern), and stop + re-plan ONLY on an actual
    /// incarnation transition (a detached↔attached flip or a changed ledger.path).
    private func handleHello(_ hello: HelloPayload) async {
        let newKey: String? = hello.ledger.attached
            ? IncarnationKey.derive(ledgerPath: hello.ledger.path)
            : nil

        if newKey == currentIncarnationKey {
            // Same incarnation (startup hello, or a same-incarnation re-hello after a supervisor retry):
            // rebaseline in place — no teardown.
            return
        }
        // Genuine transition: stop the old watch (SIGTERM + await both its process exit and its run-loop
        // task, discarding the invalidated generation), then re-run the sequence for the new incarnation.
        await supervisor.stop()
        await supervisorTask?.value
        supervisorTask = nil
        // Raise the generation barrier: every event still queued from the old watch — of any type — is
        // discarded until the replacement generation's own hello arrives.
        discardingUntilHello = true
        // The old generation is now invalidated; clear the active key BEFORE the re-plan so any old-gen
        // heartbeat still buffered in the stream cannot checkpoint against it (belt-and-braces with the
        // per-heartbeat path guard). `beginGeneration` re-derives + sets the new key.
        currentIncarnationKey = nil
        do {
            try await beginGeneration(from: hello)
        } catch {
            // A replacement-generation failure (cursor load for the new incarnation) is terminal, not an
            // invisible swallow: latch the terminal state, stop consuming, and surface it. The old watch is
            // already stopped, so no watch is running — and the latch guarantees a later buffered hello can
            // never quietly start a new generation while the lifecycle is `.failed`.
            terminated = true
            consumeTask?.cancel()
            emit(.failed(reason: "\(error)"))
        }
    }
}

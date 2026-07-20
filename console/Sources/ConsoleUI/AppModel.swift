import Foundation
import Observation
import ConsoleCore

// P6-Task-4 — the composition root + the @MainActor AppModel.
//
// Launch order is LOAD-BEARING: load Settings → resolve+probe both binaries → build the
// ContractBundle-derived inventories → construct reducers + TransitionRouter, obtain the coordinator's
// events, START and RETAIN the reducer-consumption task → only THEN AttachCoordinator.start(). So a fast
// child's hello/replay/checkpoint-heartbeat can never outrun its consumer. The same order applies on
// every settings rebuild.
//
// The privileged flow, supervisor, and coordinator each publish an AsyncStream of state changes; AppModel
// consumes all three on the main actor and mirrors them into @Observable properties, so every
// retry/terminal/challenge/authorize transition reaches SwiftUI (banners, modals, A11yAnnouncer) without
// polling actor snapshots.

// MARK: - Live session

/// A fully-constructed, ready-to-start session: the resolved binaries + every actor/reducer-feed the UI
/// binds. Built once per settings incarnation; a settings cutover builds a fresh one and swaps atomically.
public struct LiveSession: Sendable {
    public let brain: ResolvedBinary
    public let signer: ResolvedBinary
    public let runner: ProcessRunner
    public let supervisor: WatchSupervisor
    public let coordinator: AttachCoordinator
    public let flow: PrivilegedFlow
    public let egress: EgressAction
    public let readExecutor: ReadCommandExecutor
    public let router: OperationRouter
    public let jobs: JobStateCoordinator
    public let authorizableOps: [String]
    public let egressKeySource: EgressKeySource

    public init(brain: ResolvedBinary, signer: ResolvedBinary, runner: ProcessRunner,
                supervisor: WatchSupervisor, coordinator: AttachCoordinator, flow: PrivilegedFlow,
                egress: EgressAction, readExecutor: ReadCommandExecutor, router: OperationRouter,
                jobs: JobStateCoordinator, authorizableOps: [String], egressKeySource: EgressKeySource) {
        self.brain = brain; self.signer = signer; self.runner = runner
        self.supervisor = supervisor; self.coordinator = coordinator; self.flow = flow
        self.egress = egress; self.readExecutor = readExecutor; self.router = router
        self.jobs = jobs; self.authorizableOps = authorizableOps; self.egressKeySource = egressKeySource
    }
}

/// Builds a `LiveSession` from resolved binaries + a runner + a cursor store. Shared by the default
/// resolution factory and by tests (which pass a scripted runner + a temp cursor store).
public enum SessionBuilder {
    public static func build(
        brain: ResolvedBinary,
        signer: ResolvedBinary,
        runner: ProcessRunner,
        cursors: any CursorStoring,
        settings: Settings,
        sleeper: (@Sendable (Int) async -> Void)? = nil
    ) throws -> LiveSession {
        let supervisor = try WatchSupervisor(runner: runner, binary: brain, sleeper: sleeper)
        let coordinator = try AttachCoordinator(runner: runner, binary: brain, cursors: cursors,
                                                settings: settings, supervisor: supervisor)
        let router = OperationRouter(bundle: brain.bundle)
        let flow = try PrivilegedFlow(runner: runner, brain: brain, signer: signer, router: router,
                                      validator: SignerContractValidator(),
                                      configRoot: brain.bundle.checkoutRoot)
        let readExecutor = ReadCommandExecutor(runner: runner, binary: brain)
        let jobs = JobStateCoordinator(reader: JobsListReader(), invoker: readExecutor)
        let ops = AuthorizableOpSet.derive(from: brain.bundle).sorted()
        return LiveSession(
            brain: brain, signer: signer, runner: runner, supervisor: supervisor,
            coordinator: coordinator, flow: flow, egress: EgressAction(),
            readExecutor: readExecutor, router: router, jobs: jobs,
            authorizableOps: ops, egressKeySource: settings.egressCapabilityKeySource)
    }
}

/// Resolves binaries for the given settings/env, then builds a session backed by the real logging runner
/// and the on-disk resume-cursor store. This is the production factory; tests inject their own.
public typealias SessionFactory = @Sendable (Settings, [String: String]) async throws -> LiveSession

public func defaultSessionFactory(_ settings: Settings, _ env: [String: String]) async throws -> LiveSession {
    let runner = ProcessRunnerComposition().runner
    let inputs = settings.resolutionInputs()
    let brain = try await BinaryResolution.resolve(.brain, inputs: inputs, env: env, runner: runner)
    let signer = try await BinaryResolution.resolve(.signer, inputs: inputs, env: env,
                                                    runner: runner, brainAnchor: brain.contractAnchor)
    let support = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask).first
        ?? FileManager.default.temporaryDirectory
    let dbPath = support.appendingPathComponent("com.atlas.console/console.sqlite")
    let cursors = try CursorStore(path: dbPath)
    return try SessionBuilder.build(brain: brain, signer: signer, runner: runner,
                                    cursors: cursors, settings: settings)
}

// MARK: - App phase

/// The top-level application phase the root scene renders.
public enum AppPhase: Equatable, Sendable {
    case probing
    case blocked(reason: String, path: String, remediation: String)
    case setupNeeded
    case running
}

// MARK: - Banner state

/// The transition-derived banner/badge surface state (control-plane signals from `TransitionRouter`).
public struct BannerState: Equatable, Sendable {
    public var reachability = DaemonReachability()
    public var backupHealthy: Bool? = nil
    public var reattaching = false
    public var anchorDegradedSource: String? = nil
    public var servicesNotInstalled: Set<String> = []
    /// A `db.restore` high-space audit event was observed this session (a restore is/was in flight).
    public var restoreObserved = false
    /// The number of `evidence.retry_enqueued` high-space events observed this session.
    public var evidenceRetryCount = 0
    public init() {}
}

// MARK: - AppModel

@MainActor
@Observable
public final class AppModel {
    // Injected seams.
    private let settingsStore: SettingsStore
    private let environment: [String: String]
    private let announcer: A11yAnnouncer
    private let sessionFactory: SessionFactory

    // Lifecycle.
    public private(set) var phase: AppPhase = .probing
    private var session: LiveSession?
    private var currentSettings: Settings = .defaults
    private var consumeTask: Task<Void, Never>?
    private var supervisorObserveTask: Task<Void, Never>?
    private var flowObserveTask: Task<Void, Never>?
    private var coordinatorStateTask: Task<Void, Never>?
    /// Single-flight guard for `launch()`. Set synchronously before the first suspension point so a
    /// repeated or concurrent `.task { launch() }` (or any double invocation) cannot spawn a second,
    /// overlapping session/watcher and clobber the retained task handles.
    private var launchInFlight = false

    // Reducers (mutated only on the main actor).
    private var dashboardReducer = DashboardReducer()
    private var auditReducer = AuditReducer()
    private var transitionRouter = TransitionRouter()
    private var checkpointReached = false
    private var jobsSeeded = false
    /// Bumped on every session cutover. An async result (a jobs refresh, a query) captured from the old
    /// session is discarded when it returns against a newer generation, so a delayed task can never
    /// publish another vault's data into the current session.
    private var sessionGeneration = 0
    /// True while a settings cutover is in flight — single-flights `applySettings` and drives the Apply
    /// button's disabled state.
    public private(set) var isApplyingSettings = false

    /// Test-only observation hook: fired with an audit row's `seq` at the instant it is folded into the
    /// timeline. Used to prove (from a `CursorStoring` checkpoint spy) that the reducers consumed the
    /// preceding replay events before the cursor advanced. `nil` in production.
    var onAuditConsumed: (@Sendable (Int) -> Void)?

    // Observable UI surface.
    public private(set) var settingsNotice: SettingsLoadNotice?
    public private(set) var dashboard = DashboardState()
    public private(set) var auditTimeline: [AuditPayload] = []
    public private(set) var modelCalls: [ModelCallPayload] = []
    public private(set) var jobRows: [JobListRowState] = []
    public private(set) var banners = BannerState()
    public private(set) var supervisorState: SupervisorState = .idle
    public private(set) var flowState: PrivilegedFlowState = .idle
    public private(set) var coordinatorState: CoordinatorState = .idle
    public private(set) var currentChallenge: AuthorizationChallenge?
    public private(set) var lastQueryResult: QueryResult?
    public private(set) var lastQueryError: String?
    public private(set) var settingsError: String?
    /// The last jobs-refresh failure, surfaced on the jobs surface. A read failure must be visible, not
    /// swallowed into a silent no-op.
    public private(set) var jobsError: String?

    /// The authorizable-op list the Actions surface enumerates (empty until a session is live).
    public var authorizableOps: [String] { session?.authorizableOps ?? [] }

    /// The currently-focused object's fields (e.g. the selected run/quarantine/source id), which the
    /// Actions surface pre-fills focused-object operands from. Surfaces set this on selection.
    public private(set) var selectedFocus: [String: String] = [:]

    /// Record the current UI selection so the Actions surface can pre-fill focused-object operands.
    public func select(focus fields: [String: String]) { selectedFocus = fields }

    /// Dismiss the corrupt-settings reset notice once the operator has acknowledged it.
    public func dismissSettingsNotice() { settingsNotice = nil }

    /// Record a selected audit-timeline row as the current focus. This is the concrete selection→focus
    /// wiring the audit surface invokes: a selected run pre-fills the `runId` operand of the run-scoped
    /// privileged ops (`git approve`/`git rollback`) on the Actions surface. (Jobs/model-call rows carry
    /// no focusable operand; source/quarantine focus arrives with those surfaces.)
    public func selectAuditFocus(_ row: AuditPayload) { select(focus: ["runId": row.runId]) }

    /// The schema-driven descriptor for an authorizable op (operands + kinds + UI sources), or nil when the
    /// op is unsupported/undescribed. The Actions surface builds its operand controls from this — never a
    /// hand-built per-command form.
    public func operationDescriptor(for op: String) -> OperationDescriptor? {
        session?.router.descriptor(for: op)
    }

    /// The live session's operation router (test seam — the UI drives `beginAction`, not `bind` directly).
    var activeRouter: OperationRouter? { session?.router }

    /// The currently-loaded settings, so the Settings surface starts from the live values (never blanks
    /// that would erase existing overrides on Apply).
    public var currentSettingsSnapshot: Settings { currentSettings }

    /// A control-safe, non-dumping description of a flow state (never `String(describing:)`, which would
    /// render hostile challenge data outside `ControlSafeText`).
    public func flowStateLabel(_ state: PrivilegedFlowState) -> String {
        switch state {
        case .idle: return "idle"
        case .export(let op): return "exporting \(ControlSafeText.plain(op))"
        case .display: return "awaiting authorization"
        case .sign: return "signing"
        case .authorize: return "authorizing"
        case .authorizeRetry: return "retrying authorization"
        case .retry: return "retrying"
        case .done: return "done"
        case .failed(let reason): return "failed: \(ControlSafeText.plain(reason))"
        }
    }

    public init(
        settingsStore: SettingsStore = SettingsStore(),
        environment: [String: String] = ProcessInfo.processInfo.environment,
        announcer: A11yAnnouncer = A11yAnnouncer(),
        sessionFactory: @escaping SessionFactory = defaultSessionFactory
    ) {
        self.settingsStore = settingsStore
        self.environment = environment
        self.announcer = announcer
        self.sessionFactory = sessionFactory
    }

    // MARK: - Launch (wire-then-start)

    /// Load settings → resolve+probe → WIRE the reducer consumer → start the coordinator.
    public func launch() async {
        // Single-flight + idempotent: a second concurrent launch is a no-op, and once a session is live a
        // repeat launch never rebuilds it (settings changes go through `applySettings`, which tears the
        // prior session down first). Both guards are set/read synchronously before any await, so actor
        // reentrancy cannot slip a second launch past them.
        guard !launchInFlight, session == nil else { return }
        launchInFlight = true
        defer { launchInFlight = false }
        phase = .probing
        let load = settingsStore.load()
        currentSettings = load.settings
        settingsNotice = load.notice

        // No repo-layout config and no override/env ⇒ the blocking setup state (prompt for atlasRoot).
        guard hasResolvableConfig(currentSettings) else {
            phase = .setupNeeded
            return
        }

        let built: LiveSession
        do {
            built = try await sessionFactory(currentSettings, environment)
        } catch let e as BlockingResolutionError {
            phase = .blocked(reason: "binary unavailable", path: e.path, remediation: e.remediation)
            return
        } catch {
            phase = .blocked(reason: "\(error)", path: "", remediation: "Check the atlas install and try again.")
            return
        }

        await wireAndStart(built)
    }

    /// Whether a session can be resolved at all: an explicit override/atlasRoot in Settings, or one of the
    /// resolution env vars. Absent all of these, the launch lands in `.setupNeeded`.
    private func hasResolvableConfig(_ s: Settings) -> Bool {
        if s.atlasRoot != nil || s.brainPathOverride != nil || s.signerPathOverride != nil { return true }
        return environment[ResolutionEnv.atlasRoot] != nil
            || environment[ResolutionEnv.brainPath] != nil
            || environment[ResolutionEnv.signerPath] != nil
    }

    /// Wire the reducer consumer + actor-state observers FIRST, then start the coordinator. On a start
    /// failure the phase becomes `.blocked` and the half-wired session is torn down.
    private func wireAndStart(_ built: LiveSession) async {
        resetReducers()
        observe(built)          // subscribe BEFORE start — no event can outrun its consumer
        await built.coordinator.enableConsumerAcks()   // no checkpoint before the reducers consume
        do {
            try await built.coordinator.start()
        } catch {
            await teardownObservers(for: built)
            phase = .blocked(reason: "attach failed: \(error)", path: "", remediation: "Check the daemons and vault, then retry.")
            return
        }
        session = built
        phase = .running
    }

    // MARK: - Observation

    /// Subscribe to the session's three streams. Public-ish (internal) so focused tests can drive a single
    /// actor without the full launch path.
    func observe(_ s: LiveSession) {
        observeCoordinator(s.coordinator)
        observeSupervisor(s.supervisor)
        observeFlow(s.flow)
    }

    func observeCoordinator(_ coordinator: AttachCoordinator) {
        consumeTask = Task { [weak self] in
            for await event in coordinator.events {
                guard let self else { return }
                await self.handle(event)
                // Acknowledge consumption so the coordinator's checkpoint barrier can only advance the
                // cursor after the reducers have observed this (and every preceding) event.
                await coordinator.consumed()
            }
        }
        coordinatorStateTask = Task { [weak self] in
            for await state in coordinator.stateChanges {
                guard let self else { return }
                self.coordinatorState = state
            }
        }
    }

    func observeSupervisor(_ supervisor: WatchSupervisor) {
        supervisorObserveTask = Task { [weak self] in
            for await state in supervisor.stateChanges {
                guard let self else { return }
                self.ingestSupervisorState(state)
            }
        }
    }

    func observeFlow(_ flow: PrivilegedFlow) {
        flowObserveTask = Task { [weak self] in
            for await state in flow.stateChanges {
                guard let self else { return }
                self.ingestFlowState(state)
            }
        }
    }

    private func teardownObservers(for s: LiveSession) async {
        consumeTask?.cancel(); supervisorObserveTask?.cancel()
        flowObserveTask?.cancel(); coordinatorStateTask?.cancel()
        await s.coordinator.stop()
    }

    // MARK: - Actor-state mirroring (+ announcements)

    func ingestSupervisorState(_ state: SupervisorState) {
        supervisorState = state
        switch state {
        case .retrying(let attempt, _, _): announcer.announce(.watchRetrying(attempt))
        case .failed, .contractMismatch: announcer.announce(.watchFailed)
        default: break
        }
    }

    func ingestFlowState(_ state: PrivilegedFlowState) {
        let previous = flowState
        flowState = state
        switch state {
        case .display(let challenge):
            currentChallenge = challenge
            announcer.announce(.challengeArrived)
        case .export:
            // A re-export from a POST-display state (nonce expiry / signer re-export) means the prior
            // challenge is no longer valid — announce the expiry so the operator is never left believing a
            // stale challenge is still signable.
            switch previous {
            case .idle, .export: break   // the initial export, not a re-export
            default: announcer.announce(.challengeExpired)
            }
            currentChallenge = nil
        case .done:
            currentChallenge = nil
            announcer.announce(.completed("Authorization"))
        case .failed(let reason):
            // A failed flow is a TERMINAL outcome — announce it (never leave a screen-reader user stranded
            // on the "busy" utterance beginAction posted). The reason is control-safe.
            currentChallenge = nil
            announcer.announce(.failed("Authorization: \(ControlSafeText.plain(reason))"))
        case .idle:
            currentChallenge = nil
            // A transition to Idle from any in-flight state is an operator CANCEL (or a signer exit-4
            // decline) — a terminal outcome that must be announced so the "busy" utterance is closed out.
            // Idle→Idle (the initial state) is not a cancellation and stays silent.
            switch previous {
            case .idle, .done, .failed: break
            default: announcer.announce(.cancelled("Authorization"))
            }
        default:
            break
        }
    }

    // MARK: - Watch-event reducer feed

    /// Reset EVERY piece of session-scoped state at a cutover.
    ///
    /// Resetting only the reducers leaves the previous vault's data observable: `modelCalls`, `jobRows`,
    /// `auditTimeline`, banners and — most dangerously — `selectedFocus`, which pre-fills privileged
    /// operands and could seed an authorization for the OLD vault's object in the NEW vault. Query results
    /// and the jobs-seeded latch are equally session-scoped. `sessionGeneration` is bumped so a delayed
    /// task from the old session cannot publish into the new one.
    private func resetReducers() {
        dashboardReducer = DashboardReducer()
        auditReducer = AuditReducer()
        transitionRouter = TransitionRouter()
        checkpointReached = false
        jobsSeeded = false
        sessionGeneration &+= 1

        dashboard = DashboardState()
        auditTimeline = []
        modelCalls = []
        jobRows = []
        banners = BannerState()
        selectedFocus = [:]
        lastQueryResult = nil
        lastQueryError = nil
        currentChallenge = nil
        supervisorState = .idle
        coordinatorState = .idle
    }

    private func handle(_ event: WatchEvent) async {
        // Control-plane signals first (banners/badges/empty states) — never blocks the data feed.
        let signals = transitionRouter.apply(event)
        applySignals(signals)

        switch event {
        case .hello(let hello):
            dashboardReducer.rebaseline(from: hello)
            auditReducer.incorporateHello(baselinePrefix: hello.resume?.auditHeadSeq ?? -1)
            checkpointReached = false
            dashboard = dashboardReducer.state
            auditTimeline = auditReducer.timeline
        case .heartbeat(let hb):
            if hb.ledger.attached, hb.resume != nil, !checkpointReached {
                dashboardReducer.markCheckpointReached()
                checkpointReached = true
                dashboard = dashboardReducer.state
            }
        case .audit(let a):
            let routing = auditReducer.apply(a)
            dashboardReducer.apply(event)
            auditTimeline = auditReducer.timeline
            dashboard = dashboardReducer.state
            // High-space signals drive the restore/evidence-retry surfaces (they never touch the timeline).
            if case .highSpaceSignal(let kind) = routing {
                switch kind {
                case .restore: banners.restoreObserved = true
                case .evidenceRetry: banners.evidenceRetryCount += 1
                default: break
                }
            }
            onAuditConsumed?(a.seq)
        case .backup(let b):
            dashboardReducer.apply(event)
            dashboard = dashboardReducer.state
            if !b.healthy { announcer.announce(.backupUnhealthy) }
        case .daemon(let d):
            dashboardReducer.apply(event)
            dashboard = dashboardReducer.state
            if !d.reachable { announcer.announce(.daemonUnreachable(d.daemon)) }
        case .job(let j):
            announceJob(j)
            if jobsSeeded, let jobs = session?.jobs {
                Task { [weak self] in
                    try? await jobs.apply(j)
                    let rows = await jobs.rows
                    await MainActor.run { self?.jobRows = rows }
                }
            }
        case .modelCall(let m):
            modelCalls.append(m)   // insert-only, session-scoped
        case .watchError, .unknown:
            break                  // watch.error(ledger) already produced a `.reattaching` signal above
        }
    }

    private func announceJob(_ j: JobPayload) {
        switch j.state {
        case "failed": announcer.announce(.jobFailed(j.jobId))
        case "succeeded", "completed", "done": announcer.announce(.jobSucceeded(j.jobId))
        default: break
        }
    }

    private func applySignals(_ signals: [UISignal]) {
        for signal in signals {
            switch signal {
            case .reachability(let r): banners.reachability = r
            case .attached: banners.reattaching = false
            case .detachedLedger: break
            case .reattaching: banners.reattaching = true
            case .anchorDegraded(let source): banners.anchorDegradedSource = source
            case .backupHealth(let healthy): banners.backupHealthy = healthy
            case .serviceNotInstalled(let daemon): banners.servicesNotInstalled.insert(daemon)
            }
        }
    }

    // MARK: - Read-on-focus surfaces

    /// Explicit read-on-focus refresh of the jobs list (never on a timer).
    public func refreshJobs() async {
        guard let jobs = session?.jobs else { return }
        // Announce the in-flight read so a screen-reader user is never left with a silent spinner.
        // The completion announcement is NOT deferred: a `defer` announces success even when the read
        // failed, telling a screen-reader user the refresh completed when it did not.
        announcer.announce(.busy("Jobs refresh"))
        let generation = sessionGeneration
        do {
            try await jobs.refresh()
            let rows = await jobs.rows
            // A cutover during the read invalidates this result — never publish another vault's rows.
            guard generation == sessionGeneration else { return }
            jobsSeeded = true
            jobRows = rows
            jobsError = nil
            announcer.announce(.completed("Jobs refresh"))
        } catch {
            guard generation == sessionGeneration else { return }
            // A read failure is non-fatal (the dashboard's snapshot counts remain) but must be VISIBLE —
            // previously it was swallowed by a no-op assignment and announced as a success.
            jobsError = ControlSafeText.plain("\(error)")
            announcer.announce(.failed("Jobs refresh"))
        }
    }

    // MARK: - Actions surface (intent criterion 3)

    /// True while a privileged flow is mid-transaction (a settings cutover must gate on this).
    public var isPrivilegedFlowInFlight: Bool {
        switch flowState {
        case .export, .display, .sign, .authorize, .authorizeRetry, .retry: return true
        case .idle, .done, .failed: return false
        }
    }

    /// Drive a UI-initiated privileged flow (the Actions surface). Renders every state from the stream.
    public func beginAction(op: String, focus: FocusContext, entry: [String: String]) async {
        guard let flow = session?.flow else { return }
        // Announce the privileged subprocess activity (export) so it is never a silent spinner; the
        // matching completion rides the flow's .done transition (see ingestFlowState).
        announcer.announce(.busy("Authorization"))
        await flow.begin(op: op, focus: focus, entry: entry)
    }

    /// Confirm the displayed challenge (Display → Sign).
    public func confirmChallenge() async { await session?.flow.confirm() }

    /// Cancel the active privileged flow (Display → Idle).
    public func cancelFlow() async { await session?.flow.cancel() }

    // MARK: - Query surface (explicit action only)

    /// Run an explicit `query` through the egress action with the settings-selected key source. Never
    /// polled — only this user action invokes it.
    public func runQuery(_ text: String) async {
        guard let session else { return }
        lastQueryError = nil
        announcer.announce(.busy("Query"))
        // NOT deferred: a `defer` announces "completed" even when the query failed.
        let generation = sessionGeneration
        let provider = EgressKeyProvider(settingsSource: session.egressKeySource,
                                         envProvider: { [environment] in environment })
        do {
            let result = try await session.egress.query(text, runner: session.runner,
                                                         brain: session.brain, key: provider)
            // A cutover during the query invalidates this result — never publish it into a new session.
            guard generation == sessionGeneration else { return }
            lastQueryResult = result
            announcer.announce(.completed("Query"))
        } catch {
            guard generation == sessionGeneration else { return }
            lastQueryError = ControlSafeText.plain("\(error)")
            announcer.announce(.failed("Query"))
        }
    }

    // MARK: - Settings cutover (probe before persist; atomic-or-rolled-back)

    /// `applySettings`: gate on any in-flight privileged flow → probe the candidate WITHOUT saving → on
    /// success stop+await the old coordinator, start the replacement, and commit the candidate ONLY after
    /// the replacement's first successful spawn → on failure restore the prior coordinator and keep the
    /// prior persisted settings. Persisted state can never name a configuration that was not proven live.
    public func applySettings(_ candidate: Settings) async {
        // Single-flight: `applySettings` suspends at the probe and the teardown, so two concurrent Apply
        // taps could both clear the initial checks, overwrite each other's observer task handles, start
        // overlapping watchers, and persist settings that do not match the retained session. The guard is
        // set BEFORE the first suspension; `isApplyingSettings` also drives the Apply button's disabled
        // state so the UI reflects the in-flight cutover.
        guard !isApplyingSettings else { return }
        isApplyingSettings = true
        defer { isApplyingSettings = false }
        settingsError = nil
        // (1) gate on any in-flight privileged flow.
        if isPrivilegedFlowInFlight {
            settingsError = "a privileged flow is in progress — finish or cancel it before changing settings"
            return
        }
        // An unchanged save does not re-probe — BUT only when a session is already live. From
        // .setupNeeded/.blocked (no session), re-applying identical settings must still attempt a start
        // (a retry), never silently no-op into a still-broken state.
        if candidate == currentSettings, session != nil {
            settingsStore.save(candidate)
            return
        }
        // (2) probe the candidate WITHOUT saving — a probe failure leaves persisted settings + the running
        // coordinator untouched.
        let candidateSession: LiveSession
        do {
            candidateSession = try await sessionFactory(candidate, environment)
        } catch {
            settingsError = "settings probe failed: \(error)"
            return
        }
        // (3) probe succeeded ⇒ stop + await the old coordinator (if any), then start the replacement. The
        // prior session is dropped only after its teardown; the candidate is NOT assigned until its start
        // is verified.
        let hadPrior = session != nil
        if let prior = session { await teardownObservers(for: prior) }
        session = nil
        resetReducers()
        observe(candidateSession)
        await candidateSession.coordinator.enableConsumerAcks()
        do {
            try await candidateSession.coordinator.start()
        } catch {
            // (4) the replacement failed to start ⇒ tear the failed candidate down FULLY, then restore the
            // prior config. Never commit the candidate; never leave a half-wired candidate live.
            await teardownObservers(for: candidateSession)
            await restorePriorConfiguration(hadPrior: hadPrior, startError: error)
            return
        }
        // Commit only after the replacement's first verified spawn (readiness-gated by the coordinator).
        session = candidateSession
        currentSettings = candidate
        settingsStore.save(candidate)
        phase = .running   // a valid cutover from .setupNeeded/.blocked reaches running without a relaunch
    }

    /// Restore the prior, still-persisted configuration after a candidate cutover failed to start. The
    /// restored session is assigned ONLY after its start is verified; if restoration itself fails (or there
    /// was no prior to restore), the session is cleared and the app enters `.blocked` — never left
    /// `.running` with a stopped/unstarted session while claiming success.
    private func restorePriorConfiguration(hadPrior: Bool, startError: Error) async {
        guard hadPrior else {
            // We came from .setupNeeded/.blocked — there is no prior live config to restore.
            session = nil
            phase = .blocked(reason: "settings start failed", path: "",
                             remediation: "The configuration could not start: \(startError)")
            settingsError = "settings failed to start: \(startError)"
            return
        }
        do {
            let restored = try await sessionFactory(currentSettings, environment)
            resetReducers()
            observe(restored)
            await restored.coordinator.enableConsumerAcks()
            do {
                try await restored.coordinator.start()
            } catch {
                // The restored candidate built but failed to start — tear it down fully and fail closed.
                await teardownObservers(for: restored)
                throw error
            }
            session = restored          // assign only after verified readiness
            phase = .running
            settingsError = "replacement failed to start: \(startError) — prior settings retained"
        } catch {
            // Restoration construction/start also failed — do NOT keep a session claiming success.
            session = nil
            phase = .blocked(reason: "restoration failed", path: "",
                             remediation: "The prior configuration could not be restored: \(error)")
            settingsError = "replacement failed to start (\(startError)); restoration also failed: \(error)"
        }
    }
}

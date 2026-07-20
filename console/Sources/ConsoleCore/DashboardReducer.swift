import Foundation

// MARK: - Dashboard reducer (snapshot + live overlay)
//
// The dashboard is `hello.snapshot` overlaid by live events, EACH FIELD WITH EXACTLY ONE DERIVATION:
//   • live-updated  — backup{watermarkSeq,healthy}, audit.headSeq, daemon reachability, openRuns —
//                     recomputed only AFTER the post-replay checkpoint heartbeat (`markCheckpointReached`).
//   • baseline-seeded — jobs{queued,failed} (owned by JobStateCoordinator, mirrored in here at rebaseline).
//   • snapshot-only  — quarantineCount, backup.coveredSeq, audit.anchorOk/anchorSource — held at the last
//                     `hello` value, labelled "as of <hello.at>", never fabricated between hellos.
// Replay-phase rows (before the checkpoint) are already reflected in `snapshot.openRuns`, so their
// run-state deltas MUST NOT re-apply.

/// Live-updated + snapshot-only backup view. `coveredSeq` is snapshot-only (the live `backup` event
/// omits it); `watermarkSeq`/`healthy` are live-updated.
public struct BackupView: Equatable, Sendable {
    public var watermarkSeq: Int
    public var coveredSeq: Int?      // snapshot-only
    public var healthy: Bool
    public init(watermarkSeq: Int, coveredSeq: Int?, healthy: Bool) {
        self.watermarkSeq = watermarkSeq; self.coveredSeq = coveredSeq; self.healthy = healthy
    }
}

/// `headSeq` is live-updated (from the audit reducer's contiguous head); `anchorOk`/`anchorSource` are
/// snapshot-only.
public struct AuditView: Equatable, Sendable {
    public var headSeq: Int
    public var head: String
    public var anchorOk: Bool?          // snapshot-only
    public var anchorSource: String?    // snapshot-only
    public init(headSeq: Int, head: String, anchorOk: Bool?, anchorSource: String?) {
        self.headSeq = headSeq; self.head = head; self.anchorOk = anchorOk; self.anchorSource = anchorSource
    }
}

/// Per-daemon reachability (live-updated from `daemon` events; seeded from the hello snapshot).
public struct DaemonView: Equatable, Sendable {
    public var broker: Bool?
    public var egress: Bool?
    public init(broker: Bool? = nil, egress: Bool? = nil) { self.broker = broker; self.egress = egress }
}

/// The rendered dashboard. Absent ledger-derived keys stay `nil` (rendered "as of <snapshotAsOf>"),
/// NEVER fabricated as `0`.
public struct DashboardState: Equatable, Sendable {
    public var openRuns: Int?
    public var jobs: JobCounts?
    public var quarantineCount: Int?
    public var backup: BackupView?
    public var audit: AuditView?
    public var daemons: DaemonView
    /// `hello.at` — the "as of" label for the snapshot-only fields.
    public var snapshotAsOf: String

    public init(openRuns: Int? = nil, jobs: JobCounts? = nil, quarantineCount: Int? = nil,
                backup: BackupView? = nil, audit: AuditView? = nil,
                daemons: DaemonView = DaemonView(), snapshotAsOf: String = "") {
        self.openRuns = openRuns; self.jobs = jobs; self.quarantineCount = quarantineCount
        self.backup = backup; self.audit = audit; self.daemons = daemons; self.snapshotAsOf = snapshotAsOf
    }
}

/// The run-lifecycle classification used for the `openRuns` delta.
enum RunLifecycle {
    case start, terminal, neither
    /// `run.started` opens a run; a run-ENDING outcome closes one; everything else is a non-delta.
    ///
    /// Closers are the outcomes that retire the run that a `run.started` opened:
    /// `run.integrated`/`run.rejected`/`run.failed`/`run.cancelled`.
    ///
    /// `run.refreshed` and `run.rolled_back` are deliberately NON-deltas:
    ///  • `run.refreshed` re-derives an existing run and leaves it review-pending (still open) — counting
    ///    it as a closer would decrement an unrelated open run.
    ///  • `run.rolled_back` is a distinct rollback run with NO matching `run.started` in this stream, so
    ///    decrementing on it would under-count the genuinely-open runs.
    /// `run.planned`/read/projection kinds are likewise neither (in-progress or transient reads).
    static func classify(_ eventType: String) -> RunLifecycle {
        switch eventType {
        case "run.started": return .start
        case "run.integrated", "run.rejected", "run.failed", "run.cancelled": return .terminal
        default: return .neither
        }
    }
}

public struct DashboardReducer: Sendable {
    public private(set) var state = DashboardState()
    /// Tracks the contiguous audit head + timeline so `audit.headSeq` has one derivation shared with
    /// `AuditReducer`. Fed on every run-space `audit` event (before and after checkpoint); only the
    /// dashboard *overlay* is gated on the checkpoint.
    private var auditReducer = AuditReducer()
    private var checkpointReached = false

    public init() {}

    /// Full re-baseline: clear live-overlay state and rebuild every field from the hello snapshot.
    public mutating func rebaseline(from hello: HelloPayload) {
        checkpointReached = false
        auditReducer.incorporateHello(baselinePrefix: hello.resume?.auditHeadSeq ?? -1)
        let snap = hello.snapshot
        state = DashboardState(
            openRuns: snap.openRuns.map { $0.values.reduce(0, +) },
            jobs: snap.jobs.map { JobCounts(queued: $0.queued, failed: $0.failed) },
            quarantineCount: snap.quarantineCount,
            backup: snap.backup.map { BackupView(watermarkSeq: $0.watermarkSeq, coveredSeq: $0.coveredSeq, healthy: $0.healthy) },
            audit: snap.audit.map { AuditView(headSeq: $0.headSeq, head: $0.head, anchorOk: $0.anchorOk, anchorSource: $0.anchorSource) },
            daemons: DaemonView(broker: snap.daemons.broker.reachable, egress: snap.daemons.egress.reachable),
            snapshotAsOf: hello.at
        )
    }

    /// The post-replay checkpoint heartbeat has arrived — begin the live overlay. Recompute the derived
    /// audit head from everything accumulated so far (replayed rows included) exactly once here.
    public mutating func markCheckpointReached() {
        checkpointReached = true
        if state.audit != nil {
            state.audit?.headSeq = auditReducer.displayedAuditHead
            syncAuditHeadGit()
        }
    }

    /// Resolve the displayed git head against the head SEQ. A present head row governs — including when
    /// its schema-optional `gitHead` is absent, in which case the previous head is CLEARED rather than
    /// left stale against a newer seq. With no head row at all (a hello-baselined head), the snapshot's
    /// head is preserved.
    private mutating func syncAuditHeadGit() {
        guard auditReducer.hasDisplayedAuditHeadRow else { return }
        // A present head row governs. `gitHead` is schema-optional ("absent when the DDL column is
        // NULL"), and the contract renders "no head commit" as the EMPTY string (snapshot `audit.head`:
        // "the refs/audit/runs head commit, or empty when no events exist"). So an absent gitHead clears
        // the stale previous head rather than leaving it attached to a newer seq.
        state.audit?.head = auditReducer.displayedAuditHeadGitHead ?? ""
    }

    /// Overlay a live event. A run-state delta before the checkpoint is a no-op (already in the snapshot).
    public mutating func apply(_ event: WatchEvent) {
        switch event {
        case .audit(let a):
            // Always track head/timeline; a high-space event never touches the dashboard.
            guard case .timeline(let inserted) = auditReducer.apply(a) else { return }
            guard checkpointReached else { return }
            // Resolve BOTH head fields from the contiguous head seq (never from the arriving row): with
            // seq N+1 arriving before seq N, the arriving row does not close the gap, so neither headSeq
            // nor its git head may move to it. Idempotent under a duplicate, so refresh either way.
            state.audit?.headSeq = auditReducer.displayedAuditHead
            syncAuditHeadGit()
            // openRuns deltas apply ONLY on a newly-inserted seq — a duplicate (at-least-once redelivery)
            // must not re-count the run lifecycle.
            guard inserted else { return }
            applyRunDelta(a.eventType)
        case .backup(let b):
            guard checkpointReached else { return }
            state.backup = BackupView(watermarkSeq: b.watermarkSeq,
                                      coveredSeq: state.backup?.coveredSeq,  // snapshot-only, preserved
                                      healthy: b.healthy)
        case .daemon(let d):
            guard checkpointReached else { return }
            switch d.daemon {
            case "broker": state.daemons.broker = d.reachable
            case "egress": state.daemons.egress = d.reachable
            default: break
            }
        default:
            break   // hello/heartbeat/job/model_call/watchError/unknown have no dashboard-field derivation here
        }
    }

    /// Adjust `openRuns` for a run-lifecycle event. Never fabricates a count when the ledger-derived
    /// `openRuns` is absent (detached), and floors at 0 (a terminal without a tracked start can't go negative).
    private mutating func applyRunDelta(_ eventType: String) {
        guard let current = state.openRuns else { return }
        switch RunLifecycle.classify(eventType) {
        case .start: state.openRuns = current + 1
        case .terminal: state.openRuns = max(0, current - 1)
        case .neither: break
        }
    }
}

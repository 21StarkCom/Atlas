import Foundation

// MARK: - Audit reducer (run-space-only)
//
// The audit timeline is a projection over `audit` watch events restricted to the run.* seq space
// (`seq < DB_EVENT_SEQ_BASE`). The disjoint high-space (`db.*` + `evidence.retry_enqueued`, allocated
// from `DB_EVENT_SEQ_BASE = 10^12`) is live-only signal — routed OUT, never into the timeline, never
// advancing the head or the resume cursor. Order is by `seq`, not arrival; a gap in the run-space
// prefix is a pending intent (never pruned), so the displayed head is the contiguous-prefix maximum.

/// Where an `audit` event is routed by `AuditReducer.apply`.
public enum AuditRouting: Equatable, Sendable {
    /// A run.* event in the seq-ordered timeline. `inserted` is `true` only for a NEW seq; a duplicate
    /// (at-least-once redelivery) is `inserted: false` so downstream overlays (openRuns, git-head) apply
    /// exactly once and never re-count on a replayed/redelivered row.
    case timeline(inserted: Bool)
    /// A high-space (`seq >= DB_EVENT_SEQ_BASE`) live-only event — surfaced as a signal, never timelined.
    case highSpaceSignal(HighSpaceKind)
}

/// The four high-space audit kinds. Classified from the event's `eventType`, not its seq (the seq only
/// decides *whether* it is high-space; the eventType decides *which* signal).
public enum HighSpaceKind: Equatable, Sendable {
    case backup            // db.backup
    case restore           // db.restore
    case forceUnblock      // db.force_unblock
    case evidenceRetry     // evidence.retry_enqueued
    /// A high-space seq whose eventType is not one of the four known high-space kinds — surfaced rather
    /// than silently dropped (fail-loud on an additive ledger-internal kind).
    case unknown(String)

    static func classify(_ eventType: String) -> HighSpaceKind {
        switch eventType {
        case "db.backup": return .backup
        case "db.restore": return .restore
        case "db.force_unblock": return .forceUnblock
        case "evidence.retry_enqueued": return .evidenceRetry
        default: return .unknown(eventType)
        }
    }
}

/// A pure, fixture-driven reducer over run-space `audit` events. `incorporateHello(baselinePrefix:)`
/// MUST be called on every `hello` before any row (a full re-baseline); the baseline seeds the
/// contiguous-prefix head so an existing-ledger attach does not freeze on a phantom gap below the
/// reported prefix.
public struct AuditReducer: Sendable, Equatable {
    /// The contiguous-prefix baseline: `-1` = replayAll / fresh / detached; a reported
    /// `hello.resume.auditHeadSeq` = the existing-ledger live-only baseline.
    private var baseline: Int = -1
    /// Observed run-space seqs (>= 0, `< DB_EVENT_SEQ_BASE`), used to compute the contiguous prefix.
    private var observed: Set<Int> = []
    /// Run-space rows kept in `seq` order, deduped by `seq`.
    private var rows: [AuditPayload] = []
    /// Cached contiguous-prefix maximum (`max { s : baseline < k <= s ⇒ k observed }`, else baseline).
    private var head: Int = -1

    public init() {}

    /// Full re-baseline — clears all accumulated state and seeds the contiguous-prefix baseline.
    /// `baselinePrefix = hello.resume?.auditHeadSeq ?? -1`.
    public mutating func incorporateHello(baselinePrefix: Int) {
        baseline = baselinePrefix
        observed = []
        rows = []
        head = baselinePrefix
    }

    /// Accept an `audit` event. A run-space event (`seq < DB_EVENT_SEQ_BASE`) enters the timeline in
    /// `seq` order and may advance the contiguous head; a high-space event is routed to its signal and
    /// never touches the timeline, head, or cursor.
    @discardableResult
    public mutating func apply(_ audit: AuditPayload) -> AuditRouting {
        guard audit.seq < ConsoleConstants.dbEventSeqBase else {
            return .highSpaceSignal(HighSpaceKind.classify(audit.eventType))
        }
        // Run-space. Ignore a duplicate seq (idempotent); insert in seq order otherwise.
        guard !observed.contains(audit.seq) else { return .timeline(inserted: false) }
        observed.insert(audit.seq)
        let idx = rows.firstIndex { $0.seq > audit.seq } ?? rows.count
        rows.insert(audit, at: idx)
        recomputeHead()
        return .timeline(inserted: true)
    }

    private mutating func recomputeHead() {
        var h = baseline
        while observed.contains(h + 1) { h += 1 }
        head = h
    }

    /// Max contiguous run-space seq observed (the displayed audit head). Never advanced by a high-space
    /// event; never advanced past a gap in the run-space prefix.
    public var displayedAuditHead: Int { head }

    /// The `gitHead` of the row AT the current contiguous head seq — `nil` at the baseline (no row) or
    /// when that row carries no git head. Resolving the head's git head from the contiguous head seq (not
    /// from the arriving row) keeps `displayedAuditHead` and its git head consistent under out-of-order
    /// delivery: an out-of-order seq that does not close the gap must not overlay its git head.
    public var displayedAuditHeadGitHead: String? {
        rows.first { $0.seq == head }?.gitHead
    }

    /// Whether a row for the displayed head seq is actually present in the timeline.
    ///
    /// This distinguishes the two cases `displayedAuditHeadGitHead == nil` conflates: **no head row at
    /// all** (the head came from a hello baseline, so the snapshot's head must be preserved) versus **a
    /// present head row whose `gitHead` is schema-optional and absent** (the stale previous head must be
    /// cleared, not carried forward against the new seq).
    public var hasDisplayedAuditHeadRow: Bool {
        rows.contains { $0.seq == head }
    }

    /// The contiguous-committed-prefix high-water — the seq safe to persist as the resume cursor.
    /// Identical to `displayedAuditHead`: only the gapless prefix is safe to checkpoint (a later
    /// out-of-order seq above a still-open gap must not advance the cursor).
    public var safeCheckpointSeq: Int { head }

    /// The run-space timeline, in `seq` order.
    public var timeline: [AuditPayload] { rows }
}

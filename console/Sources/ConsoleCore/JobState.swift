import Foundation

// MARK: - Per-job count map (snapshot-plus-delta seed)
//
// The `hello.snapshot.jobs` aggregate carries no per-job identity, so the queued/failed counts cannot
// be adjusted live from `job` events without double-counting. Instead we seed a per-`jobId` state map
// from a fully-consumed `jobs list` pagination, buffer live `job` events during the multi-page read,
// merge by recency (`updatedAt`), then recompute the counts from the map. A `job` event for an unseen
// `jobId` triggers a full re-read (never a synthetic insert — the event carries no `createdAt`).

/// A `jobs list` row (the paginated read-command item shape, `jobs-list.schema.json`).
public struct JobRow: Decodable, Equatable, Sendable {
    public let jobId: String
    public let workflow: String
    public let state: String
    public let attempts: Int
    public let maxAttempts: Int
    public let updatedAt: String
    public let nextRunAt: String?
    public let lastError: String?

    public init(jobId: String, workflow: String, state: String, attempts: Int, maxAttempts: Int,
                updatedAt: String, nextRunAt: String? = nil, lastError: String? = nil) {
        self.jobId = jobId; self.workflow = workflow; self.state = state
        self.attempts = attempts; self.maxAttempts = maxAttempts
        self.updatedAt = updatedAt; self.nextRunAt = nextRunAt; self.lastError = lastError
    }
}

/// The `{queued, failed}` aggregate, recomputed from the per-job map. Derivation mirrors the CLI's
/// `status`/`watch` snapshot (`apps/cli/src/health/snapshot.ts`): queued = states {pending, ready,
/// running}; failed = state `failed`.
public struct JobCounts: Equatable, Sendable {
    public let queued: Int
    public let failed: Int
    public init(queued: Int, failed: Int) { self.queued = queued; self.failed = failed }

    static let queuedStates: Set<String> = ["pending", "ready", "running"]
    static let failedState = "failed"
}

/// The result of applying a live `job` event to the map.
public enum JobApplyResult: Equatable, Sendable {
    /// The event's `jobId` was already seeded; the row was overwritten iff newer (or left as-is if stale).
    case applied
    /// The event's `jobId` was never seeded — a full reseed is required (carries the unseen jobId).
    case needsReseed(String)
}

/// The per-`jobId` state map. Pure; recency-merges by `updatedAt` and recomputes counts on demand.
public struct JobStateMap: Sendable, Equatable {
    /// jobId → (state, updatedAt). Only the two fields the count derivation needs are retained.
    private var rows: [String: (state: String, updatedAt: String)] = [:]

    public init() {}

    public static func == (lhs: JobStateMap, rhs: JobStateMap) -> Bool {
        guard lhs.rows.count == rhs.rows.count else { return false }
        for (k, v) in lhs.rows {
            guard let r = rhs.rows[k], r.state == v.state, r.updatedAt == v.updatedAt else { return false }
        }
        return true
    }

    /// Seed from a fully-consumed, deduped pagination, then replay buffered live events by recency.
    ///
    /// Membership is REBUILT from the fresh pages — it is a re-baseline, not a merge onto whatever was
    /// there before. A job absent from the fresh list is genuinely gone (completed + pruned) and must not
    /// linger from a prior seed, and a buffered event for an id the list does not confirm must NOT be
    /// synthetically inserted (that would count a ghost). Buffered events overlay confirmed ids only,
    /// where recency still governs: a list row never clobbers a newer streamed state.
    public mutating func seed(fromPages pages: [JobRow], buffered: [JobPayload]) {
        var fresh: [String: (state: String, updatedAt: String)] = [:]
        for row in pages {
            // Duplicate `jobId` across pages resolved by recency, so page order is irrelevant.
            if let existing = fresh[row.jobId], row.updatedAt < existing.updatedAt { continue }
            fresh[row.jobId] = (row.state, row.updatedAt)
        }
        rows = fresh
        for ev in buffered where rows[ev.jobId] != nil {
            upsert(jobId: ev.jobId, state: ev.state, updatedAt: ev.updatedAt)
        }
    }

    /// Apply a live `job` event. Overwrite iff `updatedAt >= existing.updatedAt`; `.needsReseed` when the
    /// `jobId` is unseen (never a synthetic insert).
    @discardableResult
    public mutating func apply(_ job: JobPayload) -> JobApplyResult {
        guard rows[job.jobId] != nil else { return .needsReseed(job.jobId) }
        upsert(jobId: job.jobId, state: job.state, updatedAt: job.updatedAt)
        return .applied
    }

    /// Recency-merge upsert: overwrite iff the incoming `updatedAt` is >= the stored one (RFC-3339 ms
    /// UTC strings compare lexicographically == chronologically). A fresh key always inserts.
    private mutating func upsert(jobId: String, state: String, updatedAt: String) {
        if let existing = rows[jobId], updatedAt < existing.updatedAt { return }
        rows[jobId] = (state, updatedAt)
    }

    public func contains(_ jobId: String) -> Bool { rows[jobId] != nil }

    public var counts: JobCounts {
        var q = 0, f = 0
        for (_, v) in rows {
            if JobCounts.queuedStates.contains(v.state) { q += 1 }
            else if v.state == JobCounts.failedState { f += 1 }
        }
        return JobCounts(queued: q, failed: f)
    }
}

/// Errors the paginating reader raises.
public enum JobsListReadError: Error, Equatable, Sendable {
    case invalidPayload(String)
    /// A page advanced by zero rows while still reporting `hasMore` — refused rather than looping forever.
    case nonAdvancingPagination(offset: Int)
}

/// The single read-command gateway seam. Phase 3 injects a fixture; phase 6 passes
/// `ReadCommandExecutor.run` — the ONE live read gateway (schema-validating), so the reader never holds a
/// raw `ProcessRunner`. `run` returns the validated `--json` stdout bytes of a read-class command.
public protocol ReadInvoker: Sendable {
    func run(_ command: String, args: [String]) async throws -> Data
}

/// Fully-consuming `jobs list --json` paginator. Walks `offset` until `pagination.hasMore` is false at
/// the contract max page size (500), returning every row **deduplicated by `jobId`** in list order (which
/// the CLI already sorts `createdAt` desc, `jobId` tiebreak). Never runs on a timer — driven only by
/// `JobStateCoordinator`'s seed/reseed protocol. Reads route exclusively through the `ReadInvoker`
/// gateway; the reader holds no runner and mints no capability.
public struct JobsListReader: Sendable {
    public static let pageLimit = 500
    public init() {}

    /// The decoded `jobs list --json` payload shape (strict — no defensive parsing; the gateway has
    /// already schema-validated, and a shape mismatch here surfaces as `invalidPayload`).
    private struct Page: Decodable {
        struct Pagination: Decodable { let limit: Int; let offset: Int; let total: Int; let hasMore: Bool }
        let jobs: [JobRow]
        let pagination: Pagination
    }

    /// Walk every page through the read gateway, deduplicating by `jobId` (a concurrent insert can shift
    /// the offset window and repeat a row across a page boundary — first occurrence wins, preserving the
    /// CLI's total order).
    public func readAll(invoker: ReadInvoker) async throws -> [JobRow] {
        var all: [JobRow] = []
        var seen = Set<String>()
        var offset = 0
        while true {
            let bytes = try await invoker.run(
                "jobs list",
                args: ["--json", "--limit", "\(Self.pageLimit)", "--offset", "\(offset)"])
            let page: Page
            do {
                page = try JSONDecoder().decode(Page.self, from: bytes)
            } catch {
                throw JobsListReadError.invalidPayload("\(error)")
            }
            for row in page.jobs where !seen.contains(row.jobId) {
                seen.insert(row.jobId)
                all.append(row)
            }
            if !page.pagination.hasMore { break }
            // Advance by the rows actually returned so a short page still makes progress; refuse a page
            // that claims `hasMore` yet returned nothing (would loop forever).
            guard !page.jobs.isEmpty else { throw JobsListReadError.nonAdvancingPagination(offset: offset) }
            offset += page.jobs.count
        }
        return all
    }
}

/// One list-row's rendered state: the `jobs list` row overlaid by the latest live `job` event (recency
/// merge). The view surface `JobStateCoordinator.rows` returns these in the CLI's `createdAt`-desc,
/// `jobId`-tiebreak order (the list order — the client never re-derives the sort; it has no `createdAt`).
public struct JobListRowState: Equatable, Sendable {
    public let jobId: String
    public var workflow: String
    public var state: String
    public var attempts: Int
    public var maxAttempts: Int
    public var updatedAt: String
    public var nextRunAt: String?
    public var lastError: String?

    init(row: JobRow) {
        jobId = row.jobId; workflow = row.workflow; state = row.state
        attempts = row.attempts; maxAttempts = row.maxAttempts
        updatedAt = row.updatedAt; nextRunAt = row.nextRunAt; lastError = row.lastError
    }

    /// A public memberwise initializer so the UI (Phase 6) can synthesize a display row directly (e.g. a
    /// fixture render) without a `jobs list` read. The live path still goes through `init(row:)` + merge.
    public init(jobId: String, workflow: String, state: String, attempts: Int, maxAttempts: Int,
                updatedAt: String, nextRunAt: String? = nil, lastError: String? = nil) {
        self.jobId = jobId; self.workflow = workflow; self.state = state
        self.attempts = attempts; self.maxAttempts = maxAttempts
        self.updatedAt = updatedAt; self.nextRunAt = nextRunAt; self.lastError = lastError
    }

    /// Recency-merge a live event over this row: the event wins iff `event.updatedAt >= updatedAt`
    /// (a list row never clobbers a newer streamed state). Returns whether the merge took effect.
    @discardableResult
    mutating func merge(_ e: JobPayload) -> Bool {
        guard e.updatedAt >= updatedAt else { return false }
        workflow = e.workflow; state = e.state; attempts = e.attempts; maxAttempts = e.maxAttempts
        updatedAt = e.updatedAt; nextRunAt = e.nextRunAt; lastError = e.lastError
        hasStreamedOverlay = true   // this row now carries live streamed state
        return true
    }

    /// Whether this row carries a live streamed overlay (a `job` event was merged onto it). Only such
    /// rows may survive a refresh — a row that is merely a previous LIST read must never win over a
    /// freshly-read row, least of all at an equal `updatedAt`.
    var hasStreamedOverlay = false

    /// Recency-merge a prior STREAMED overlay onto a freshly re-read list row: the prior wins iff
    /// `prior.updatedAt >= updatedAt`. This preserves a newer streamed state that was applied live before
    /// a refresh/reseed re-read a stale list row. A prior row with no streamed overlay is ignored — at an
    /// equal timestamp the fresh list row is the more authoritative of the two.
    @discardableResult
    mutating func mergeNewer(from prior: JobListRowState) -> Bool {
        guard prior.hasStreamedOverlay else { return false }
        guard prior.updatedAt >= updatedAt else { return false }
        workflow = prior.workflow; state = prior.state; attempts = prior.attempts
        maxAttempts = prior.maxAttempts; updatedAt = prior.updatedAt
        nextRunAt = prior.nextRunAt; lastError = prior.lastError
        hasStreamedOverlay = true   // the surviving state is streamed-derived
        return true
    }
}

/// The SOLE owner of the seed/reseed protocol and the only component that drives `JobsListReader`. An
/// actor so list membership, live overlays, and the single-in-flight-read invariant stay consistent under
/// concurrent `apply`s. Reentrancy is confined to the one `await` inside `runSeedLoop` (the `readAll`);
/// events that arrive during that suspension land in `pendingBuffer` and are merged when the read
/// completes — never starting a second read, never mutating a map that is about to be replaced.
public actor JobStateCoordinator {
    private let reader: JobsListReader
    private let invoker: ReadInvoker

    /// List membership in CLI order (`createdAt` desc, `jobId` tiebreak), with live state overlaid.
    private var orderedRows: [JobListRowState] = []
    /// `jobId` → index into `orderedRows`, for O(1) membership + in-place overlay.
    private var indexByID: [String: Int] = [:]
    private var seeded = false

    /// The single in-flight seed/reseed operation, retained so concurrent `seed()`/`refresh()` callers
    /// AWAIT it (and observe its outcome, success or failure) instead of returning early on stale/unseeded
    /// state. Only one protocol run is ever live; `apply` buffers into `pendingBuffer` rather than starting
    /// a second read.
    private var inFlight: Task<Void, Error>?
    /// Live events received while a read is in flight (or before the first seed) — merged, in order, once
    /// the read completes. Every event received during suspension is retained here.
    private var pendingBuffer: [JobPayload] = []

    public init(reader: JobsListReader, invoker: ReadInvoker) {
        self.reader = reader
        self.invoker = invoker
    }

    /// Force the initial seed (first attach). Idempotent, and concurrency-safe: a second caller arriving
    /// while a seed is in flight awaits that same operation (and its error), never returning on stale rows.
    public func seed() async throws {
        if seeded && inFlight == nil { return }
        try await drive()
    }

    /// Apply a live `job` event. A seen `jobId` recency-merges in place; an unseen `jobId` (or an
    /// unseeded coordinator) buffers the event and drives exactly one reseed. Never a synthetic insert:
    /// an unseen id is materialized ONLY when the fresh list confirms its membership.
    public func apply(_ job: JobPayload) async throws {
        if inFlight != nil || !seeded {
            // A read is already in flight (or we have never seeded) — buffer and let the in-flight loop
            // (or the seed we are about to start) fold this event in. Single in-flight read enforced.
            pendingBuffer.append(job)
            if inFlight == nil && !seeded { try await drive() }
            return
        }
        if let i = indexByID[job.jobId] {
            orderedRows[i].merge(job)   // seen id — in-place recency merge, no read
            return
        }
        // Unseen id — buffer it and reseed once (the fresh list confirms membership before we insert).
        pendingBuffer.append(job)
        try await drive()
    }

    /// Explicit read-on-focus: a full protocol re-read that re-baselines list membership + order.
    /// Concurrency-safe like `seed()` — awaits an in-flight run rather than starting a second one.
    public func refresh() async throws {
        try await drive()
    }

    /// Drive one protocol run, or await the one already in flight. Retaining the `Task` lets every
    /// seed/refresh caller await the SAME operation and see its result; `apply` buffers concurrently.
    private func drive() async throws {
        if let task = inFlight {
            try await task.value
            return
        }
        let task = Task { try await self.runSeedProtocol() }
        inFlight = task
        do {
            try await task.value
        } catch {
            inFlight = nil
            throw error
        }
        // Clear `inFlight` BEFORE draining: the drain may need to start a fresh protocol run for an
        // unseen id, and with `inFlight` still set that call would await this finished task instead.
        inFlight = nil
        // Completion window: an `apply` that ran after `runSeedProtocol` drained the buffer but before
        // `inFlight` was cleared saw `inFlight != nil`, buffered its event, and returned with no protocol
        // left to consume it. Drain any such stragglers here, while still on the actor. Events for
        // list-confirmed ids merge in place; an unseen id drives one more protocol run.
        try await drainCompletionWindow()
    }

    /// Consume events that landed in `pendingBuffer` during the gap between the protocol draining the
    /// buffer and `inFlight` being cleared. Bounded: each pass either merges everything (done) or
    /// re-runs the protocol once for an unseen id, which itself re-drains.
    private func drainCompletionWindow() async throws {
        guard !pendingBuffer.isEmpty else { return }
        let straggling = pendingBuffer
        pendingBuffer = []
        var needsReseed = false
        for ev in straggling {
            if let i = indexByID[ev.jobId] {
                orderedRows[i].merge(ev)
            } else {
                // Unseen id — re-buffer it so the next protocol run folds it in against a fresh list.
                pendingBuffer.append(ev)
                needsReseed = true
            }
        }
        if needsReseed { try await drive() }
    }

    /// Run the seed/reseed protocol ONCE: read every page, then recency-merge (a) the prior confirmed
    /// overlays and (b) the buffered live events over the fresh membership. Exactly one pagination — an id
    /// that arrived during the read but is absent from the fresh list is dropped (a later event re-drives
    /// its own reseed), never synthesized into membership.
    private func runSeedProtocol() async throws {
        // Prior overlaid rows — their live state must survive a re-read that returns a staler list row.
        let priorRows = orderedRows
        // Snapshot the buffer, then read. Events arriving during the read append to `pendingBuffer`.
        let carried = pendingBuffer
        pendingBuffer = []
        let pages: [JobRow]
        do {
            pages = try await reader.readAll(invoker: invoker)   // sole suspension point
        } catch {
            // The read failed: the events we carried out of the buffer would otherwise be lost forever.
            // Restore them AHEAD of anything that arrived during the failed read, preserving arrival
            // order, so a later successful retry still folds them in.
            pendingBuffer = carried + pendingBuffer
            throw error
        }
        let arrivedDuringRead = pendingBuffer
        pendingBuffer = []
        let bufferedEvents = carried + arrivedDuringRead

        // Rebuild membership + order from the fresh list.
        var rows: [JobListRowState] = []
        var index: [String: Int] = [:]
        for row in pages {
            index[row.jobId] = rows.count
            rows.append(JobListRowState(row: row))
        }
        // Recency-merge the prior confirmed overlays onto the fresh membership (list-confirmed ids only):
        // a stale list row must not clobber a newer streamed state applied live before this read.
        for prior in priorRows {
            guard let i = index[prior.jobId] else { continue }
            rows[i].mergeNewer(from: prior)
        }
        // Overlay buffered events ONLY onto ids the list confirms (no synthetic insert). Recency wins;
        // both merges gate on `updatedAt`, so the final state is the max regardless of application order.
        for ev in bufferedEvents {
            guard let i = index[ev.jobId] else { continue }
            rows[i].merge(ev)
        }
        orderedRows = rows
        indexByID = index
        seeded = true
    }

    /// List rows in `createdAt`-desc / `jobId`-tiebreak order (the CLI's order), live state overlaid.
    public var rows: [JobListRowState] { orderedRows }

    /// `{queued, failed}` recomputed from current row membership (queued = pending/ready/running).
    public var counts: JobCounts {
        var q = 0, f = 0
        for r in orderedRows {
            if JobCounts.queuedStates.contains(r.state) { q += 1 }
            else if r.state == JobCounts.failedState { f += 1 }
        }
        return JobCounts(queued: q, failed: f)
    }

    public func contains(_ jobId: String) -> Bool { indexByID[jobId] != nil }
}

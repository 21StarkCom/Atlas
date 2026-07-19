import XCTest
@testable import ConsoleCore

/// Test-plan #4 — the per-job count map with the snapshot-plus-delta seed, full pagination, and
/// recency-merge; repeated job/backup for one id collapse to the latest, distinct events never do.
final class CoalescingJobCountTests: XCTestCase {

    /// Repeated `job` updates for one id collapse to the latest state (recency-merge, not accumulation).
    func testRepeatedJobUpdatesCollapseToLatest() {
        var map = JobStateMap()
        map.seed(fromPages: [Fx.jobRow("j1", state: "pending", updatedAt: "2026-07-18T10:00:00.000Z")], buffered: [])
        XCTAssertEqual(map.counts, JobCounts(queued: 1, failed: 0))
        XCTAssertEqual(map.apply(Fx.job("j1", state: "running", updatedAt: "2026-07-18T10:00:01.000Z")), .applied)
        XCTAssertEqual(map.apply(Fx.job("j1", state: "failed", updatedAt: "2026-07-18T10:00:02.000Z")), .applied)
        XCTAssertEqual(map.counts, JobCounts(queued: 0, failed: 1), "one id collapses to its latest state")
    }

    /// Distinct ids never collapse — two different jobs stay two rows.
    func testDistinctJobsNeverCollapse() {
        var map = JobStateMap()
        map.seed(fromPages: [], buffered: [])
        map.seed(fromPages: [
            Fx.jobRow("a", state: "pending", updatedAt: "2026-07-18T10:00:00.000Z"),
            Fx.jobRow("b", state: "failed", updatedAt: "2026-07-18T10:00:00.000Z"),
        ], buffered: [])
        XCTAssertEqual(map.counts, JobCounts(queued: 1, failed: 1))
    }

    /// A stale list row never clobbers a newer streamed state (recency floor).
    func testBufferedNewerEventWinsOverStaleListRow() {
        var map = JobStateMap()
        let staleRow = Fx.jobRow("j1", state: "pending", updatedAt: "2026-07-18T10:00:00.000Z")
        let newerLive = Fx.job("j1", state: "succeeded", updatedAt: "2026-07-18T10:05:00.000Z")
        map.seed(fromPages: [staleRow], buffered: [newerLive])
        XCTAssertFalse(JobCounts.queuedStates.contains("succeeded"))
        XCTAssertEqual(map.counts, JobCounts(queued: 0, failed: 0), "the newer live 'succeeded' won over the stale 'pending' row")

        // And the reverse: an older live event does NOT clobber a newer list row.
        var map2 = JobStateMap()
        let newRow = Fx.jobRow("j2", state: "running", updatedAt: "2026-07-18T10:05:00.000Z")
        let olderLive = Fx.job("j2", state: "pending", updatedAt: "2026-07-18T10:00:00.000Z")
        map2.seed(fromPages: [newRow], buffered: [olderLive])
        XCTAssertEqual(map2.counts, JobCounts(queued: 1, failed: 0))
    }

    /// The paginator (via the ReadInvoker seam) fully consumes a > 500-job dataset (two pages) and dedups
    /// by jobId; a concurrent transition buffered during the read wins over its stale list row.
    func testFullPaginationOverFiveHundredPlusWithConcurrentTransition() async throws {
        // 600 jobs: page 0 = 500 (offset 0), page 1 = 100 (offset 500). All pending at t0.
        let t0 = "2026-07-18T10:00:00.000Z"
        var page0: [JobRow] = []
        for i in 0..<500 { page0.append(Fx.jobRow("job-\(i)", state: "pending", updatedAt: t0)) }
        var page1: [JobRow] = []
        for i in 500..<600 { page1.append(Fx.jobRow("job-\(i)", state: "pending", updatedAt: t0)) }
        let invoker = ScriptedReadInvoker(pages: [
            0: (rows: page0, hasMore: true, total: 600),
            500: (rows: page1, hasMore: false, total: 600),
        ])

        let rows = try await JobsListReader().readAll(invoker: invoker)
        XCTAssertEqual(rows.count, 600, "every page consumed")
        XCTAssertEqual(Set(rows.map(\.jobId)).count, 600, "no duplicates across pages")
        XCTAssertEqual(invoker.callCount, 2, "exactly two page reads")

        // A concurrent transition of job-0 → failed at a newer time arrived during the read; it must win.
        var map = JobStateMap()
        let concurrent = Fx.job("job-0", state: "failed", updatedAt: "2026-07-18T10:01:00.000Z")
        map.seed(fromPages: rows, buffered: [concurrent])
        XCTAssertEqual(map.counts, JobCounts(queued: 599, failed: 1),
                       "599 still-pending + the one buffered failure that won over its stale row")
        XCTAssertTrue(map.contains("job-599"), "full membership")
    }

    /// readAll dedups a jobId repeated across a page boundary (a concurrent insert shifting the offset
    /// window), keeping first occurrence.
    func testReadAllDedupsAcrossPageBoundary() async throws {
        let t0 = "2026-07-18T10:00:00.000Z"
        let invoker = ScriptedReadInvoker(pages: [
            0: (rows: [Fx.jobRow("a", state: "pending", updatedAt: t0),
                       Fx.jobRow("b", state: "pending", updatedAt: t0)], hasMore: true, total: 3),
            // page 1 repeats "b" (shifted window) plus a genuinely-new "c".
            2: (rows: [Fx.jobRow("b", state: "pending", updatedAt: t0),
                       Fx.jobRow("c", state: "pending", updatedAt: t0)], hasMore: false, total: 3),
        ])
        let rows = try await JobsListReader().readAll(invoker: invoker)
        XCTAssertEqual(rows.map(\.jobId), ["a", "b", "c"], "duplicate b collapsed, order preserved")
    }

    /// An unseen `jobId` arriving mid-stream drives exactly one `JobStateCoordinator` reseed (buffer →
    /// readAll → recency-merge), never a synthetic insert — the fresh list confirms membership first.
    func testUnseenJobDrivesExactlyOneReseed() async throws {
        let t0 = "2026-07-18T10:00:00.000Z"
        let invoker = ScriptedReadInvoker(pages: [
            0: (rows: [Fx.jobRow("j1", state: "pending", updatedAt: t0)], hasMore: false, total: 1),
        ])
        let coord = JobStateCoordinator(reader: JobsListReader(), invoker: invoker)

        try await coord.seed()
        var count = await coord.counts
        XCTAssertEqual(count, JobCounts(queued: 1, failed: 0))
        XCTAssertEqual(invoker.callCount, 1, "initial seed = one readAll")

        // A live event for the seen id: no reseed (in-place recency merge).
        try await coord.apply(Fx.job("j1", state: "running", updatedAt: "2026-07-18T10:00:01.000Z"))
        XCTAssertEqual(invoker.callCount, 1, "a seen id does not reseed")

        // j2 now exists in the ledger; the reseed's fresh list confirms its membership (no synthetic insert).
        invoker.setPages([
            0: (rows: [Fx.jobRow("j1", state: "running", updatedAt: "2026-07-18T10:00:01.000Z"),
                       Fx.jobRow("j2", state: "failed", updatedAt: "2026-07-18T10:00:02.000Z")],
                hasMore: false, total: 2),
        ])
        // A live event for an UNSEEN id: exactly one reseed; the buffered event is merged onto the row.
        try await coord.apply(Fx.job("j2", state: "failed", updatedAt: "2026-07-18T10:00:02.000Z"))
        XCTAssertEqual(invoker.callCount, 2, "an unseen id drives exactly one reseed")
        let seen = await coord.contains("j2")
        XCTAssertTrue(seen, "the reseed confirmed j2's membership and merged the buffered event")
        count = await coord.counts
        XCTAssertEqual(count, JobCounts(queued: 1, failed: 1), "j1 running (queued) + j2 failed")

        // A subsequent event for the now-seen j2 does not reseed again.
        try await coord.apply(Fx.job("j2", state: "succeeded", updatedAt: "2026-07-18T10:00:03.000Z"))
        XCTAssertEqual(invoker.callCount, 2, "no further reseed for a now-seen id")
    }

    /// An unseen id whose job is NOT in the fresh list is never synthesized — no membership fabricated.
    func testUnseenJobAbsentFromListIsNotSynthesized() async throws {
        let t0 = "2026-07-18T10:00:00.000Z"
        let invoker = ScriptedReadInvoker(pages: [
            0: (rows: [Fx.jobRow("j1", state: "pending", updatedAt: t0)], hasMore: false, total: 1),
        ])
        let coord = JobStateCoordinator(reader: JobsListReader(), invoker: invoker)
        try await coord.seed()
        // ghost never appears in any page.
        try await coord.apply(Fx.job("ghost", state: "failed", updatedAt: "2026-07-18T10:00:05.000Z"))
        let hasGhost = await coord.contains("ghost")
        XCTAssertFalse(hasGhost, "an id absent from the list is dropped, never synthetically inserted")
        let count = await coord.counts
        XCTAssertEqual(count, JobCounts(queued: 1, failed: 0), "only the confirmed j1 counts")
    }

    /// A concurrent transition arriving WHILE a multi-page read is paused between pages is buffered by the
    /// coordinator and recency-merged after the read; only ONE read runs (single in-flight), full
    /// membership is deduped, and the buffered newer event beats the stale list row.
    func testConcurrentTransitionDuringPausedMultiPageRead() async throws {
        let t0 = "2026-07-18T10:00:00.000Z"
        var page0: [JobRow] = []
        for i in 0..<500 { page0.append(Fx.jobRow("job-\(i)", state: "pending", updatedAt: t0)) }
        var page1: [JobRow] = []
        for i in 500..<600 { page1.append(Fx.jobRow("job-\(i)", state: "pending", updatedAt: t0)) }
        let invoker = ScriptedReadInvoker(pages: [
            0: (rows: page0, hasMore: true, total: 600),
            500: (rows: page1, hasMore: false, total: 600),
        ])
        let coord = JobStateCoordinator(reader: JobsListReader(), invoker: invoker)

        // After page 0 is produced (mid-pagination), inject a newer transition of job-0 → failed.
        let injected = Fx.job("job-0", state: "failed", updatedAt: "2026-07-18T10:01:00.000Z")
        let onceBox = InjectOnce()
        invoker.onPage = { offset in
            guard offset == 0, onceBox.fire() else { return }
            try? await coord.apply(injected)   // arrives while the reseed's read is in flight → buffered
        }

        try await coord.seed()
        XCTAssertEqual(invoker.callCount, 2, "exactly one seed of two pages — the buffered event did not start a second read")
        let count = await coord.counts
        XCTAssertEqual(count, JobCounts(queued: 599, failed: 1),
                       "599 still-pending + the buffered failure that beat its stale list row")
        let rows = await coord.rows
        XCTAssertEqual(rows.count, 600, "full membership, deduped")
        XCTAssertEqual(rows.first(where: { $0.jobId == "job-0" })?.state, "failed",
                       "the newer buffered transition overlaid the stale row")
    }

    /// `rows` are in list order (createdAt-desc / jobId tiebreak per the CLI) with live state overlaid;
    /// `refresh()` drives one full protocol re-read.
    func testRowsOrderedWithOverlayAndRefreshReReads() async throws {
        let t0 = "2026-07-18T10:00:00.000Z"
        // CLI returns createdAt-desc order: c, b, a.
        let invoker = ScriptedReadInvoker(pages: [
            0: (rows: [Fx.jobRow("c", state: "pending", updatedAt: t0),
                       Fx.jobRow("b", state: "running", updatedAt: t0),
                       Fx.jobRow("a", state: "pending", updatedAt: t0)], hasMore: false, total: 3),
        ])
        let coord = JobStateCoordinator(reader: JobsListReader(), invoker: invoker)
        try await coord.seed()
        var rows = await coord.rows
        XCTAssertEqual(rows.map(\.jobId), ["c", "b", "a"], "list order preserved (createdAt-desc)")

        // A live event for a seen id overlays in place without reordering or re-reading.
        try await coord.apply(Fx.job("b", state: "failed", updatedAt: "2026-07-18T10:00:05.000Z"))
        XCTAssertEqual(invoker.callCount, 1, "a seen-id overlay does not re-read")
        rows = await coord.rows
        XCTAssertEqual(rows.map(\.jobId), ["c", "b", "a"], "order stable under overlay")
        XCTAssertEqual(rows.first(where: { $0.jobId == "b" })?.state, "failed", "state overlaid live")

        // refresh() drives exactly one full re-read.
        try await coord.refresh()
        XCTAssertEqual(invoker.callCount, 2, "refresh = one full protocol re-read")
    }

    /// `refresh()` re-reads the list, but a newer live overlay applied before the read must SURVIVE it — a
    /// stale list row never clobbers a newer streamed state (recency-merge of the prior confirmed overlay).
    func testRefreshPreservesNewerLiveOverlay() async throws {
        let t0 = "2026-07-18T10:00:00.000Z"
        // The list is (and stays) stale: j1 pending @ t0.
        let invoker = ScriptedReadInvoker(pages: [
            0: (rows: [Fx.jobRow("j1", state: "pending", updatedAt: t0)], hasMore: false, total: 1),
        ])
        let coord = JobStateCoordinator(reader: JobsListReader(), invoker: invoker)
        try await coord.seed()
        // A newer live event transitions j1 → failed AFTER t0.
        try await coord.apply(Fx.job("j1", state: "failed", updatedAt: "2026-07-18T10:05:00.000Z"))
        let beforeRefresh = await coord.counts
        XCTAssertEqual(beforeRefresh, JobCounts(queued: 0, failed: 1))

        // refresh() re-reads the STALE pending row; the newer failed overlay must win, not be clobbered.
        try await coord.refresh()
        let rows = await coord.rows
        XCTAssertEqual(rows.first(where: { $0.jobId == "j1" })?.state, "failed",
                       "refresh recency-merged the newer live overlay over the stale list row")
        let afterRefresh = await coord.counts
        XCTAssertEqual(afterRefresh, JobCounts(queued: 0, failed: 1),
                       "the newer streamed state survived the re-read")
    }

    /// Concurrent `seed()` + `refresh()` while a read is in flight AWAIT the same in-flight operation — one
    /// read runs, both callers see its success.
    func testConcurrentSeedAndRefreshShareOneInFlightRead() async throws {
        let t0 = "2026-07-18T10:00:00.000Z"
        let invoker = GatedReadInvoker(rows: [Fx.jobRow("j1", state: "pending", updatedAt: t0)])
        let coord = JobStateCoordinator(reader: JobsListReader(), invoker: invoker)

        let seedTask = Task { try await coord.seed() }
        await invoker.waitUntilEntered()                 // seed is parked inside the read
        let refreshTask = Task { try await coord.refresh() }
        for _ in 0..<50 { await Task.yield() }           // let refresh reach its await on the in-flight op
        XCTAssertEqual(invoker.callCount, 1, "the concurrent refresh did not start a second read")

        invoker.release()
        try await seedTask.value
        try await refreshTask.value
        XCTAssertEqual(invoker.callCount, 1, "seed + refresh shared one in-flight read")
        let count = await coord.counts
        XCTAssertEqual(count, JobCounts(queued: 1, failed: 0))
    }

    /// A read that FAILS while a concurrent caller is awaiting the in-flight operation surfaces the error to
    /// BOTH callers — neither returns on stale/unseeded state.
    func testConcurrentSeedAndRefreshBothObserveInFlightFailure() async throws {
        let t0 = "2026-07-18T10:00:00.000Z"
        let invoker = GatedReadInvoker(rows: [Fx.jobRow("j1", state: "pending", updatedAt: t0)],
                                       shouldFail: true)
        let coord = JobStateCoordinator(reader: JobsListReader(), invoker: invoker)

        let seedTask = Task { try await coord.seed() }
        await invoker.waitUntilEntered()
        let refreshTask = Task { try await coord.refresh() }
        for _ in 0..<50 { await Task.yield() }
        XCTAssertEqual(invoker.callCount, 1, "one in-flight read")

        invoker.release()
        var seedThrew = false, refreshThrew = false
        do { try await seedTask.value } catch { seedThrew = true }
        do { try await refreshTask.value } catch { refreshThrew = true }
        XCTAssertTrue(seedThrew, "the seed caller observed the read failure")
        XCTAssertTrue(refreshThrew, "the awaiting refresh caller observed the same read failure")
    }

    /// B1 — an event for a SEEN id that arrives while a read is in flight is folded in, never stranded.
    ///
    /// Note on the narrower race the B1 fix targets: an `apply` landing in the *completion window* (after
    /// `runSeedProtocol` drained the buffer but before `inFlight` was cleared) previously buffered its
    /// event with no protocol left to consume it. `drive()` now clears `inFlight` and drains any
    /// stragglers before returning. That exact interleaving is not deterministically reachable from a
    /// test seam (the injection points available all land mid-read), so this asserts the observable
    /// contract — no event is ever silently dropped — while the window itself is closed by construction.
    func testInFlightEventIsNotStrandedSeenId() async throws {
        let t0 = "2026-07-18T10:00:00.000Z"
        let invoker = ScriptedReadInvoker(pages: [
            0: (rows: [Fx.jobRow("a", state: "pending", updatedAt: t0)], hasMore: false, total: 1),
        ])
        let coord = JobStateCoordinator(reader: JobsListReader(), invoker: invoker)
        // Inject AFTER the last page is produced — i.e. into the completion window.
        let late = Fx.job("a", state: "succeeded", updatedAt: "2026-07-18T10:09:00.000Z")
        let once = InjectOnce()
        invoker.onPage = { _ in
            guard once.fire() else { return }
            try? await coord.apply(late)
        }
        try await coord.seed()
        let rows = await coord.rows
        XCTAssertEqual(rows[0].state, "succeeded", "a completion-window event must not be stranded")
    }

    /// B2 regression — a FAILED read must not strand the events it carried out of the buffer. After the
    /// failure the carried event is restored (ahead of anything that arrived during the failed read), so
    /// a successful retry still folds it in.
    func testFailedReadRestoresCarriedEventsForRetry() async throws {
        let t0 = "2026-07-18T10:00:00.000Z"
        let invoker = ScriptedReadInvoker(pages: [
            0: (rows: [Fx.jobRow("a", state: "pending", updatedAt: t0)], hasMore: false, total: 1),
        ])
        let coord = JobStateCoordinator(reader: JobsListReader(), invoker: invoker)

        // First seed fails, with a live event for `a` buffered before it.
        invoker.failNext = true
        let live = Fx.job("a", state: "failed", updatedAt: "2026-07-18T10:09:00.000Z")
        async let injected: Void = { try? await coord.apply(live) }()
        _ = await injected
        do { try await coord.seed(); XCTFail("seed should surface the read failure") } catch {}

        // Retry succeeds: the carried event must still be applied over the (stale) list row.
        invoker.failNext = false
        try await coord.seed()
        let rows = await coord.rows
        XCTAssertEqual(rows.count, 1)
        XCTAssertEqual(rows[0].state, "failed", "the event carried through the failed read survived the retry")
    }

    /// B3 regression — `seed` REBUILDS membership from the fresh pages: an id from a prior seed that is
    /// absent from the new pages is dropped, and a buffered event for an unconfirmed id is never
    /// synthetically inserted (no ghost rows inflating the counts).
    func testSeedRebuildsMembershipDroppingStaleAndGhostIds() {
        let t0 = "2026-07-18T10:00:00.000Z"
        var map = JobStateMap()
        map.seed(fromPages: [
            Fx.jobRow("old", state: "pending", updatedAt: t0),
            Fx.jobRow("keep", state: "pending", updatedAt: t0),
        ], buffered: [])
        XCTAssertEqual(map.counts, JobCounts(queued: 2, failed: 0))

        // Re-seed with a list that no longer contains `old`, plus a buffered event for an id the list
        // never confirms.
        map.seed(fromPages: [Fx.jobRow("keep", state: "pending", updatedAt: t0)],
                 buffered: [Fx.job("ghost", state: "failed", updatedAt: "2026-07-18T10:05:00.000Z")])
        XCTAssertFalse(map.contains("old"), "an id absent from the fresh list is dropped on re-seed")
        XCTAssertFalse(map.contains("ghost"), "a buffered event for an unconfirmed id is never synthesized")
        XCTAssertEqual(map.counts, JobCounts(queued: 1, failed: 0), "counts reflect list-confirmed membership only")
    }

    /// B4 regression — at an EQUAL `updatedAt`, a freshly-read list row wins over a prior row that was
    /// merely a previous list read; a prior row carrying a live STREAMED overlay still wins.
    func testEqualTimestampFreshListWinsUnlessPriorIsStreamed() async throws {
        let t = "2026-07-18T10:00:00.000Z"
        let invoker = ScriptedReadInvoker(pages: [
            0: (rows: [Fx.jobRow("a", state: "pending", updatedAt: t)], hasMore: false, total: 1),
        ])
        let coord = JobStateCoordinator(reader: JobsListReader(), invoker: invoker)
        try await coord.seed()

        // Refresh with a CHANGED fresh row at the SAME timestamp — no streamed overlay exists, so the
        // fresh row must win (previously the stale prior row won at equal time).
        invoker.setPages([0: (rows: [Fx.jobRow("a", state: "running", updatedAt: t)], hasMore: false, total: 1)])
        try await coord.refresh()
        var rows = await coord.rows
        XCTAssertEqual(rows[0].state, "running", "at equal updatedAt the fresh list row wins over a stale prior list row")

        // Now apply a live event at the same timestamp (a streamed overlay), then refresh with a
        // differing fresh row at that same timestamp — the streamed overlay must survive.
        try await coord.apply(Fx.job("a", state: "succeeded", updatedAt: t))
        invoker.setPages([0: (rows: [Fx.jobRow("a", state: "pending", updatedAt: t)], hasMore: false, total: 1)])
        try await coord.refresh()
        rows = await coord.rows
        XCTAssertEqual(rows[0].state, "succeeded", "a streamed overlay survives a refresh at equal updatedAt")
    }

    /// A genuinely-unseen id arriving MID-pagination and absent from the fresh list drives NO extra read
    /// cycle — exactly one pagination completes, and the absent id is never synthesized into membership.
    func testUnseenIdMidPaginationDrivesNoExtraReadCycle() async throws {
        let t0 = "2026-07-18T10:00:00.000Z"
        // Two pages: offset 0 = [a, b] hasMore; offset 2 = [c] done.
        let invoker = ScriptedReadInvoker(pages: [
            0: (rows: [Fx.jobRow("a", state: "pending", updatedAt: t0),
                       Fx.jobRow("b", state: "pending", updatedAt: t0)], hasMore: true, total: 3),
            2: (rows: [Fx.jobRow("c", state: "pending", updatedAt: t0)], hasMore: false, total: 3),
        ])
        let coord = JobStateCoordinator(reader: JobsListReader(), invoker: invoker)

        // Mid-pagination (after page 0), inject an unseen id that appears in NO page.
        let ghost = Fx.job("ghost", state: "failed", updatedAt: "2026-07-18T10:01:00.000Z")
        let once = InjectOnce()
        invoker.onPage = { offset in
            guard offset == 0, once.fire() else { return }
            try? await coord.apply(ghost)   // arrives while the read is in flight → buffered
        }

        try await coord.seed()
        XCTAssertEqual(invoker.callCount, 2, "exactly one pagination (two pages) — no extra read cycle for the absent id")
        let hasGhost = await coord.contains("ghost")
        XCTAssertFalse(hasGhost, "an id absent from the fresh list is dropped, never synthesized")
        let rows = await coord.rows
        XCTAssertEqual(rows.map(\.jobId), ["a", "b", "c"], "full deduped membership, ghost excluded")
    }
}

/// One-shot latch for the paused-paginator injection (fires the concurrent event exactly once).
final class InjectOnce: @unchecked Sendable {
    private let lock = NSLock()
    private var fired = false
    func fire() -> Bool { lock.withLock { if fired { return false }; fired = true; return true } }
}

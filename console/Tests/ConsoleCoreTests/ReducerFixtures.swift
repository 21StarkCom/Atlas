import Foundation
@testable import ConsoleCore

/// Fixture builders for Phase-3 reducer tests. Payloads are constructed directly (Phase-3 reducers
/// consume decoded `WatchEvent` payloads; decoding is Phase-2's job, proven in `WatchEventDecoderTests`).
enum Fx {
    static func audit(seq: Int, eventType: String, runId: String = "run-x",
                      at: String = "2026-07-18T10:00:00.000Z", gitHead: String? = nil) -> AuditPayload {
        AuditPayload(at: at, seq: seq, runId: runId, eventType: eventType,
                     createdAt: at, gitHead: gitHead)
    }

    static func backup(watermarkSeq: Int, healthy: Bool, at: String = "2026-07-18T10:00:00.000Z") -> BackupPayload {
        BackupPayload(at: at, watermarkSeq: watermarkSeq, healthy: healthy, updatedAt: at, lastBackupAt: nil)
    }

    static func daemon(_ name: String, reachable: Bool, previous: Bool = true,
                       at: String = "2026-07-18T10:00:00.000Z") -> DaemonPayload {
        DaemonPayload(at: at, daemon: name, socketPath: "/tmp/\(name).sock",
                      reachable: reachable, previousReachable: previous)
    }

    static func job(_ jobId: String, state: String, updatedAt: String, workflow: String = "capture",
                    attempts: Int = 1, maxAttempts: Int = 5,
                    at: String = "2026-07-18T10:00:00.000Z") -> JobPayload {
        JobPayload(at: at, jobId: jobId, workflow: workflow, state: state, attempts: attempts,
                   maxAttempts: maxAttempts, updatedAt: updatedAt, nextRunAt: nil, lastError: nil)
    }

    static func jobRow(_ jobId: String, state: String, updatedAt: String, workflow: String = "capture",
                       attempts: Int = 1, maxAttempts: Int = 5) -> JobRow {
        JobRow(jobId: jobId, workflow: workflow, state: state, attempts: attempts,
               maxAttempts: maxAttempts, updatedAt: updatedAt)
    }

    /// A hello with an attached ledger and full ledger-derived snapshot keys.
    static func attachedHello(openRuns: [String: Int] = ["running": 1],
                              jobsQueued: Int = 2, jobsFailed: Int = 1,
                              quarantine: Int = 0,
                              backupWatermark: Int = 5, backupCovered: Int = 5, backupHealthy: Bool = true,
                              auditHeadSeq: Int = 5, auditHead: String = "abc",
                              brokerUp: Bool = true, egressUp: Bool = true,
                              resumeHead: Int? = nil, replay: ReplayInfo? = nil,
                              at: String = "2026-07-18T10:00:00.000Z") -> HelloPayload {
        let snap = WatchSnapshot(
            openRuns: openRuns,
            jobs: WatchSnapshot.JobsCount(queued: jobsQueued, failed: jobsFailed),
            quarantineCount: quarantine,
            backup: WatchSnapshot.BackupView(watermarkSeq: backupWatermark, coveredSeq: backupCovered, healthy: backupHealthy),
            audit: WatchSnapshot.AuditView(headSeq: auditHeadSeq, head: auditHead, anchorOk: true, anchorSource: "worm"),
            daemons: WatchSnapshot.Daemons(
                broker: DaemonProbe(socketPath: "/tmp/b.sock", reachable: brokerUp),
                egress: DaemonProbe(socketPath: "/tmp/e.sock", reachable: egressUp))
        )
        return HelloPayload(
            at: at, pid: 42, ledger: LedgerInfo(attached: true, path: "/tmp/vault/.git/atlas.sqlite"),
            snapshot: snap, config: WatchConfig(pollMs: 500, heartbeatSeconds: 30),
            resume: resumeHead.map { ResumeInfo(auditHeadSeq: $0) }, replay: replay)
    }

    /// A detached hello: only `daemons` present, every ledger-derived key absent.
    static func detachedHello(at: String = "2026-07-18T10:00:00.000Z") -> HelloPayload {
        let snap = WatchSnapshot(
            openRuns: nil, jobs: nil, quarantineCount: nil, backup: nil, audit: nil,
            daemons: WatchSnapshot.Daemons(
                broker: DaemonProbe(socketPath: "/tmp/b.sock", reachable: true),
                egress: DaemonProbe(socketPath: "/tmp/e.sock", reachable: true)))
        return HelloPayload(
            at: at, pid: 42, ledger: LedgerInfo(attached: false, path: "/tmp/vault/.git/atlas.sqlite"),
            snapshot: snap, config: WatchConfig(pollMs: 500, heartbeatSeconds: 30),
            resume: nil, replay: nil)
    }
}

/// A `ReadInvoker` that returns scripted `jobs list --json` pages keyed by the `--offset` arg. Drives
/// `JobsListReader`/`JobStateCoordinator` through the same read-command seam the live path uses (phase 6
/// wires `ReadCommandExecutor.run`), with no real `brain`.
///
/// `pages` is mutable so a test can make a new job appear (a reseed re-reads it); `onPage` fires after
/// each page's bytes are produced so a test can pause between pages and inject a concurrent event.
final class ScriptedReadInvoker: ReadInvoker, @unchecked Sendable {
    typealias Page = (rows: [JobRow], hasMore: Bool, total: Int)
    private var pages: [Int: Page]
    private let lock = NSLock()
    private var _callCount = 0
    /// Total `run()` calls (one per page fetched). A single-page reseed ⇒ +1.
    var callCount: Int { lock.withLock { _callCount } }
    /// Fires after a page is produced (offset), before it returns — pause + inject point.
    var onPage: (@Sendable (Int) async -> Void)?
    /// Fires BEFORE a page is produced (offset). Lets a test inject an event into the in-flight read and
    /// then fail it, exercising the read-failure buffer-restore path.
    var beforePage: (@Sendable (Int) async -> Void)?
    /// When true, `run` throws instead of returning a page (read-failure injection).
    private var _failNext = false
    var failNext: Bool {
        get { lock.withLock { _failNext } }
        set { lock.withLock { _failNext = newValue } }
    }

    struct ScriptedReadFailure: Error {}

    init(pages: [Int: Page]) { self.pages = pages }

    func setPages(_ p: [Int: Page]) { lock.withLock { pages = p } }

    func run(_ command: String, args: [String]) async throws -> Data {
        precondition(command == "jobs list")
        lock.withLock { _callCount += 1 }
        var preOffset = 0
        if let i = args.firstIndex(of: "--offset"), i + 1 < args.count {
            preOffset = Int(args[i + 1]) ?? 0
        }
        await beforePage?(preOffset)
        if failNext { throw ScriptedReadFailure() }
        var offset = 0
        if let i = args.firstIndex(of: "--offset"), i + 1 < args.count {
            offset = Int(args[i + 1]) ?? 0
        }
        let page = lock.withLock { pages[offset] } ?? (rows: [], hasMore: false, total: 0)
        let jobsJSON = page.rows.map { row -> [String: Any] in
            ["jobId": row.jobId, "workflow": row.workflow, "state": row.state,
             "attempts": row.attempts, "maxAttempts": row.maxAttempts, "updatedAt": row.updatedAt]
        }
        let payload: [String: Any] = [
            "command": "jobs list",
            "jobs": jobsJSON,
            "pagination": ["limit": 500, "offset": offset, "total": page.total, "hasMore": page.hasMore],
        ]
        let data = try JSONSerialization.data(withJSONObject: payload)
        await onPage?(offset)
        return data
    }
}

/// A single-page `ReadInvoker` whose one read PARKS until `release()`, so a test can hold a seed/reseed
/// mid-flight and start a concurrent `seed()`/`refresh()` to prove they await the SAME in-flight operation
/// (and observe its outcome) rather than starting a second read. `shouldFail` makes the read throw, so a
/// failure is observed by every awaiting caller.
final class GatedReadInvoker: ReadInvoker, @unchecked Sendable {
    struct ReadFailure: Error, Equatable {}
    private let rows: [JobRow]
    private let shouldFail: Bool
    private let lock = NSLock()
    private var _callCount = 0
    var callCount: Int { lock.withLock { _callCount } }
    private var enterCont: CheckedContinuation<Void, Never>?
    private var releaseCont: CheckedContinuation<Void, Never>?

    init(rows: [JobRow], shouldFail: Bool = false) { self.rows = rows; self.shouldFail = shouldFail }

    /// Suspends until the (first) read has entered `run`.
    func waitUntilEntered() async {
        await withCheckedContinuation { (c: CheckedContinuation<Void, Never>) in
            lock.lock()
            if _callCount > 0 { lock.unlock(); c.resume(); return }
            enterCont = c
            lock.unlock()
        }
    }

    /// Unblocks the parked read.
    func release() {
        lock.lock(); let c = releaseCont; releaseCont = nil; lock.unlock()
        c?.resume()
    }

    func run(_ command: String, args: [String]) async throws -> Data {
        precondition(command == "jobs list")
        let ec: CheckedContinuation<Void, Never>? = lock.withLock {
            _callCount += 1
            let c = enterCont; enterCont = nil
            return c
        }
        ec?.resume()
        await withCheckedContinuation { (c: CheckedContinuation<Void, Never>) in
            lock.withLock { releaseCont = c }
        }
        if shouldFail { throw ReadFailure() }
        let jobsJSON = rows.map { row -> [String: Any] in
            ["jobId": row.jobId, "workflow": row.workflow, "state": row.state,
             "attempts": row.attempts, "maxAttempts": row.maxAttempts, "updatedAt": row.updatedAt]
        }
        let payload: [String: Any] = [
            "command": "jobs list",
            "jobs": jobsJSON,
            "pagination": ["limit": 500, "offset": 0, "total": rows.count, "hasMore": false],
        ]
        return try JSONSerialization.data(withJSONObject: payload)
    }
}

import XCTest
@testable import ConsoleCore

/// P4-Task-1 — the single-writer resume-cursor SQLite store.
final class CursorStoreTests: XCTestCase {

    private func mode(_ path: String) throws -> Int {
        let attrs = try FileManager.default.attributesOfItem(atPath: path)
        return (attrs[.posixPermissions] as! NSNumber).intValue
    }

    func testUpsertRoundTrip() throws {
        let dir = TestSupport.tempDir()
        let store = try CursorStore(path: dir.appendingPathComponent("console.sqlite"))
        let key = IncarnationKey.derive(ledgerPath: "/vault/.atlas/atlas.db")

        try store.checkpoint(incarnationKey: key, seq: 42, updatedAt: "2026-07-18T10:00:00.000Z")
        XCTAssertEqual(try store.load(incarnationKey: key), 42)

        // A later checkpoint overwrites in place.
        try store.checkpoint(incarnationKey: key, seq: 99, updatedAt: "2026-07-18T10:01:00.000Z")
        XCTAssertEqual(try store.load(incarnationKey: key), 99)
        XCTAssertEqual(store.checkpointCount, 2)
    }

    func testUnseenKeyReturnsMinusOne() throws {
        let dir = TestSupport.tempDir()
        let store = try CursorStore(path: dir.appendingPathComponent("console.sqlite"))
        XCTAssertEqual(try store.load(incarnationKey: IncarnationKey.derive(ledgerPath: "/never/seen")), -1)
    }

    func testDifferentLedgerPathsAreDistinctIncarnations() throws {
        let dir = TestSupport.tempDir()
        let store = try CursorStore(path: dir.appendingPathComponent("console.sqlite"))
        let a = IncarnationKey.derive(ledgerPath: "/vault/a/.git/atlas.db")
        let b = IncarnationKey.derive(ledgerPath: "/vault/b/.git/atlas.db")
        XCTAssertNotEqual(a, b)
        try store.checkpoint(incarnationKey: a, seq: 10, updatedAt: "t")
        // b is a different incarnation ⇒ fresh baseline, NOT a's cursor.
        XCTAssertEqual(try store.load(incarnationKey: b), -1)
        XCTAssertEqual(try store.load(incarnationKey: a), 10)
    }

    func testDbFileModeIs0600() throws {
        let dir = TestSupport.tempDir()
        let dbPath = dir.appendingPathComponent("console.sqlite")
        _ = try CursorStore(path: dbPath)
        XCTAssertEqual(try mode(dbPath.path), 0o600)
    }

    func testAbsentParentDirIsCreated0700BeforeOpen() throws {
        let base = TestSupport.tempDir()
        // A first-launch path whose parent (`com.atlas.console`) does NOT yet exist.
        let parent = base.appendingPathComponent("com.atlas.console", isDirectory: true)
        XCTAssertFalse(FileManager.default.fileExists(atPath: parent.path))
        let dbPath = parent.appendingPathComponent("console.sqlite")

        let store = try CursorStore(path: dbPath)
        var isDir: ObjCBool = false
        XCTAssertTrue(FileManager.default.fileExists(atPath: parent.path, isDirectory: &isDir))
        XCTAssertTrue(isDir.boolValue)
        XCTAssertEqual(try mode(parent.path), 0o700)
        // And the store is usable.
        try store.checkpoint(incarnationKey: "k", seq: 1, updatedAt: "t")
        XCTAssertEqual(try store.load(incarnationKey: "k"), 1)
    }
}

/// A live-only attach still checkpoints (heartbeats carry `resume.auditHeadSeq`), so the persisted cursor
/// survives a process restart and a later `resume` reads a `>= 0` cursor — resuming forward, no re-replay.
final class LiveOnlyCheckpointSurvivesRestartTests: XCTestCase {

    /// B4 regression — a PRE-EXISTING permissive database is tightened to 0600, and if the mode cannot be
    /// enforced the store fails closed rather than initializing over a world-readable cursor file.
    func testPreExistingPermissiveDatabaseIsTightenedNotIgnored() throws {
        let dir = TestSupport.tempDir()
        let path = dir.appendingPathComponent("console.sqlite")
        // Create the file up front with permissive 0644.
        FileManager.default.createFile(atPath: path.path, contents: Data(),
                                       attributes: [.posixPermissions: 0o644])
        func fileMode(_ p: String) throws -> Int {
            let attrs = try FileManager.default.attributesOfItem(atPath: p)
            return (attrs[.posixPermissions] as! NSNumber).intValue & 0o777
        }
        XCTAssertEqual(try fileMode(path.path), 0o644, "precondition: permissive")

        let store = try CursorStore(path: path)
        XCTAssertEqual(try fileMode(path.path), 0o600, "the store must enforce 0600 on an existing permissive db")
        // And it still works.
        let key = IncarnationKey.derive(ledgerPath: "/vault/.atlas/atlas.db")
        try store.checkpoint(incarnationKey: key, seq: 7, updatedAt: "2026-07-18T10:00:00.000Z")
        XCTAssertEqual(try store.load(incarnationKey: key), 7)
    }

    func testCheckpointSurvivesReopen() throws {
        let dir = TestSupport.tempDir()
        let path = dir.appendingPathComponent("console.sqlite")
        let key = IncarnationKey.derive(ledgerPath: "/vault/.atlas/atlas.db")

        // First "run": a live-only attach still checkpoints its safe head at a heartbeat.
        do {
            let store = try CursorStore(path: path)
            try store.checkpoint(incarnationKey: key, seq: 250, updatedAt: "2026-07-18T10:00:30.000Z")
        }

        // "Restart": a fresh CursorStore at the same path reads the persisted cursor.
        let reopened = try CursorStore(path: path)
        let cursor = try reopened.load(incarnationKey: key)
        XCTAssertEqual(cursor, 250)

        // A later `resume` reads a >= 0 cursor and resumes forward (no re-replay from -1).
        XCTAssertEqual(ResumePlanner.plan(mode: .resume, persistedCursor: cursor), .sinceSeq(250))
    }
}

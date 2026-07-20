import Foundation
import SQLite3
import CryptoKit

// MARK: - Incarnation key

/// The per-ledger identity that scopes a resume cursor. A cursor is only ever valid against the exact
/// ledger it was checkpointed from — a re-cloned / re-anchored vault at the same on-disk path is a fresh
/// incarnation and must NOT reuse a stale cursor. The key is `SHA-256(absolute ledger.path)`; a changed
/// path (a moved / re-cloned vault) yields a different key, so the store hands back `-1` (fresh) rather
/// than a cursor that would replay against the wrong seq space.
public enum IncarnationKey {
    /// SHA-256 (lowercase hex) of the absolute ledger path, taken verbatim from the attaching `hello`.
    public static func derive(ledgerPath: String) -> String {
        let digest = SHA256.hash(data: Data(ledgerPath.utf8))
        return digest.map { String(format: "%02x", $0) }.joined()
    }
}

// MARK: - Errors

/// Failures the cursor store raises. A store that cannot open / migrate / write is fail-closed — it
/// throws rather than silently degrading resume state (which would risk a replay gap on next attach).
public enum CursorStoreError: Error, Equatable, Sendable {
    /// The SQLite file could not be opened at `path`.
    case openFailed(path: String, message: String)
    /// A DDL / migration statement failed.
    case migrationFailed(message: String)
    /// A prepared statement failed to compile.
    case prepareFailed(message: String)
    /// A step / bind failed.
    case stepFailed(message: String)
}

// MARK: - CursorStoring

/// The resume-cursor persistence seam the `AttachCoordinator` depends on. Abstracting it lets a test
/// inject a store whose `load`/`checkpoint` fail, proving the coordinator surfaces a typed terminal/
/// degraded state rather than swallowing a storage error into a valid-looking resume.
public protocol CursorStoring: Sendable {
    /// The persisted safe cursor for a ledger incarnation, or `-1` if never seen.
    func load(incarnationKey: String) throws -> Int
    /// Upsert the safe cursor for a ledger incarnation, transactionally.
    func checkpoint(incarnationKey: String, seq: Int, updatedAt: String) throws
}

// MARK: - CursorStore

/// Single-writer transactional resume-cursor store at
/// `~/Library/Application Support/com.atlas.console/console.sqlite`. Sole owner of resume state: one row
/// per ledger incarnation, holding the last *safe* (contiguous-prefix) audit head seq. `init` creates
/// the parent dir (`0700`) and db (`0600`) if absent and migrates the single table. Every access is
/// serialized behind a lock inside the connection holder, so concurrent `AttachCoordinator` checkpoints
/// and reads never interleave a half-written row (single-writer discipline).
public struct CursorStore: CursorStoring, Sendable {
    private let conn: Connection

    /// Number of `checkpoint` writes committed. Observability for the sole-checkpoint-writer invariant
    /// (`AttachCoordinator` is the only caller); a single-writer store knowing its own write count is
    /// benign and lets the flow test assert "exactly one checkpoint at the heartbeat".
    public var checkpointCount: Int { conn.checkpointCount }

    /// Opens (creating if absent) the store at `path`. Creates the `com.atlas.console` parent directory
    /// (`0700`) if missing, the db file (`0600`), and migrates the `ledger_cursor` table.
    public init(path: URL) throws {
        self.conn = try Connection(path: path)
    }

    /// The persisted safe cursor for a ledger incarnation, or `-1` if the key was never seen. `-1` is the
    /// fresh-ledger baseline (run.* seqs start at 0), so a fresh key resumes live-only via `ResumePlanner`.
    public func load(incarnationKey: String) throws -> Int {
        try conn.load(incarnationKey: incarnationKey)
    }

    /// Upsert the safe cursor for a ledger incarnation, in a transaction. `AttachCoordinator` calls this
    /// ONLY at a safe attached heartbeat (never a pre-replay `min(n, prefix)` hello value, never a
    /// detached heartbeat), so a persisted cursor never sits above the contiguous-prefix safe checkpoint.
    public func checkpoint(incarnationKey: String, seq: Int, updatedAt: String) throws {
        try conn.checkpoint(incarnationKey: incarnationKey, seq: seq, updatedAt: updatedAt)
    }

    // MARK: - Connection (single-writer, lock-serialized)

    /// The SQLite handle owner. A reference type so a `CursorStore` value can be shared (it is passed to
    /// the `AttachCoordinator` actor); all access is serialized behind `lock`, so there is only ever one
    /// writer in flight.
    private final class Connection: @unchecked Sendable {
        private var db: OpaquePointer?
        private let lock = NSLock()
        private var _checkpointCount = 0

        var checkpointCount: Int { lock.withLock { _checkpointCount } }

        // SQLite wants a stable pointer for string binds; SQLITE_TRANSIENT tells it to copy the bytes.
        private static let transient = unsafeBitCast(-1, to: sqlite3_destructor_type.self)

        init(path: URL) throws {
            let fm = FileManager.default
            let parent = path.deletingLastPathComponent()
            if !fm.fileExists(atPath: parent.path) {
                try fm.createDirectory(at: parent, withIntermediateDirectories: true,
                                       attributes: [.posixPermissions: 0o700])
            }

            var handle: OpaquePointer?
            let flags = SQLITE_OPEN_READWRITE | SQLITE_OPEN_CREATE | SQLITE_OPEN_FULLMUTEX
            let rc = sqlite3_open_v2(path.path, &handle, flags, nil)
            guard rc == SQLITE_OK, let handle else {
                let msg = handle.map { String(cString: sqlite3_errmsg($0)) } ?? "sqlite3_open_v2 rc=\(rc)"
                if let handle { sqlite3_close(handle) }
                throw CursorStoreError.openFailed(path: path.path, message: msg)
            }
            self.db = handle

            // Tighten the db file mode to 0600 the moment it exists (open may create it 0644 per umask,
            // and a pre-existing file may be permissive). This is a storage-contract requirement, so a
            // failure to apply OR verify it fails closed — never silently proceed with a readable cursor
            // database.
            do {
                try fm.setAttributes([.posixPermissions: 0o600], ofItemAtPath: path.path)
            } catch {
                sqlite3_close(handle)
                throw CursorStoreError.openFailed(
                    path: path.path,
                    message: "could not enforce 0600 on the cursor database: \(error)")
            }
            let mode = (try? fm.attributesOfItem(atPath: path.path)[.posixPermissions] as? NSNumber)?
                .flatMap { $0 }
            guard let mode, mode.uint16Value & 0o777 == 0o600 else {
                sqlite3_close(handle)
                let actual = mode.map { String($0.uint16Value & 0o777, radix: 8) } ?? "unknown"
                throw CursorStoreError.openFailed(
                    path: path.path,
                    message: "cursor database mode is \(actual), expected 0600")
            }

            try exec("""
            CREATE TABLE IF NOT EXISTS ledger_cursor (
              incarnation_key TEXT PRIMARY KEY,
              audit_head_seq INTEGER NOT NULL DEFAULT -1,
              updated_at TEXT NOT NULL
            );
            """)
        }

        deinit { if let db { sqlite3_close(db) } }

        private func exec(_ sql: String) throws {
            var errmsg: UnsafeMutablePointer<CChar>?
            let rc = sqlite3_exec(db, sql, nil, nil, &errmsg)
            guard rc == SQLITE_OK else {
                let msg = errmsg.map { String(cString: $0) } ?? "rc=\(rc)"
                sqlite3_free(errmsg)
                throw CursorStoreError.migrationFailed(message: msg)
            }
        }

        func load(incarnationKey: String) throws -> Int {
            lock.lock(); defer { lock.unlock() }
            var stmt: OpaquePointer?
            let sql = "SELECT audit_head_seq FROM ledger_cursor WHERE incarnation_key = ?1;"
            guard sqlite3_prepare_v2(db, sql, -1, &stmt, nil) == SQLITE_OK else {
                throw CursorStoreError.prepareFailed(message: String(cString: sqlite3_errmsg(db)))
            }
            defer { sqlite3_finalize(stmt) }
            sqlite3_bind_text(stmt, 1, incarnationKey, -1, Self.transient)
            switch sqlite3_step(stmt) {
            case SQLITE_ROW:
                return Int(sqlite3_column_int64(stmt, 0))
            case SQLITE_DONE:
                return -1 // unseen key ⇒ fresh baseline
            default:
                throw CursorStoreError.stepFailed(message: String(cString: sqlite3_errmsg(db)))
            }
        }

        func checkpoint(incarnationKey: String, seq: Int, updatedAt: String) throws {
            lock.lock(); defer { lock.unlock() }
            try execLocked("BEGIN IMMEDIATE;")
            do {
                var stmt: OpaquePointer?
                let sql = """
                INSERT INTO ledger_cursor (incarnation_key, audit_head_seq, updated_at)
                VALUES (?1, ?2, ?3)
                ON CONFLICT(incarnation_key) DO UPDATE SET
                  audit_head_seq = excluded.audit_head_seq,
                  updated_at = excluded.updated_at;
                """
                guard sqlite3_prepare_v2(db, sql, -1, &stmt, nil) == SQLITE_OK else {
                    throw CursorStoreError.prepareFailed(message: String(cString: sqlite3_errmsg(db)))
                }
                defer { sqlite3_finalize(stmt) }
                sqlite3_bind_text(stmt, 1, incarnationKey, -1, Self.transient)
                sqlite3_bind_int64(stmt, 2, Int64(seq))
                sqlite3_bind_text(stmt, 3, updatedAt, -1, Self.transient)
                guard sqlite3_step(stmt) == SQLITE_DONE else {
                    throw CursorStoreError.stepFailed(message: String(cString: sqlite3_errmsg(db)))
                }
                try execLocked("COMMIT;")
                _checkpointCount += 1
            } catch {
                try? execLocked("ROLLBACK;")
                throw error
            }
        }

        /// `exec` without taking the lock (caller already holds it — used inside `checkpoint`'s txn).
        private func execLocked(_ sql: String) throws {
            var errmsg: UnsafeMutablePointer<CChar>?
            let rc = sqlite3_exec(db, sql, nil, nil, &errmsg)
            guard rc == SQLITE_OK else {
                let msg = errmsg.map { String(cString: $0) } ?? "rc=\(rc)"
                sqlite3_free(errmsg)
                throw CursorStoreError.stepFailed(message: msg)
            }
        }
    }
}

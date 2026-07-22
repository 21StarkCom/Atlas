/**
 * `backup/restore` — the privileged, destructive, all-or-nothing ledger restore
 * (ledger-backup-contract §10). This is the **ledger-side** of the flow, invoked
 * only by the authorized CLI path (`apps/cli/src/commands/db-restore.ts`): the CLI
 * verifies the `op: "db.restore"` broker authorization (challenge carries
 * `backupRef` + content hash) and holds the exclusive `vault-maintenance` +
 * `ledger-maintenance` locks (§2.5 global order) BEFORE calling this — locks +
 * authorization are CLI-owned; this function owns the transactional replace.
 *
 * Ordering (§10): verify integrity/schema → decrypt to a temp DB in the live
 * directory → atomically replace the live DB (temp-then-rename; the original is
 * only unlinked after the replacement is durably renamed, so an interrupted
 * restore leaves the prior DB intact) → establish a fresh watermark at the
 * restored cut (T7) → write the D6 `db.restore` ledger audit row → run the
 * post-restore rebuild hooks (projection rebuild now; index rebuild in Phase 3).
 */
import {
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { randomBytes } from "node:crypto";
import { dirname, join } from "node:path";
import type { Store } from "../store.js";
import { openConnection } from "../connection.js";
import { runMigrations } from "../migrate.js";
import { LedgerRepo } from "../repos/ledger.js";
import { runPostRestoreRebuild } from "../rebuild.js";
import {
  decryptBackup,
  pinRestoreTarget,
  resolveBackupRef,
  unpinRestoreTarget,
  verifyBackup,
  type LedgerBackupConfig,
} from "./backup.js";
import { BackupIntegrityError } from "./aead.js";
import { WatermarkRepo } from "./watermark.js";
import { nextDbEventSeq, latestRunSeq } from "../ledger/intents.js";

/** Failpoints for the restore.atomicity test. */
export type RestoreStep = "before-swap" | "after-move-aside" | "after-swap";

/** The durable restore-journal filename (in the live DB's directory). */
const RESTORE_JOURNAL = ".restore-journal.json";

/** The on-disk restore journal: the random-named prior/temp paths a crash-recovery pass needs. */
interface RestoreJournal {
  readonly livePath: string;
  readonly priorDb: string;
  readonly tmpDb: string;
}

/** The outcome of {@link recoverInterruptedRestore}. */
export interface RestoreRecovery {
  readonly recovered: boolean;
  /** True when an in-flight restore was rolled back to the prior DB. */
  readonly rolledBack: boolean;
}

/**
 * Startup crash-recovery for an interrupted `db restore` (round-3 finding 4). Run
 * this BEFORE opening the ledger store. Restore is otherwise only exception-atomic:
 * a PROCESS death between the filesystem renames could leave no live DB, or leave a
 * swapped-but-unconfirmed restore, with no in-process `finally`/`catch` to undo it.
 *
 * The journal records the random-named prior/temp paths; recovery infers the truth
 * from the filesystem, which is crash-safe at EVERY seam:
 *   - prior DB still present ⇒ the restore did not fully complete (crash before/at
 *     any rename, or after the swap but before the post-swap steps were confirmed)
 *     ⇒ roll the prior DB back over the live path (all-or-nothing);
 *   - prior DB already gone ⇒ the restore had completed (crash only during final
 *     cleanup) ⇒ the live DB is authoritative; just drop the temp + journal.
 * There is no window in which the process can die and leave the live path absent.
 */
export function recoverInterruptedRestore(dir: string): RestoreRecovery {
  const journalPath = join(dir, RESTORE_JOURNAL);
  if (!existsSync(journalPath)) return { recovered: false, rolledBack: false };
  const j = JSON.parse(readFileSync(journalPath, "utf8")) as RestoreJournal;
  const priorExists = existsSync(j.priorDb);
  if (priorExists) {
    // Interrupted before completion → restore the prior DB (all-or-nothing).
    rmSync(j.livePath, { force: true });
    for (const s of [`${j.livePath}-wal`, `${j.livePath}-shm`]) rmSync(s, { force: true });
    renameSync(j.priorDb, j.livePath);
  }
  // else: prior already removed = the restore had completed; live is authoritative.
  rmSync(j.tmpDb, { force: true });
  for (const s of [`${j.tmpDb}-wal`, `${j.tmpDb}-shm`]) rmSync(s, { force: true });
  rmSync(journalPath, { force: true });
  try {
    fsyncPath(dir, "r");
  } catch {
    /* best-effort dir fsync */
  }
  return { recovered: true, rolledBack: priorExists };
}

/** Options for {@link restoreBackup}. */
export interface RestoreOptions {
  readonly now?: () => string;
  /** Crash-injection failpoint (tests). Throwing at ANY step must leave the prior DB intact. */
  readonly failpoint?: (step: RestoreStep) => void | Promise<void>;
  /**
   * The content hash the `db.restore` authorization was bound to (F7). When set,
   * the AUTHENTICATED bundle's content hash MUST equal it, else the restore is
   * refused — closing the swap/TOCTOU gap where a bundle at `backupRef` is
   * replaced between authorization and restore.
   */
  readonly expectedContentHash?: string;
}

/** The accepted loss window recorded by a restore (§10 step 6). */
export interface RestoreResult {
  readonly restoredCutSeq: number;
  readonly preRestoreSeq: number;
  readonly contentHash: string;
}

function rfc3339(): string {
  return new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
}

function fsyncPath(path: string, flags: string): void {
  const fd = openSync(path, flags);
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

/**
 * Restore `backupRef` over the live ledger DB. Returns the accepted loss window.
 *
 * NOTE: this CLOSES the passed `store`'s connection (the DB file is atomically
 * replaced) and operates on a fresh internal connection for the post-restore
 * steps; callers must re-open the store afterward to keep using it.
 */
export async function restoreBackup(
  store: Store,
  backupRef: string,
  cfg: LedgerBackupConfig,
  opts: RestoreOptions = {},
): Promise<RestoreResult> {
  const now = opts.now ?? rfc3339;
  const livePath = store.db.name;
  if (livePath === ":memory:" || livePath === "") {
    throw new Error("db restore requires a file-backed ledger DB (cannot restore over :memory:)");
  }

  // Pin the target so concurrent retention cannot prune it mid-restore (§9). The
  // pin is released in the outer `finally` below, on every exit path.
  const pinnedRef = resolveBackupRef(cfg, backupRef);
  pinRestoreTarget(pinnedRef);
  try {
  // §10.3: verify integrity + schema BEFORE touching the live DB. Abort leaves it untouched.
  verifyBackup(cfg, backupRef);
  const { bytes, header } = decryptBackup(cfg, backupRef);

  // F7: bind the restore to the AUTHENTICATED content hash the authorization
  // approved. `header.contentHash` is AEAD-authenticated (AAD) AND re-verified
  // against the decrypted bytes by `decryptBackup`/`verifyBackup`, so a bundle
  // swapped in after authorization cannot pass this check.
  if (opts.expectedContentHash !== undefined && header.contentHash !== opts.expectedContentHash) {
    throw new BackupIntegrityError(
      `restore target content hash ${header.contentHash} does not match the authorized ` +
        `hash ${opts.expectedContentHash} — refusing (swap/TOCTOU guard)`,
    );
  }

  const preRestoreSeq = latestRunSeq(store.db);

  // Capture THIS store's migration frontier BEFORE the swap closes `store.db`. A
  // pre-0013 backup restores a v1 `note_links` table; the post-restore projection
  // rebuild's fold now emits the v2 shape (an `alias` column + partial-index
  // conflict targets), so the restored DB must be forward-migrated through
  // `0013_links_v2` first. Applied post-swap, inside the all-or-nothing try below.
  const migrations = store.listMigrations();

  const dir = dirname(livePath);
  mkdirSync(dir, { recursive: true });
  const tmpDb = join(dir, `.restore-${process.pid}-${randomBytes(8).toString("hex")}.db`);
  // The prior live DB is MOVED aside (never unlinked) so it is a durable rollback
  // candidate for every post-swap step (F6). It is only removed on full success.
  const priorDb = join(dir, `.prior-${process.pid}-${randomBytes(8).toString("hex")}.db`);
  const journalPath = join(dir, RESTORE_JOURNAL);
  let swapped = false;

  /** Restore the prior DB over the live path (all-or-nothing rollback, F6). */
  const rollbackToPrior = (): void => {
    rmSync(livePath, { force: true });
    for (const sidecar of [`${livePath}-wal`, `${livePath}-shm`]) rmSync(sidecar, { force: true });
    renameSync(priorDb, livePath);
    fsyncPath(dir, "r");
  };

  try {
    writeFileSync(tmpDb, bytes, { mode: 0o600 });
    fsyncPath(tmpDb, "r+");

    // Durably record the exchange BEFORE any rename (round-3 finding 4): a process
    // death at any subsequent seam is recovered by `recoverInterruptedRestore` from
    // this journal + filesystem truth. Written + fsync'd (file and dir) up front.
    writeFileSync(journalPath, JSON.stringify({ livePath, priorDb, tmpDb } satisfies RestoreJournal), { mode: 0o600 });
    fsyncPath(journalPath, "r+");
    fsyncPath(dir, "r");

    // A crash here (before the swap) must leave the prior DB intact (§10.4 /
    // restore.atomicity): only the temp exists; `finally` removes it, and the
    // journal's priorDb never materialized so recovery is a no-op rollback.
    await opts.failpoint?.("before-swap");

    // §10.4: atomic replace. Close the live handle, drop the stale WAL/SHM, MOVE
    // the prior DB aside (rollback candidate), then rename temp → live + fsync dir.
    store.db.close();
    for (const sidecar of [`${livePath}-wal`, `${livePath}-shm`]) rmSync(sidecar, { force: true });
    renameSync(livePath, priorDb);
    fsyncPath(dir, "r");
    // Crash HERE (live moved aside, temp not yet in place): recovery finds priorDb
    // present + live absent → rolls prior back. No live-less end state survives.
    await opts.failpoint?.("after-move-aside");
    renameSync(tmpDb, livePath);
    fsyncPath(dir, "r");
    swapped = true;
  } catch (e) {
    // In-process failure before/at the swap: undo any partial move + drop artifacts.
    if (existsSync(priorDb) && !existsSync(livePath)) renameSync(priorDb, livePath);
    rmSync(tmpDb, { force: true });
    rmSync(priorDb, { force: true });
    rmSync(journalPath, { force: true });
    throw e;
  } finally {
    rmSync(tmpDb, { force: true });
  }

  // From here the live DB is the restored snapshot but the prior DB is preserved.
  // Any failure in the after-swap failpoint, the watermark/D6 txn, or a rebuild
  // hook rolls the prior DB back so the operation is all-or-nothing (F6).
  try {
    await opts.failpoint?.("after-swap");

    // Post-replace steps run on a FRESH connection to the restored DB.
    const db = openConnection({ path: livePath });
    try {
      // §10.7 (pre-rebuild): forward-migrate the restored DB to this store's
      // frontier BEFORE the post-restore rebuild. A backup taken before
      // `0013_links_v2` carries a v1 `note_links`; the projection rebuild's fold
      // now emits the v2 shape, so without this the rebuild throws
      // `table note_links has no column named alias` and the whole restore rolls
      // back. `runMigrations` is gap-tolerant + checksum-guarded + idempotent, so
      // a backup already at head is a no-op. A migration throw is caught below and
      // rolls the prior DB back (all-or-nothing, F6).
      runMigrations(db, migrations, now);

      const ledger = new LedgerRepo(db);
      const wm = new WatermarkRepo(db);
      const createdAt = now();
      const restoredCutSeq = header.cutSeq;

      const commit = db.transaction(() => {
        // §10.6: establish a fresh watermark at the restored cut (T7 → healthy).
        wm.forceUnblock(restoredCutSeq, createdAt);
        // §10.8 / D6: the ledger `db.restore` audit row (no git-ref event of its own).
        ledger.insertAuditEvent({
          seq: nextDbEventSeq(db),
          run_id: "db.restore",
          event_type: "db.restore",
          payload_hash: header.contentHash,
          git_head: null,
          created_at: createdAt,
        });
      });
      commit();

      // §10.7: post-restore rebuild hooks (projection rebuild registered by the CLI;
      // index rebuild added in Phase 3). Ledger tables are never touched by rebuild.
      // A hook throw rolls the whole restore back (F6).
      await runPostRestoreRebuild({ db });
    } finally {
      db.close();
    }

    // Success: the restored DB is authoritative; drop the rollback candidate FIRST
    // (so a crash after this point is recovered as "completed"), then the journal.
    rmSync(priorDb, { force: true });
    rmSync(journalPath, { force: true });
    fsyncPath(dir, "r");
    return { restoredCutSeq: header.cutSeq, preRestoreSeq, contentHash: header.contentHash };
  } catch (e) {
    // Post-swap failure — restore the prior DB (all-or-nothing contract, F6).
    if (swapped) rollbackToPrior();
    else rmSync(priorDb, { force: true });
    rmSync(journalPath, { force: true });
    throw e;
  }
  } finally {
    unpinRestoreTarget(pinnedRef);
  }
}

/**
 * `--force-unblock` (contract T6): clear the block WITHOUT a new verified backup,
 * recording the accepted RPO gap in a D6 `db.force_unblock` ledger audit row.
 */
export function forceUnblock(
  store: Store,
  opts: { now?: () => string } = {},
): { fromSeq: number; toSeq: number } {
  const now = opts.now ?? rfc3339;
  const db = store.db;
  const wm = new WatermarkRepo(db);
  const fromSeq = wm.get().seq;
  const toSeq = latestRunSeq(db);
  const createdAt = now();
  const commit = db.transaction(() => {
    wm.forceUnblock(toSeq, createdAt);
    db.prepare(
      `INSERT INTO audit_events (seq, run_id, event_type, payload_hash, git_head, created_at)
       VALUES (@seq, 'db.force_unblock', 'db.force_unblock', @payload_hash, NULL, @created_at)`,
    ).run({
      seq: nextDbEventSeq(db),
      // Allowlisted metadata only: the accepted RPO gap (from_seq → to_seq).
      payload_hash: `force_unblock:${fromSeq}:${toSeq}`,
      created_at: createdAt,
    });
  });
  commit();
  return { fromSeq, toSeq };
}

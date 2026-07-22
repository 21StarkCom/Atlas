/**
 * `backup/backup` — the AEAD ledger-backup writer + verifier (§2.8 step 4;
 * ledger-backup-contract §1–§9).
 *
 * `takeBackup` snapshots the live ledger DB via the SQLite **Online Backup API**
 * (`better-sqlite3` `db.backup`), falling back to `VACUUM INTO` under the caller's
 * lock if the entrypoint is absent, encrypts the snapshot into a single
 * temp-then-atomically-renamed `.abk` bundle (content hash + schema stamp),
 * self-verifies it, advances the fail-closed watermark, writes the D6 `db.backup`
 * ledger audit row, and prunes retention (keep-N + keep-forever-latest).
 *
 * The watermark advance + audit row make a successful `db backup` the primary
 * unblock (contract T5). A partially written bundle is never selectable: catalog
 * visibility comes only after the rename (§3).
 */
import {
  closeSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { randomBytes } from "node:crypto";
import { join } from "node:path";
import type { Store } from "../store.js";
import type { SqliteDatabase } from "../connection.js";
import {
  BUNDLE_MAGIC,
  BUNDLE_VERSION,
  BackupIntegrityError,
  contentHashOf,
  open as openBundle,
  seal,
  type Bundle,
  type BundleHeader,
} from "./aead.js";
import { WatermarkRepo } from "./watermark.js";
import { nextDbEventSeq, safeBackupCutSeq } from "../ledger/intents.js";
import { migration0001Core } from "../../migrations/0001_core.js";
import { migration0003Provenance } from "../../migrations/0003_provenance.js";
import { migration0004Claims } from "../../migrations/0004_claims.js";
import { migration0005LedgerFinalize } from "../../migrations/0005_ledger_finalize.js";
import { migration0006WorkflowIdempotency } from "../../migrations/0006_workflow_idempotency.js";
import { migration0008IndexConfigRevision } from "../../migrations/0008_index_config_revision.js";
import { migration0009RunSupersessions } from "../../migrations/0009_run_supersessions.js";
import { migration0010TrustState } from "../../migrations/0010_trust_state.js";
import { migration0011RunInputs } from "../../migrations/0011_run_inputs.js";
import { migration0012SyncCursors } from "../../migrations/0012_sync_cursors.js";
import { migration0013LinksV2 } from "../../migrations/0013_links_v2.js";

/**
 * The schema-migration heads THIS binary understands (§8 compatibility check). A
 * backup whose stamped `schemaHead` is not one of these (a future/unknown schema)
 * is incompatible and rejected by {@link verifyBackup}; `"(none)"` (pre-migration
 * empty schema) is always compatible.
 */
const KNOWN_SCHEMA_HEADS: Set<string> = new Set([
  "(none)",
  migration0001Core.id,
  migration0003Provenance.id,
  migration0004Claims.id,
  migration0005LedgerFinalize.id,
  // The Task 2.5 feature migration (registered by the workflows layer at store-open):
  // once applied, it becomes the schema head, so a backup stamped with it must be
  // recognized as a KNOWN (not future/unknown) schema.
  migration0006WorkflowIdempotency.id,
  // The Task 3.2 durable config-revision allocator (registered by the generation
  // layer at store-open via `registerGenerationMigration`): same rationale.
  migration0008IndexConfigRevision.id,
  // The Task 4.5 §refresh supersession ledger (registered by the workflows layer at
  // store-open alongside 0006): once applied it becomes the schema head, so a backup
  // stamped with it must be recognized as a KNOWN (not future/unknown) schema.
  migration0009RunSupersessions.id,
  // The Task 4.8 trust-state projection (registered by the workflows layer): same rationale.
  migration0010TrustState.id,
  // The Task 4.11 run-input record (registered by the workflows layer, for `git refresh`): same rationale.
  migration0011RunInputs.id,
  // The 60-A per-source sync cursor (registered by the CLI at store-open): same rationale.
  migration0012SyncCursors.id,
  // The v2 note-link reshape (task 3-4, in `openStore`'s DEFAULT set): once applied it
  // is the lexicographically-highest head, so this binary's own backups stamp `0013_links_v2`
  // and must be recognized as KNOWN (not future/unknown) schema.
  migration0013LinksV2.id,
]);

/**
 * Declare a migration id this binary understands as a schema head (§8.3 compatibility).
 *
 * A migration owned by a DOWNSTREAM package (one that depends on `@atlas/sqlite-store`,
 * e.g. `@atlas/jobs`'s `0002_jobs` / `0007_job_cancellations`) cannot be imported here —
 * that would be a dependency cycle. Once such a migration is applied it becomes the schema
 * head, so a backup stamped with it MUST be recognized or `verifyBackup` would reject this
 * binary's OWN backups as "future/unknown schema". The owning package therefore registers
 * its heads alongside its migrations at the composition root (see `registerJobsMigration`),
 * mirroring the `Store.registerMigration` seam.
 */
export function registerKnownSchemaHead(id: string): void {
  KNOWN_SCHEMA_HEADS.add(id);
}

/**
 * Backups pinned by an in-flight `db restore` (contract §9): retention never
 * prunes a pinned target until the restore completes. Keyed by resolved path.
 */
const pinnedRestoreTargets = new Set<string>();

/** Pin a restore target so retention cannot prune it mid-restore (contract §9). */
export function pinRestoreTarget(path: string): void {
  pinnedRestoreTargets.add(path);
}

/** Release an in-flight restore pin. */
export function unpinRestoreTarget(path: string): void {
  pinnedRestoreTargets.delete(path);
}

/** Backup subsystem config (the library form — the CLI supplies the custody key). */
export interface LedgerBackupConfig {
  /** Destination directory for `.abk` bundles (mode 0700). */
  readonly dir: string;
  /** The 32-byte AEAD key (custody per D9 is the caller's concern). */
  readonly key: Uint8Array;
  /** Key id recorded in the bundle header (default `"default"`). */
  readonly keyId?: string;
  /** keep-N retention (default 10) — plus keep-forever-latest (contract §9). */
  readonly keep?: number;
}

/** Result of {@link takeBackup}. */
export interface BackupResult {
  readonly backupRef: string;
  readonly seq: number;
  readonly method: "online-backup" | "vacuum-into";
}

const BUNDLE_SUFFIX = ".abk";
const DEFAULT_KEEP = 10;

function rfc3339(): string {
  return new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
}

/** The `db_schema_migrations` head applied at snapshot time (the §8 schema stamp). */
function schemaHead(db: SqliteDatabase): string {
  const row = db
    .prepare(`SELECT id FROM db_schema_migrations ORDER BY id DESC LIMIT 1`)
    .get() as { id: string } | undefined;
  return row?.id ?? "(none)";
}

/**
 * Snapshot the live DB to raw bytes. Primary: the Online Backup API (no
 * reader/writer stall). Fallback: `VACUUM INTO` — the caller MUST hold the
 * `ledger-maintenance` lock for the fallback (contract §1); the Online-Backup
 * path does not require it.
 */
async function snapshotBytes(
  db: SqliteDatabase,
  dir: string,
): Promise<{ bytes: Uint8Array; method: "online-backup" | "vacuum-into" }> {
  const tmp = join(dir, `.snap-${process.pid}-${randomBytes(6).toString("hex")}.db`);
  const cleanup = (): void => {
    for (const p of [tmp, `${tmp}-wal`, `${tmp}-shm`]) rmSync(p, { force: true });
  };
  try {
    let method: "online-backup" | "vacuum-into";
    if (typeof db.backup === "function") {
      await db.backup(tmp);
      method = "online-backup";
    } else {
      db.exec(`VACUUM INTO '${tmp.replace(/'/g, "''")}'`);
      method = "vacuum-into";
    }
    const bytes = readFileSync(tmp);
    return { bytes, method };
  } finally {
    cleanup();
  }
}

/** Bundle filename for a cut (temp-then-rename target, §3). */
function bundleName(cutSeq: number, utc: string): string {
  return `atlas-ledger-${cutSeq}-${utc.replace(/[:.]/g, "")}${BUNDLE_SUFFIX}`;
}

/**
 * Take a verified encrypted backup at the current ledger cut, advance the
 * watermark, write the D6 `db.backup` audit row, and prune retention. Returns the
 * bundle path + cut seq + snapshot method.
 */
export async function takeBackup(
  store: Store,
  cfg: LedgerBackupConfig,
  opts: { now?: () => string; audit?: boolean } = {},
): Promise<BackupResult> {
  const now = opts.now ?? rfc3339;
  const db = store.db;
  mkdirSync(cfg.dir, { recursive: true, mode: 0o700 });

  // The cut is the highest seq safely coverable WITHOUT falsely covering a run
  // whose step-3 commit has not landed (round-3 finding 2) and PRESERVING the −1
  // "nothing covered" sentinel for an empty/all-pending ledger (round-3 finding 3):
  // clamping −1 to 0 would falsely claim run seq 0 is backed up, so reconciliation
  // would never re-back-up the first committed run after a crash.
  const cutSeq = safeBackupCutSeq(db);
  const createdAt = now();

  const { bytes, method } = await snapshotBytes(db, cfg.dir);
  const header: BundleHeader = {
    magic: BUNDLE_MAGIC,
    version: BUNDLE_VERSION,
    keyId: cfg.keyId ?? "default",
    cutSeq,
    method,
    schemaHead: schemaHead(db),
    contentHash: contentHashOf(bytes),
    createdAt,
  };
  const bundle = seal(header, bytes, cfg.key);
  const serialized = JSON.stringify(bundle);

  // Temp-then-atomic-rename in the SAME directory (§3): the catalog only ever
  // sees a fully-written, fsync'd bundle.
  const tmpPath = join(cfg.dir, `.tmp-${cutSeq}-${randomBytes(8).toString("hex")}`);
  const finalPath = join(cfg.dir, bundleName(cutSeq, createdAt));
  writeFileSync(tmpPath, serialized, { mode: 0o600 });
  fsyncFile(tmpPath);
  renameSync(tmpPath, finalPath);
  fsyncDir(cfg.dir);

  // Self-verify before advancing the watermark — the watermark only advances on a
  // VERIFIED backup (contract §5.1).
  verifyBackup(cfg, finalPath);

  // Advance the fail-closed watermark (T2/T5) + write the D6 db.backup row.
  const wm = new WatermarkRepo(db);
  const doAudit = opts.audit ?? true;
  const commit = db.transaction(() => {
    wm.markCovered(cutSeq, createdAt);
    if (doAudit) {
      const seq = nextDbEventSeq(db);
      store.ledger.insertAuditEvent({
        seq,
        run_id: `db.backup`,
        event_type: "db.backup",
        payload_hash: header.contentHash,
        git_head: null,
        created_at: createdAt,
      });
    }
  });
  commit();

  pruneRetention(cfg);
  return { backupRef: finalPath, seq: cutSeq, method };
}

/**
 * Verify a backup bundle without mutating anything (contract §8): decryptability +
 * auth tag, content-hash match, magic/version, and schema-stamp presence. Throws
 * {@link BackupIntegrityError} on any failure (the CLI maps it to exit 1). A
 * wrong/revoked key or a truncated/corrupt bundle both fail here.
 */
export function verifyBackup(cfg: LedgerBackupConfig, backupRef: string): void {
  const path = resolveRef(cfg, backupRef);
  let bundle: Bundle;
  try {
    bundle = JSON.parse(readFileSync(path, "utf8")) as Bundle;
  } catch (e) {
    throw new BackupIntegrityError(`backup ${backupRef} is unreadable or not a valid bundle`, e);
  }
  if (bundle.header?.magic !== BUNDLE_MAGIC) {
    throw new BackupIntegrityError(`backup ${backupRef} is not an Atlas ledger backup (bad magic)`);
  }
  if (bundle.header.version !== BUNDLE_VERSION) {
    throw new BackupIntegrityError(
      `backup ${backupRef} format version ${bundle.header.version} unsupported (expected ${BUNDLE_VERSION})`,
    );
  }
  // Decrypt + auth tag + content-hash (throws on wrong/revoked key or corruption).
  openBundle(bundle, cfg.key);
  if (!bundle.header.schemaHead) {
    throw new BackupIntegrityError(`backup ${backupRef} is missing its schema stamp`);
  }
  // §8.3: schema COMPATIBILITY — the stamped schema head must be one this binary
  // understands, not merely present. A backup at a future/unknown schema cannot be
  // safely restored by this binary and is rejected (exit-1 class).
  if (!KNOWN_SCHEMA_HEADS.has(bundle.header.schemaHead)) {
    throw new BackupIntegrityError(
      `backup ${backupRef} was taken at schema "${bundle.header.schemaHead}", which this ` +
        `binary does not understand (known: ${[...KNOWN_SCHEMA_HEADS].join(", ")}) — incompatible`,
    );
  }
}

/** Decrypt a verified bundle to its raw snapshot bytes (restore path). */
export function decryptBackup(cfg: LedgerBackupConfig, backupRef: string): {
  bytes: Uint8Array;
  header: BundleHeader;
} {
  const path = resolveRef(cfg, backupRef);
  const bundle = JSON.parse(readFileSync(path, "utf8")) as Bundle;
  const bytes = openBundle(bundle, cfg.key);
  return { bytes, header: bundle.header };
}

/**
 * Read a bundle's plaintext header WITHOUT the AEAD key (the header is
 * authenticated-but-not-encrypted). Used by the CLI to bind the `db.restore`
 * broker challenge to the backup's content hash before the key is available.
 */
export function readBundleHeader(cfg: LedgerBackupConfig, backupRef: string): BundleHeader {
  const bundle = JSON.parse(readFileSync(resolveRef(cfg, backupRef), "utf8")) as Bundle;
  if (bundle.header?.magic !== BUNDLE_MAGIC) {
    throw new BackupIntegrityError(`backup ${backupRef} is not an Atlas ledger backup (bad magic)`);
  }
  return bundle.header;
}

/** A catalog entry derived by scanning the backup directory (contract §2). */
export interface CatalogEntry {
  readonly backupRef: string;
  readonly cutSeq: number;
  readonly createdAt: string;
  readonly contentHash: string;
  readonly keyId: string;
}

/**
 * List every selectable `.abk` bundle, newest cut first. A candidate is selectable
 * ONLY if it AUTHENTICATES under `cfg.key` (decrypt + auth tag + content-hash +
 * schema compatibility) — a corrupt, truncated, or wrong-key bundle carrying a
 * valid magic header is NOT selectable and is never counted as verified for
 * retention (round-2 finding). Bundles that fail to authenticate are excluded
 * (not deleted here — they may be encrypted under a rotated-out key, §7).
 */
export function listBackups(cfg: LedgerBackupConfig): CatalogEntry[] {
  let names: string[];
  try {
    names = readdirSync(cfg.dir);
  } catch {
    return [];
  }
  const entries: CatalogEntry[] = [];
  for (const name of names) {
    if (!name.endsWith(BUNDLE_SUFFIX)) continue; // `.tmp-*`/`.snap-*` are never selectable
    const path = join(cfg.dir, name);
    let bundle: Bundle;
    try {
      bundle = JSON.parse(readFileSync(path, "utf8")) as Bundle;
    } catch {
      continue; // an unparseable file is not a selectable backup
    }
    if (bundle.header?.magic !== BUNDLE_MAGIC) continue;
    // Authenticate before treating the candidate as a verified, selectable backup.
    try {
      verifyBackup(cfg, path);
    } catch {
      continue; // corrupt / truncated / wrong-key / incompatible → not selectable
    }
    entries.push({
      backupRef: path,
      cutSeq: bundle.header.cutSeq,
      createdAt: bundle.header.createdAt,
      contentHash: bundle.header.contentHash,
      keyId: bundle.header.keyId,
    });
  }
  entries.sort((a, b) =>
    b.cutSeq !== a.cutSeq ? b.cutSeq - a.cutSeq : b.createdAt.localeCompare(a.createdAt),
  );
  return entries;
}

/**
 * Prune to `{ latest-verified } ∪ { N most-recent verified }` (contract §9).
 * keep-forever-latest is NEVER pruned even if it falls outside the keep-N window.
 * Also sweeps stale `.tmp-*`/`.snap-*` crash leftovers (§3).
 */
export function pruneRetention(cfg: LedgerBackupConfig): void {
  const keep = cfg.keep ?? DEFAULT_KEEP;
  const all = listBackups(cfg);
  const retained = new Set<string>();
  if (all.length > 0) retained.add(all[0]!.backupRef); // keep-forever-latest (highest cut)
  for (const e of all.slice(0, keep)) retained.add(e.backupRef); // N most-recent
  for (const e of all) {
    // Never prune a backup pinned by an in-flight `db restore` (contract §9).
    if (!retained.has(e.backupRef) && !pinnedRestoreTargets.has(e.backupRef)) {
      rmSync(e.backupRef, { force: true });
    }
  }
  // Sweep crash leftovers from interrupted writes/snapshots.
  try {
    for (const name of readdirSync(cfg.dir)) {
      if (name.startsWith(".tmp-") || name.startsWith(".snap-")) {
        rmSync(join(cfg.dir, name), { force: true });
      }
    }
  } catch {
    /* dir vanished — nothing to sweep */
  }
}

function resolveRef(cfg: LedgerBackupConfig, backupRef: string): string {
  return backupRef.includes("/") || backupRef.includes("\\")
    ? backupRef
    : join(cfg.dir, backupRef);
}

/** Resolve a `backupRef` (bare name or path) to its absolute bundle path. */
export function resolveBackupRef(cfg: LedgerBackupConfig, backupRef: string): string {
  return resolveRef(cfg, backupRef);
}

function fsyncFile(path: string): void {
  const fd = openSync(path, "r+");
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

function fsyncDir(path: string): void {
  // Directory fsync is required so the rename is durable (§3). Not portable to
  // Windows, but Atlas ships macOS/Linux (plan §2.5); failure is non-fatal.
  try {
    const fd = openSync(path, "r");
    try {
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
  } catch {
    /* best-effort directory fsync */
  }
}

export { unlinkSync };

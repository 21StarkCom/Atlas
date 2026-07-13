/**
 * `quarantine/store` (Task 2.2 / #28) — the CLI-side quarantine store: the sole
 * holder of quarantined untrusted bytes. It implements the structural
 * {@link QuarantineSink} that `@atlas/scan`'s guards require, so the scan leaf
 * never back-edges into `apps/cli` (D14 no-app-import).
 *
 * ## Security spine
 * - **Ciphertext-only at rest.** The quarantined bytes AND their sensitive metadata
 *   (origin hash, content hash, size, finding rule ids/titles/offsets) are AEAD-
 *   sealed (AES-256-GCM) together IN MEMORY; only the sealed bundle is written.
 *   The plaintext header on disk carries ONLY minimal, authenticated routing/version
 *   fields — magic, version, key id, item id, created/expiry timestamps — none of
 *   which is a secret, an equality/dictionary oracle, or caller-supplied free text.
 *   Everything the reviewer flagged (originHash, contentHash, finding titles,
 *   offsets) now lives INSIDE the ciphertext.
 * - **Temp-then-rename.** The sealed bundle is written to a random `.qtmp-*`
 *   sibling, the file is fsync'd (a failure PROPAGATES — no silent success without a
 *   durable ciphertext copy), then atomically renamed to `q-<id>.aqz` and the
 *   directory fsync'd (best-effort — only explicitly-tolerated directory-fsync
 *   limitations are swallowed). A crash mid-write leaves at most a `.qtmp-*` file
 *   that is (a) already ciphertext and (b) never catalog-visible, swept by retention.
 * - **mode-0700 dir, no symlink components.** Created + chmod'd to `0700`; every
 *   existing path component is verified to be a real (non-symlink) entry so a
 *   planted symlink cannot redirect the store outside its confined location.
 * - **Minimized filenames.** `q-<16 random bytes hex>.aqz` — no origin, no secret,
 *   no finding text in the name. The item id is bound into the authenticated header,
 *   and every read/list/purge validates the filename↔id binding.
 * - **Key custody + rotation.** The current AEAD key + its id are injected; reads
 *   resolve the key per item by the bundle's stamped `keyId` (retained rotated-out
 *   keys via an injected resolver), and a revoked key id fails closed with a typed
 *   {@link QuarantineKeyRevokedError}. The store never persists a key.
 * - **Bounded retention.** keep-N most-recent + a TTL are enforced on every write
 *   (not only when a purge is manually invoked) and by {@link QuarantineStore.purge}.
 *   Temp-sweeping only touches remnants older than a safety window, so a purge never
 *   races an in-flight temp of a concurrent quarantine. Retention decisions read
 *   ONLY authenticated header fields; a corrupt/tampered bundle fails closed (it is
 *   never trusted to drive deletion of a valid neighbour).
 * - **Crash-safe purge.** `discard`/`purge` fsync the containing directory after the
 *   unlink(s) before reporting success, so a crash can never resurrect a deletion the
 *   store already reported (purge batches its unlinks and fsyncs the dir once).
 */
import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import {
  closeSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
  chmodSync,
} from "node:fs";
import { join } from "node:path";
import type { QuarantineSink, SecretFinding } from "@atlas/scan";

/** AES-256-GCM parameters (matches the ledger-backup AEAD envelope). */
export const QUARANTINE_KEY_BYTES = 32;
const NONCE_BYTES = 12;
const CIPHER = "aes-256-gcm";

/** Bundle format identity. */
export const QUARANTINE_MAGIC = "ATLAS-QUARANTINE";
export const QUARANTINE_VERSION = 2;

/** Committed bundle suffix (only these are catalog-visible). */
const BUNDLE_SUFFIX = ".aqz";
/** In-flight temp prefix (a crash leftover; never listed as an item). */
const TEMP_PREFIX = ".qtmp-";
/** Committed-bundle filename pattern (16 random bytes hex → 32 chars). */
const BUNDLE_NAME = /^q-([0-9a-f]{32})\.aqz$/;
/** Default safety window (ms): temps younger than this are never swept (never race in-flight writes). */
const DEFAULT_STALE_TEMP_MS = 60_000;

/** Non-secret finding metadata — persisted INSIDE the ciphertext (never plaintext at rest). */
interface StoredFinding {
  readonly ruleId: string;
  readonly title: string;
  readonly severity: string;
  readonly startOffset: number;
  readonly endOffset: number;
}

/**
 * The plaintext, tamper-evident routing header (bound as AEAD AAD). Carries ONLY
 * minimal non-secret fields needed to route, version, resolve custody, and make a
 * retention decision WITHOUT the key — no origin hash, no content hash, no finding
 * text (all of which are encrypted). Any change to a field fails the auth tag.
 */
export interface QuarantineHeader {
  readonly magic: string;
  readonly version: number;
  readonly keyId: string;
  readonly itemId: string;
  readonly createdAt: string;
  readonly expiresAt: string;
}

/** The sensitive metadata sealed WITH the payload (never on disk in plaintext). */
export interface QuarantineMeta {
  readonly originHash: string;
  readonly contentHash: string;
  readonly sizeBytes: number;
  readonly findings: readonly StoredFinding[];
}

/** The encrypted inner document (metadata + the quarantined bytes) sealed as one unit. */
interface SealedInner extends QuarantineMeta {
  readonly payload: string; // base64 of the quarantined bytes
}

/** The on-disk bundle: routing header (AAD) + nonce + tag + ciphertext (base64 in JSON). */
interface QuarantineBundle {
  readonly header: QuarantineHeader;
  readonly nonce: string;
  readonly authTag: string;
  readonly ciphertext: string;
}

/** Raised when a bundle fails to decrypt/authenticate/validate (wrong key, tamper, truncation, corrupt shape). */
export class QuarantineIntegrityError extends Error {
  constructor(
    message: string,
    override readonly cause?: unknown,
  ) {
    super(message);
    this.name = "QuarantineIntegrityError";
  }
}

/** Raised when an item's stamped key id has been explicitly revoked — fails closed, distinct from corruption. */
export class QuarantineKeyRevokedError extends QuarantineIntegrityError {
  readonly keyId: string;
  constructor(keyId: string) {
    super(`quarantine key id ${JSON.stringify(keyId)} is revoked — the item cannot be decrypted`);
    this.name = "QuarantineKeyRevokedError";
    this.keyId = keyId;
  }
}

/** Raised when no custody key is available for an item's stamped key id (unknown/rotated-away, no resolver). */
export class QuarantineKeyUnavailableError extends QuarantineIntegrityError {
  readonly keyId: string;
  constructor(keyId: string, cause?: unknown) {
    super(`no custody key available for quarantine key id ${JSON.stringify(keyId)}`, cause);
    this.name = "QuarantineKeyUnavailableError";
    this.keyId = keyId;
  }
}

/** Resolves a retained (possibly rotated-out) AEAD key by its id; throws if unavailable. */
export type QuarantineKeyResolver = (keyId: string) => Uint8Array;

/** Options for a {@link QuarantineStore}. The custody key is supplied in-process. */
export interface QuarantineStoreOptions {
  /** Quarantine directory (created + chmod'd to 0700; symlink components rejected). Outside repo+vault. */
  readonly dir: string;
  /** The 32-byte CURRENT AEAD key (writes + reads of items stamped with the current key id). */
  readonly key: Uint8Array;
  /** Current key id recorded in the bundle header + used to write (default `"cli-custody-v1"`). */
  readonly keyId?: string;
  /**
   * Resolve a retained key for an item whose stamped `keyId` is NOT the current one
   * (rotation §7). Called only for non-current, non-revoked ids. Omit ⇒ only the
   * current key id resolves (any other stamped id ⇒ {@link QuarantineKeyUnavailableError}).
   */
  readonly resolveKey?: QuarantineKeyResolver;
  /** Key ids that are revoked: any item stamped with one fails closed ({@link QuarantineKeyRevokedError}). */
  readonly revokedKeyIds?: readonly string[];
  /** keep-N most-recent retention bound (default 200). */
  readonly keep?: number;
  /** Item TTL in days (default 30) → `expiresAt`. */
  readonly retentionDays?: number;
  /** Safety window (ms): a `.qtmp-*` remnant is swept only when older than this (default 60_000). */
  readonly staleTempMs?: number;
  /** Enforce keep-N/TTL/temp-sweep after each write (default true). Set false in tests exercising explicit purge. */
  readonly autoRetention?: boolean;
  /** Injectable clock (tests). Defaults to wall-clock. */
  readonly clock?: () => Date;
  /**
   * TEST-ONLY fault hook fired AFTER the temp bundle is fsync'd but BEFORE the
   * rename — lets a test simulate a crash mid-quarantine and assert no plaintext
   * (and no committed item) is left behind. Never set in production.
   */
  readonly onAfterTempWrite?: (tempPath: string) => void;
  /**
   * TEST-ONLY fault hook fired just before the temp-file fsync — throwing simulates
   * an EIO/ENOSPC fsync failure so a test can assert the write fails closed (no
   * committed item, no durable "success" without a synced ciphertext). Never in prod.
   */
  readonly onTempFsync?: (tempPath: string) => void;
  /**
   * TEST-ONLY fault hook fired at the directory fsync that follows a DELETION
   * (discard/purge). Throwing simulates a crash between the unlink and the durable
   * directory record, letting a test assert the deletion fails closed rather than
   * reporting a success a crash could later resurrect. Never set in production.
   */
  readonly onDeleteDirFsync?: (dir: string) => void;
}

function sha256Hex(data: Uint8Array | string): string {
  return createHash("sha256").update(data).digest("hex");
}

/** Canonical AAD bytes for a routing header (stable field order, layout-independent). */
function aadOf(h: QuarantineHeader): Buffer {
  const canonical = JSON.stringify([h.magic, h.version, h.keyId, h.itemId, h.createdAt, h.expiresAt]);
  return Buffer.from(canonical, "utf8");
}

function rfc3339(d: Date): string {
  return d.toISOString().replace(/\.\d{3}Z$/, "Z");
}

/** Type guard: a plausibly-shaped bundle parsed from disk (defends list/purge/read against malformed input). */
function isBundleShape(v: unknown): v is QuarantineBundle {
  if (typeof v !== "object" || v === null) return false;
  const b = v as Record<string, unknown>;
  if (typeof b.nonce !== "string" || typeof b.authTag !== "string" || typeof b.ciphertext !== "string") return false;
  const h = b.header as Record<string, unknown> | undefined;
  if (typeof h !== "object" || h === null) return false;
  return (
    typeof h.magic === "string" &&
    typeof h.version === "number" &&
    typeof h.keyId === "string" &&
    typeof h.itemId === "string" &&
    typeof h.createdAt === "string" &&
    typeof h.expiresAt === "string"
  );
}

/** Type guard: a plausibly-shaped decrypted inner document. */
function isInnerShape(v: unknown): v is SealedInner {
  if (typeof v !== "object" || v === null) return false;
  const i = v as Record<string, unknown>;
  return (
    typeof i.originHash === "string" &&
    typeof i.contentHash === "string" &&
    typeof i.sizeBytes === "number" &&
    Array.isArray(i.findings) &&
    typeof i.payload === "string"
  );
}

/**
 * The CLI-side encrypted quarantine store. Constructed with an explicit dir + key
 * (custody resolution + location validation are `quarantine/config.ts`'s job);
 * safe to unit-test in isolation.
 */
export class QuarantineStore implements QuarantineSink {
  private readonly dir: string;
  private readonly key: Uint8Array;
  private readonly keyId: string;
  private readonly resolveKey: QuarantineKeyResolver | undefined;
  private readonly revoked: ReadonlySet<string>;
  private readonly keep: number;
  private readonly retentionDays: number;
  private readonly staleTempMs: number;
  private readonly autoRetention: boolean;
  private readonly clock: () => Date;
  private readonly onAfterTempWrite: ((tempPath: string) => void) | undefined;
  private readonly onTempFsync: ((tempPath: string) => void) | undefined;
  private readonly onDeleteDirFsync: ((dir: string) => void) | undefined;

  constructor(opts: QuarantineStoreOptions) {
    if (opts.key.length !== QUARANTINE_KEY_BYTES) {
      throw new QuarantineIntegrityError(
        `quarantine AEAD key must be ${QUARANTINE_KEY_BYTES} bytes, got ${opts.key.length}`,
      );
    }
    this.dir = opts.dir;
    this.key = opts.key;
    this.keyId = opts.keyId ?? "cli-custody-v1";
    this.resolveKey = opts.resolveKey;
    this.revoked = new Set(opts.revokedKeyIds ?? []);
    this.keep = opts.keep ?? 200;
    this.retentionDays = opts.retentionDays ?? 30;
    this.staleTempMs = opts.staleTempMs ?? DEFAULT_STALE_TEMP_MS;
    this.autoRetention = opts.autoRetention ?? true;
    this.clock = opts.clock ?? (() => new Date());
    this.onAfterTempWrite = opts.onAfterTempWrite;
    this.onTempFsync = opts.onTempFsync;
    this.onDeleteDirFsync = opts.onDeleteDirFsync;
  }

  /**
   * Ensure the quarantine dir exists with a strict `0700` mode. The store must never
   * write THROUGH a symlinked leaf an attacker planted to redirect our 0700 dir +
   * ciphertext writes elsewhere, so the leaf is required to be a real directory (a
   * pre-existing symlink at the quarantine path itself is refused). Broader
   * containment (never inside the repo/vault, even via a symlinked ancestor) is
   * enforced against the realpath by `quarantine/config.ts` before construction.
   */
  private ensureDir(): void {
    try {
      const st = lstatSync(this.dir);
      if (st.isSymbolicLink()) throw new QuarantineIntegrityError(`quarantine dir is a symlink: ${this.dir}`);
      if (!st.isDirectory()) throw new QuarantineIntegrityError(`quarantine path exists and is not a directory: ${this.dir}`);
    } catch (e) {
      if (e instanceof QuarantineIntegrityError) throw e;
      // ENOENT (or similar) — the dir does not exist yet; create it below.
    }
    mkdirSync(this.dir, { recursive: true, mode: 0o700 });
    // A racing symlink swap could still land after mkdir — verify the final node.
    if (lstatSync(this.dir).isSymbolicLink()) {
      throw new QuarantineIntegrityError(`quarantine dir is a symlink: ${this.dir}`);
    }
    // mkdir mode is masked by umask; force the exact mode.
    chmodSync(this.dir, 0o700);
  }

  /**
   * {@link QuarantineSink} — seal `bytes` (ciphertext-only, sensitive metadata sealed
   * with them) and write atomically (temp-then-rename). Enforces retention afterward.
   */
  async quarantine(input: {
    readonly bytes: Uint8Array;
    readonly origin: string;
    readonly findings: readonly SecretFinding[];
  }): Promise<void> {
    await Promise.resolve();
    this.quarantineItem(input);
  }

  /** Synchronous core of {@link quarantine}; returns the opaque item id. */
  quarantineItem(input: {
    readonly bytes: Uint8Array;
    readonly origin: string;
    readonly findings: readonly SecretFinding[];
  }): string {
    this.ensureDir();

    const now = this.clock();
    const expires = new Date(now.getTime() + this.retentionDays * 24 * 60 * 60 * 1000);
    const itemId = randomBytes(16).toString("hex");

    const header: QuarantineHeader = {
      magic: QUARANTINE_MAGIC,
      version: QUARANTINE_VERSION,
      keyId: this.keyId,
      itemId,
      createdAt: rfc3339(now),
      expiresAt: rfc3339(expires),
    };

    // Sensitive metadata + payload sealed together — nothing sensitive stays plaintext.
    const inner: SealedInner = {
      originHash: sha256Hex(input.origin),
      contentHash: sha256Hex(input.bytes),
      sizeBytes: input.bytes.byteLength,
      findings: input.findings.map((f) => ({
        ruleId: f.ruleId,
        title: f.title,
        severity: f.severity,
        startOffset: f.startOffset,
        endOffset: f.endOffset,
      })),
      payload: Buffer.from(input.bytes).toString("base64"),
    };

    // Seal in memory — only ciphertext is ever written.
    const nonce = randomBytes(NONCE_BYTES);
    const cipher = createCipheriv(CIPHER, this.key, nonce);
    cipher.setAAD(aadOf(header));
    const plaintext = Buffer.from(JSON.stringify(inner), "utf8");
    const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
    const authTag = cipher.getAuthTag();
    const bundle: QuarantineBundle = {
      header,
      nonce: nonce.toString("base64"),
      authTag: authTag.toString("base64"),
      ciphertext: ciphertext.toString("base64"),
    };
    const serialized = Buffer.from(JSON.stringify(bundle), "utf8");

    // Temp-then-rename: write ciphertext to a random temp sibling, fsync, rename.
    const finalPath = join(this.dir, `q-${itemId}${BUNDLE_SUFFIX}`);
    const tempPath = join(this.dir, `${TEMP_PREFIX}${randomBytes(8).toString("hex")}`);
    writeFileSync(tempPath, serialized, { mode: 0o600 });
    try {
      this.fsyncFile(tempPath); // PROPAGATES a real fsync error — no undurable "success"
    } catch (e) {
      // A failed temp fsync means no durable ciphertext copy exists — remove the
      // partial temp and fail closed rather than renaming an unsynced file.
      rmSync(tempPath, { force: true });
      throw e;
    }
    // TEST-ONLY: simulate a crash between the temp write and the rename.
    this.onAfterTempWrite?.(tempPath);
    renameSync(tempPath, finalPath);
    this.fsyncDir(this.dir);

    if (this.autoRetention) this.enforceRetention();
    return itemId;
  }

  /**
   * fsync a just-written FILE. A failure is NOT swallowed: without a durable
   * ciphertext copy the caller must not believe the quarantine succeeded (finding —
   * fsyncPath used to suppress every error and rename over EIO/ENOSPC).
   */
  private fsyncFile(p: string): void {
    this.onTempFsync?.(p); // test-only fault injection
    const fd = openSync(p, "r");
    try {
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
  }

  /**
   * fsync the containing DIRECTORY (to durably record the rename). Only the
   * well-known "directory fsync unsupported on this FS" errnos are tolerated;
   * anything else propagates.
   */
  private fsyncDir(p: string): void {
    let fd: number | undefined;
    try {
      fd = openSync(p, "r");
      fsyncSync(fd);
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code;
      // EINVAL/ENOTSUP/EISDIR/EPERM/EACCES: directory fsync isn't supported/permitted
      // on some filesystems/platforms (e.g. some macOS/network FSes). Tolerate ONLY
      // these; the file itself was already durably fsync'd above.
      if (code !== "EINVAL" && code !== "ENOTSUP" && code !== "EISDIR" && code !== "EPERM" && code !== "EACCES") {
        throw e;
      }
    } finally {
      if (fd !== undefined) closeSync(fd);
    }
  }

  /** Resolve the AEAD key for an item stamped with `keyId` (current, retained, or revoked). */
  private keyForRead(keyId: string): Uint8Array {
    if (this.revoked.has(keyId)) throw new QuarantineKeyRevokedError(keyId);
    if (keyId === this.keyId) return this.key;
    if (this.resolveKey === undefined) throw new QuarantineKeyUnavailableError(keyId);
    let k: Uint8Array;
    try {
      k = this.resolveKey(keyId);
    } catch (e) {
      throw new QuarantineKeyUnavailableError(keyId, e);
    }
    if (k.length !== QUARANTINE_KEY_BYTES) {
      throw new QuarantineKeyUnavailableError(keyId, new Error(`resolved key is ${k.length} bytes`));
    }
    return k;
  }

  /**
   * Read, validate, authenticate + decrypt a committed bundle by FILENAME. Enforces
   * (in order, failing closed on the first problem): the `q-<id>.aqz` filename shape,
   * valid JSON + bundle schema, `magic`/`version`, the filename↔`itemId` binding,
   * key resolution by the stamped `keyId`, the AEAD tag over the AAD header, the
   * inner-document schema, and the content-hash of the decrypted payload.
   */
  private authenticate(name: string): { header: QuarantineHeader; meta: QuarantineMeta; bytes: Uint8Array } {
    const m = BUNDLE_NAME.exec(name);
    if (m === null) throw new QuarantineIntegrityError(`not a committed quarantine bundle filename: ${name}`);
    const idFromName = m[1]!;

    let parsed: unknown;
    try {
      parsed = JSON.parse(readFileSync(join(this.dir, name), "utf8"));
    } catch (e) {
      throw new QuarantineIntegrityError(`quarantine bundle ${name} is unreadable or not valid JSON`, e);
    }
    if (!isBundleShape(parsed)) throw new QuarantineIntegrityError(`quarantine bundle ${name} has a malformed shape`);
    const bundle = parsed;
    const { header } = bundle;

    if (header.magic !== QUARANTINE_MAGIC) throw new QuarantineIntegrityError(`bad magic in ${name}`);
    if (header.version !== QUARANTINE_VERSION) {
      throw new QuarantineIntegrityError(`unsupported quarantine version ${header.version} in ${name}`);
    }
    // Filename↔ID binding: a renamed-in item cannot masquerade as another id.
    if (header.itemId !== idFromName) {
      throw new QuarantineIntegrityError(`filename/itemId mismatch in ${name} (header ${header.itemId})`);
    }

    const key = this.keyForRead(header.keyId);
    let plaintext: Buffer;
    try {
      const nonce = Buffer.from(bundle.nonce, "base64");
      const authTag = Buffer.from(bundle.authTag, "base64");
      const ciphertext = Buffer.from(bundle.ciphertext, "base64");
      const decipher = createDecipheriv(CIPHER, key, nonce);
      decipher.setAAD(aadOf(header));
      decipher.setAuthTag(authTag);
      plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
    } catch (e) {
      throw new QuarantineIntegrityError(
        `quarantine item ${header.itemId} failed to decrypt/authenticate (wrong/revoked key or corrupt/tampered bundle)`,
        e,
      );
    }

    let inner: unknown;
    try {
      inner = JSON.parse(plaintext.toString("utf8"));
    } catch (e) {
      throw new QuarantineIntegrityError(`quarantine item ${header.itemId} decrypted to non-JSON`, e);
    }
    if (!isInnerShape(inner)) throw new QuarantineIntegrityError(`quarantine item ${header.itemId} inner shape invalid`);

    const bytes = new Uint8Array(Buffer.from(inner.payload, "base64"));
    const recomputed = sha256Hex(bytes);
    if (recomputed !== inner.contentHash) {
      throw new QuarantineIntegrityError(
        `quarantine content hash mismatch for ${header.itemId}: ${inner.contentHash} != ${recomputed}`,
      );
    }
    const meta: QuarantineMeta = {
      originHash: inner.originHash,
      contentHash: inner.contentHash,
      sizeBytes: inner.sizeBytes,
      findings: inner.findings,
    };
    return { header, meta, bytes };
  }

  /**
   * List committed items, VALIDATED + AUTHENTICATED (only `q-*.aqz` whose header +
   * AEAD tag + filename binding all verify). A corrupt/tampered/unresolvable-key
   * bundle is NOT returned — it is reported via {@link QuarantineStore.listWithErrors}
   * and never trusted to drive a retention decision (fail closed).
   */
  list(): QuarantineHeader[] {
    return this.listWithErrors().items;
  }

  /** Like {@link list} but also surfaces the entries that failed validation (fail-closed diagnostics). */
  listWithErrors(): { items: QuarantineHeader[]; corrupt: { name: string; error: string }[] } {
    let entries: string[];
    try {
      entries = readdirSync(this.dir);
    } catch {
      return { items: [], corrupt: [] };
    }
    const items: QuarantineHeader[] = [];
    const corrupt: { name: string; error: string }[] = [];
    for (const name of entries) {
      if (!BUNDLE_NAME.test(name)) continue; // temps / stray files are not items
      try {
        items.push(this.authenticate(name).header);
      } catch (e) {
        corrupt.push({ name, error: e instanceof Error ? e.message : String(e) });
      }
    }
    // Stable order: oldest first (createdAt, then itemId).
    items.sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.itemId.localeCompare(b.itemId));
    return { items, corrupt };
  }

  /**
   * Decrypt + authenticate an item by id (the reveal surface consumed by the
   * privileged `quarantine inspect`/`resolve` ops in Phase 5). Returns the routing
   * header, the sealed sensitive metadata, and the plaintext bytes.
   */
  read(itemId: string): { header: QuarantineHeader; meta: QuarantineMeta; bytes: Uint8Array } {
    return this.authenticate(`q-${itemId}${BUNDLE_SUFFIX}`);
  }

  /**
   * Remove one committed item by id (used by `quarantine resolve --discard`), then
   * fsync the directory so the deletion is durable — a crash cannot resurrect an item
   * this reported as discarded (finding: unlink without a directory fsync).
   */
  discard(itemId: string): void {
    this.unlinkItem(itemId);
    this.syncDirAfterDelete();
  }

  /** Unlink a committed item WITHOUT a directory fsync (batched callers fsync once). */
  private unlinkItem(itemId: string): void {
    if (!/^[0-9a-f]{32}$/.test(itemId)) throw new QuarantineIntegrityError(`refusing to discard a non-item id: ${itemId}`);
    rmSync(join(this.dir, `q-${itemId}${BUNDLE_SUFFIX}`), { force: true });
  }

  /**
   * fsync the quarantine directory after a deletion so the unlink is durably recorded
   * before we report success. A crash before this returns must not be able to
   * resurrect a purged/discarded entry. Fires the TEST-ONLY fault hook first so a test
   * can simulate a fsync failure and assert the deletion fails closed.
   */
  private syncDirAfterDelete(): void {
    this.onDeleteDirFsync?.(this.dir);
    this.fsyncDir(this.dir);
  }

  /**
   * Retention + crash-safe purge, invoked automatically after each write and callable
   * directly: (1) sweep `.qtmp-*` remnants older than `staleTempMs` (never touching an
   * in-flight temp of a concurrent write), (2) remove AUTHENTICATED items past their
   * TTL, (3) trim to the keep-N most-recent. Corrupt/tampered bundles are left in
   * place (fail closed) and reported in `corrupt`, never used to expire a valid item.
   */
  purge(opts?: { staleTempMs?: number }): {
    expired: string[];
    trimmed: string[];
    tempsSwept: number;
    corrupt: { name: string; error: string }[];
  } {
    const staleTempMs = opts?.staleTempMs ?? this.staleTempMs;
    const nowMs = this.clock().getTime();

    let tempsSwept = 0;
    let entries: string[];
    try {
      entries = readdirSync(this.dir);
    } catch {
      return { expired: [], trimmed: [], tempsSwept: 0, corrupt: [] };
    }
    for (const name of entries) {
      if (!name.startsWith(TEMP_PREFIX)) continue;
      const p = join(this.dir, name);
      let ageMs = Infinity;
      try {
        ageMs = nowMs - statSync(p).mtimeMs;
      } catch {
        continue;
      }
      // staleTempMs <= 0 ⇒ sweep every remnant unconditionally; otherwise only those
      // older than the safety window (so a concurrent write's fresh temp survives).
      if (staleTempMs <= 0 || ageMs >= staleTempMs) {
        rmSync(p, { force: true });
        tempsSwept++;
      }
    }

    const nowIso = rfc3339(this.clock());
    const { items, corrupt } = this.listWithErrors();
    const expired: string[] = [];
    const live: QuarantineHeader[] = [];
    for (const h of items) {
      if (h.expiresAt <= nowIso) {
        this.unlinkItem(h.itemId); // batched — a single directory fsync follows below
        expired.push(h.itemId);
      } else {
        live.push(h);
      }
    }

    // keep-N most-recent (list is oldest-first, so trim the front).
    const trimmed: string[] = [];
    if (live.length > this.keep) {
      const overflow = live.length - this.keep;
      for (let i = 0; i < overflow; i++) {
        const h = live[i]!;
        this.unlinkItem(h.itemId); // batched — see the single fsync below
        trimmed.push(h.itemId);
      }
    }

    // Crash-safe purge: fsync the directory ONCE after the batch of unlinks so no
    // reported deletion can be resurrected by a crash (finding: unlink without a
    // directory fsync). Skipped only when nothing was removed.
    if (tempsSwept > 0 || expired.length > 0 || trimmed.length > 0) {
      this.syncDirAfterDelete();
    }

    return { expired, trimmed, tempsSwept, corrupt };
  }

  /** Best-effort retention after a write — must never make a successful quarantine appear to fail. */
  private enforceRetention(): void {
    try {
      this.purge({ staleTempMs: this.staleTempMs });
    } catch {
      // Retention is bounded/best-effort; a corrupt neighbour or fs hiccup here must
      // not fail the write whose ciphertext is already durably committed.
    }
  }
}

/** True when `name` is a committed-bundle filename (`q-<32 hex>.aqz`). */
export function isBundleFilename(name: string): boolean {
  return BUNDLE_NAME.test(name);
}

/** True when `name` is an in-flight/crash-leftover temp remnant (`.qtmp-*`). */
export function isTempFilename(name: string): boolean {
  return name.startsWith(TEMP_PREFIX);
}

/**
 * STRUCTURAL bundle validation WITHOUT the custody key — for callers (e.g. `doctor`)
 * that must judge a quarantine dir's at-rest posture but do not hold the AEAD key.
 * Returns an error string when the entry named `name` in `dir` is NOT a well-formed
 * sealed bundle, or `null` when it is structurally valid. It `lstat`s the entry so a
 * SYMLINK (or a directory) wearing a bundle name is rejected, then confirms the file
 * parses as JSON with a valid bundle shape, the right magic/version, and a
 * filename↔`itemId` binding — so a plaintext or corrupt file with a valid-looking name
 * cannot pass as sealed. (AEAD integrity still requires the key; that is verified by
 * the store's authenticated {@link QuarantineStore.listWithErrors}.)
 */
export function validateBundleStructure(dir: string, name: string): string | null {
  const m = BUNDLE_NAME.exec(name);
  if (m === null) return `not a committed bundle filename: ${name}`;
  const idFromName = m[1]!;
  const p = join(dir, name);
  let st;
  try {
    st = lstatSync(p);
  } catch (e) {
    return `unreadable entry ${name}: ${e instanceof Error ? e.message : String(e)}`;
  }
  if (st.isSymbolicLink()) return `${name} is a symlink (a sealed bundle must be a regular file)`;
  if (!st.isFile()) return `${name} is not a regular file`;
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(p, "utf8"));
  } catch {
    return `${name} is not a sealed bundle (unreadable or not valid JSON — possible plaintext at rest)`;
  }
  if (!isBundleShape(parsed)) return `${name} has a malformed bundle shape (not a sealed bundle)`;
  const { header } = parsed;
  if (header.magic !== QUARANTINE_MAGIC) return `${name} has bad magic (not a sealed bundle)`;
  if (header.version !== QUARANTINE_VERSION) return `${name} has unsupported version ${header.version}`;
  if (header.itemId !== idFromName) return `${name} has a filename/itemId mismatch (header ${header.itemId})`;
  return null;
}

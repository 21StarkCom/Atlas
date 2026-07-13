/**
 * `backup/aead` — the AEAD envelope for encrypted ledger backups (contract §7,
 * §8). AES-256-GCM over the raw SQLite snapshot bytes, with the bundle header
 * bound as additional authenticated data (AAD) so header tampering (cutSeq,
 * schema stamp, content hash, key id) is caught by the auth-tag check.
 *
 * The AEAD key is **trusted-CLI-readable** (D9/D13): the CLI process that writes
 * the ledger encrypts/decrypts its own backup — there is no broker backup-IPC
 * primitive. Custody (Keychain / root-provisioned file) is the CLI's job; this
 * module takes the 32-byte key directly.
 */
import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";

/** AES-256-GCM: 32-byte key, 12-byte nonce, 16-byte tag. */
export const AEAD_KEY_BYTES = 32;
const NONCE_BYTES = 12;
const CIPHER = "aes-256-gcm";

/** The magic + format version stamped into every bundle. */
export const BUNDLE_MAGIC = "ATLAS-LEDGER-BACKUP";
export const BUNDLE_VERSION = 1;

/**
 * The plaintext, tamper-evident bundle header (contract §2, §8). Bound as AAD, so
 * any change fails the auth tag. `contentHash` is the sha256 of the decrypted
 * snapshot; `schemaHead` is the `db_schema_migrations` head at `cutSeq` (§8).
 */
export interface BundleHeader {
  readonly magic: string;
  readonly version: number;
  readonly keyId: string;
  readonly cutSeq: number;
  readonly method: "online-backup" | "vacuum-into";
  readonly schemaHead: string;
  readonly contentHash: string;
  readonly createdAt: string;
}

/** The on-disk bundle: header (AAD) + nonce + tag + ciphertext, all base64 in JSON. */
export interface Bundle {
  readonly header: BundleHeader;
  readonly nonce: string;
  readonly authTag: string;
  readonly ciphertext: string;
}

/** Raised when a bundle fails to decrypt/authenticate (wrong/revoked key, tamper, truncation). */
export class BackupIntegrityError extends Error {
  constructor(message: string, override readonly cause?: unknown) {
    super(message);
    this.name = "BackupIntegrityError";
  }
}

/** sha256 hex of the raw snapshot bytes (the stored + recomputed content hash). */
export function contentHashOf(snapshot: Uint8Array): string {
  return createHash("sha256").update(snapshot).digest("hex");
}

/** Canonical AAD bytes for a header (stable key order, independent of JSON layout). */
function aadOf(h: BundleHeader): Buffer {
  const canonical = [
    h.magic,
    String(h.version),
    h.keyId,
    String(h.cutSeq),
    h.method,
    h.schemaHead,
    h.contentHash,
    h.createdAt,
  ].join("\n");
  return Buffer.from(canonical, "utf8");
}

/** Encrypt `snapshot` under `key`, binding `header` as AAD. Returns the full bundle. */
export function seal(header: BundleHeader, snapshot: Uint8Array, key: Uint8Array): Bundle {
  if (key.length !== AEAD_KEY_BYTES) {
    throw new BackupIntegrityError(`AEAD key must be ${AEAD_KEY_BYTES} bytes, got ${key.length}`);
  }
  const nonce = randomBytes(NONCE_BYTES);
  const cipher = createCipheriv(CIPHER, key, nonce);
  cipher.setAAD(aadOf(header));
  const ciphertext = Buffer.concat([cipher.update(snapshot), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return {
    header,
    nonce: nonce.toString("base64"),
    authTag: authTag.toString("base64"),
    ciphertext: ciphertext.toString("base64"),
  };
}

/**
 * Decrypt + authenticate a bundle. Verifies the AEAD tag (wrong/revoked key or
 * tampered header/ciphertext ⇒ {@link BackupIntegrityError}) AND that the
 * recomputed content hash matches the header — so a truncated or corrupt bundle
 * is rejected, never silently restored (contract §8, §12).
 */
export function open(bundle: Bundle, key: Uint8Array): Uint8Array {
  if (key.length !== AEAD_KEY_BYTES) {
    throw new BackupIntegrityError(`AEAD key must be ${AEAD_KEY_BYTES} bytes, got ${key.length}`);
  }
  let plaintext: Buffer;
  try {
    const nonce = Buffer.from(bundle.nonce, "base64");
    const authTag = Buffer.from(bundle.authTag, "base64");
    const ciphertext = Buffer.from(bundle.ciphertext, "base64");
    const decipher = createDecipheriv(CIPHER, key, nonce);
    decipher.setAAD(aadOf(bundle.header));
    decipher.setAuthTag(authTag);
    plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  } catch (e) {
    throw new BackupIntegrityError(
      "backup failed to decrypt/authenticate (wrong or revoked key, or corrupt/truncated bundle)",
      e,
    );
  }
  const recomputed = contentHashOf(plaintext);
  if (recomputed !== bundle.header.contentHash) {
    throw new BackupIntegrityError(
      `backup content hash mismatch: header ${bundle.header.contentHash} != recomputed ${recomputed}`,
    );
  }
  return plaintext;
}

export { aadOf };

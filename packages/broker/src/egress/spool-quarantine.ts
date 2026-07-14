/**
 * `SealedSpoolQuarantineSink` — the egress daemon's NARROW, CIPHERTEXT-ONLY
 * quarantine channel (D18 / §2 quarantine-AEAD custody).
 *
 * The concrete encrypted quarantine store is CLI-owned (`apps/cli/src/quarantine`);
 * the egress daemon (running as `atlas-egress`) has no vault/SQLite, MUST NOT import
 * the CLI, and — per the security contract §4 — MUST NOT hold the quarantine AEAD
 * key (that symmetric key is trusted-CLI-only, "parser/model-denied"). So when the
 * in-broker scan blocks a payload, the daemon SEALS the offending bytes AND their
 * finding metadata to the CLI's quarantine PUBLIC key (an X25519 sealed box:
 * ephemeral-ECDH → HKDF → AES-256-GCM) and writes ONLY that ciphertext envelope to a
 * spool directory. The public key is non-secret, so the daemon holding it violates
 * no custody rule; only the CLI (holding the matching private key) can open the
 * envelope, and it drains the spool into its sealed AEAD store.
 *
 * This replaces the earlier PLAINTEXT/base64 spool (which wrote the detected secret
 * and finding metadata in the clear, breaking the Phase-2 ciphertext-only quarantine
 * invariant — the finding). Nothing sensitive is ever at rest in plaintext here.
 *
 * Each item is written atomically (temp-then-rename, `0600`) as a JSON envelope. The
 * spool dir is created `0700`. Sealing/retention/reveal are the CLI store's job; the
 * spool is a transient one-way hand-off, not the system of record.
 */
import { chmodSync, mkdirSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  createCipheriv,
  createDecipheriv,
  createPublicKey,
  createPrivateKey,
  diffieHellman,
  generateKeyPairSync,
  hkdfSync,
  randomBytes,
  type KeyObject,
} from "node:crypto";
import type { QuarantineSink, SecretFinding } from "@atlas/scan";

/** Sealed-envelope format identity. */
export const SPOOL_MAGIC = "ATLAS-EGRESS-SPOOL";
export const SPOOL_VERSION = 1;
const CIPHER = "aes-256-gcm";
const NONCE_BYTES = 12;
const HKDF_INFO = Buffer.from(`${SPOOL_MAGIC}/v${SPOOL_VERSION}`, "utf8");

/** The non-secret finding metadata sealed INSIDE the ciphertext (never plaintext at rest). */
interface SealedFinding {
  readonly ruleId: string;
  readonly title: string;
  readonly severity: string;
  readonly startOffset: number;
  readonly endOffset: number;
}

/** The plaintext inner document sealed as one unit (bytes + metadata) — never on disk. */
interface SpoolInner {
  readonly origin: string;
  readonly findings: readonly SealedFinding[];
  /** base64 of the exact quarantined bytes. */
  readonly bytesB64: string;
  readonly spooledAt: string;
}

/** The on-disk CIPHERTEXT envelope the CLI drains. Carries NO plaintext secret/metadata. */
export interface SealedSpoolEnvelope {
  readonly magic: string;
  readonly version: number;
  readonly alg: "x25519-ecdh+aes-256-gcm";
  /** The ephemeral X25519 public key (SPKI der, base64) for ECDH — non-secret. */
  readonly ephemeralPublicKey: string;
  readonly nonce: string;
  readonly authTag: string;
  readonly ciphertext: string;
}

function toPublicKey(key: KeyObject | Buffer | string): KeyObject {
  if (typeof key !== "string" && !Buffer.isBuffer(key)) return key;
  const der = typeof key === "string" ? Buffer.from(key, "base64") : key;
  return createPublicKey({ key: der, format: "der", type: "spki" });
}

function toPrivateKey(key: KeyObject | Buffer | string): KeyObject {
  if (typeof key !== "string" && !Buffer.isBuffer(key)) return key;
  const der = typeof key === "string" ? Buffer.from(key, "base64") : key;
  return createPrivateKey({ key: der, format: "der", type: "pkcs8" });
}

/** Derive the AES-256-GCM key from an ECDH shared secret + the ephemeral public bytes. */
function deriveKey(shared: Buffer, ephemeralPubDer: Buffer): Buffer {
  return Buffer.from(hkdfSync("sha256", shared, ephemeralPubDer, HKDF_INFO, 32));
}

/**
 * Seal `inner` to `recipientPublicKey` (X25519 sealed box). Returns a ciphertext-only
 * envelope; the plaintext (bytes + metadata) is recoverable ONLY with the matching
 * private key. Exported for the CLI drain's round-trip tests.
 */
export function sealSpoolEnvelope(recipientPublicKey: KeyObject | Buffer | string, inner: SpoolInner): SealedSpoolEnvelope {
  const recipient = toPublicKey(recipientPublicKey);
  const ephemeral = generateKeyPairSync("x25519");
  const ephemeralPubDer = ephemeral.publicKey.export({ type: "spki", format: "der" });
  const shared = diffieHellman({ privateKey: ephemeral.privateKey, publicKey: recipient });
  const key = deriveKey(shared, ephemeralPubDer);
  const nonce = randomBytes(NONCE_BYTES);
  const cipher = createCipheriv(CIPHER, key, nonce);
  const plaintext = Buffer.from(JSON.stringify(inner), "utf8");
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  return {
    magic: SPOOL_MAGIC,
    version: SPOOL_VERSION,
    alg: "x25519-ecdh+aes-256-gcm",
    ephemeralPublicKey: ephemeralPubDer.toString("base64"),
    nonce: nonce.toString("base64"),
    authTag: cipher.getAuthTag().toString("base64"),
    ciphertext: ciphertext.toString("base64"),
  };
}

/** The opened spool item: the quarantined bytes + their (non-secret) finding metadata + origin. */
export interface OpenedSpoolItem {
  readonly origin: string;
  readonly findings: readonly SealedFinding[];
  readonly bytes: Uint8Array;
  readonly spooledAt: string;
}

/**
 * Open a sealed spool envelope with the CLI's quarantine PRIVATE key (the drain side,
 * CLI-only). Validates magic/version/alg and the AEAD tag; a tampered/corrupt/wrong-key
 * envelope throws.
 */
export function openSpoolEnvelope(recipientPrivateKey: KeyObject | Buffer | string, env: SealedSpoolEnvelope): OpenedSpoolItem {
  if (env.magic !== SPOOL_MAGIC || env.version !== SPOOL_VERSION || env.alg !== "x25519-ecdh+aes-256-gcm") {
    throw new Error("egress spool envelope has an unexpected magic/version/alg");
  }
  const priv = toPrivateKey(recipientPrivateKey);
  const ephemeralPubDer = Buffer.from(env.ephemeralPublicKey, "base64");
  const ephemeralPub = createPublicKey({ key: ephemeralPubDer, format: "der", type: "spki" });
  const shared = diffieHellman({ privateKey: priv, publicKey: ephemeralPub });
  const key = deriveKey(shared, ephemeralPubDer);
  const decipher = createDecipheriv(CIPHER, key, Buffer.from(env.nonce, "base64"));
  decipher.setAuthTag(Buffer.from(env.authTag, "base64"));
  const plaintext = Buffer.concat([decipher.update(Buffer.from(env.ciphertext, "base64")), decipher.final()]);
  const inner = JSON.parse(plaintext.toString("utf8")) as SpoolInner;
  return {
    origin: inner.origin,
    findings: inner.findings,
    bytes: new Uint8Array(Buffer.from(inner.bytesB64, "base64")),
    spooledAt: inner.spooledAt,
  };
}

export interface SealedSpoolQuarantineOptions {
  /** The spool directory (created `0700`; written by `atlas-egress`, drained by the CLI). */
  readonly dir: string;
  /**
   * The CLI's quarantine PUBLIC key (X25519, SPKI-der `KeyObject`/Buffer/base64) — the
   * only key the daemon holds. NON-SECRET; the matching private key is trusted-CLI-only.
   */
  readonly recipientPublicKey: KeyObject | Buffer | string;
  /** Injectable wall-clock (tests). */
  readonly clock?: () => Date;
}

/** A filesystem-backed, ciphertext-only quarantine channel for the egress daemon. */
export class SealedSpoolQuarantineSink implements QuarantineSink {
  private readonly dir: string;
  private readonly recipientPublicKey: KeyObject;
  private readonly clock: () => Date;
  private ensured = false;

  constructor(opts: SealedSpoolQuarantineOptions) {
    this.dir = opts.dir;
    this.recipientPublicKey = toPublicKey(opts.recipientPublicKey);
    this.clock = opts.clock ?? (() => new Date());
  }

  async quarantine(input: {
    readonly bytes: Uint8Array;
    readonly origin: string;
    readonly findings: readonly SecretFinding[];
  }): Promise<void> {
    await Promise.resolve();
    this.ensureDir();
    const inner: SpoolInner = {
      origin: input.origin,
      findings: input.findings.map((f) => ({
        ruleId: f.ruleId,
        title: f.title,
        severity: f.severity,
        startOffset: f.startOffset,
        endOffset: f.endOffset,
      })),
      bytesB64: Buffer.from(input.bytes).toString("base64"),
      spooledAt: this.clock().toISOString(),
    };
    const envelope = sealSpoolEnvelope(this.recipientPublicKey, inner);
    const id = randomBytes(16).toString("hex");
    const finalPath = join(this.dir, `q-${id}.spool.json`);
    const tempPath = join(this.dir, `.qtmp-${id}`);
    writeFileSync(tempPath, JSON.stringify(envelope), { mode: 0o600 });
    renameSync(tempPath, finalPath);
  }

  private ensureDir(): void {
    if (this.ensured) return;
    mkdirSync(this.dir, { recursive: true, mode: 0o700 });
    try {
      chmodSync(this.dir, 0o700);
    } catch {
      // Best-effort mode tightening; the dir exists either way.
    }
    this.ensured = true;
  }
}

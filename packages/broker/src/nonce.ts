/**
 * Authorization nonce / replay store (security/broker contract §9.1).
 *
 * The broker issues a 128-bit random nonce per challenge and records
 * `{ nonce, op, issuedAt, expiresAt, consumedAt? }`. It is the SOLE
 * replay-protection authority: single-use, TTL-bounded, and NEVER vault- or
 * agent-readable (broker primary state, in-process). Persistence to disk is
 * intentionally out of scope for Phase 1 — the store is reconciled on startup
 * per the recovery contract; here it is an in-memory map (fail-closed: an
 * unknown nonce after a restart is rejected as `nonce_unknown`, never accepted).
 */
import { randomBytes } from "node:crypto";

/** Default nonce TTL — 5 minutes (§9.1). */
export const DEFAULT_NONCE_TTL_SECONDS = 300;

interface NonceRecord {
  readonly nonce: string;
  readonly op: string;
  readonly issuedAt: number;
  readonly expiresAt: number;
  consumedAt: number | null;
}

/**
 * The outcome of validating/consuming a nonce for an op. `op_mismatch` means the
 * nonce exists but was issued for a DIFFERENT op than the challenge now claims
 * (cross-operation reuse) — the stored op binding (§9.1) is enforced.
 */
export type NonceConsumeResult =
  | { ok: true }
  | { ok: false; reason: "unknown" | "expired" | "replayed" | "op_mismatch" };

export class NonceStore {
  private readonly records = new Map<string, NonceRecord>();

  constructor(private readonly now: () => number = () => Date.now()) {}

  /** Mint a fresh 128-bit hex nonce bound to `op`, expiring after `ttlSeconds`. */
  issue(op: string, ttlSeconds: number = DEFAULT_NONCE_TTL_SECONDS): { nonce: string; issuedAt: number; expiresAt: number } {
    const nonce = randomBytes(16).toString("hex");
    const issuedAt = this.now();
    const expiresAt = issuedAt + ttlSeconds * 1000;
    this.records.set(nonce, { nonce, op, issuedAt, expiresAt, consumedAt: null });
    return { nonce, issuedAt, expiresAt };
  }

  /** Look up a nonce record (read-only). */
  peek(nonce: string): NonceRecord | undefined {
    return this.records.get(nonce);
  }

  /**
   * Validate `nonce` for `op` WITHOUT consuming it. Order: unknown → op-mismatch
   * → expired → replayed. Separating validation from consumption is load-bearing:
   * an invalid request (bad signer/signature) must NOT burn a legitimate
   * challenge, so the caller validates first, verifies signer + signature + drift,
   * and only then calls {@link consume} (fixes the "burn-on-invalid" finding).
   */
  validate(nonce: string, op: string): NonceConsumeResult {
    const rec = this.records.get(nonce);
    if (rec === undefined) return { ok: false, reason: "unknown" };
    if (rec.op !== op) return { ok: false, reason: "op_mismatch" };
    const t = this.now();
    if (t > rec.expiresAt) return { ok: false, reason: "expired" };
    if (rec.consumedAt !== null) return { ok: false, reason: "replayed" };
    return { ok: true };
  }

  /**
   * Atomically consume `nonce` (single-use, §9.1). Re-checks unknown → expired →
   * replayed so a consume can never resurrect an expired/spent nonce. Node's
   * single-threaded event loop makes the validate→verify→consume window free of
   * interleaving as long as the caller does not `await` mid-sequence.
   */
  consume(nonce: string): NonceConsumeResult {
    const rec = this.records.get(nonce);
    if (rec === undefined) return { ok: false, reason: "unknown" };
    const t = this.now();
    if (t > rec.expiresAt) return { ok: false, reason: "expired" };
    if (rec.consumedAt !== null) return { ok: false, reason: "replayed" };
    rec.consumedAt = t;
    return { ok: true };
  }
}

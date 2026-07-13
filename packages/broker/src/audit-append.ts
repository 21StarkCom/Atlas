/**
 * Audit-ref append (security/broker contract §5, §6).
 *
 * Appends a signed audit event to `refs/audit/runs` as a commit whose message is
 * the on-wire Ed25519 envelope (§8.1). Enforced invariants:
 *   - **signed events only** — the signature must verify against the signer
 *     registry public key for `signerId`, else `broker.audit_signature_invalid`;
 *   - **gapless seq** — `seq` must be exactly the previous seq + 1, else
 *     `broker.audit_seq_nonmonotonic`;
 *   - **chained heads** — `prevAuditHead` must equal the current audit head, else
 *     `broker.audit_prev_head_mismatch`;
 *   - **content-checked idempotency on (runId, seq)** — a re-submit of an
 *     already-appended (runId, seq) with byte-identical content returns the prior
 *     `{ seq, head }`; a same-key collision with *different* content is refused
 *     (`broker.audit_idempotency_conflict`);
 *   - **full-chain startup re-verification** — every historical envelope's
 *     canonicalization, signer, signature, seq continuity, and prevAuditHead are
 *     re-checked (`broker.audit_chain_invalid` on any break);
 *   - **WORM anchor on every append** — the new head + event count are anchored
 *     (§6), and the pre-append live count + head are checked against the anchor to
 *     catch truncation OR same-length suffix rewrite (fail-closed).
 *
 * NEVER imports `@atlas/sqlite-store` (acyclic ledger→broker seam, §2.8).
 */
import { type KeyObject } from "node:crypto";
import {
  AuditEventSchema,
  canonicalSerialize,
  type AuditEvent,
  type SignedAuditEvent,
  type SignedEnvelope,
} from "@atlas/contracts";
import { verifyBytes, verifyRaw } from "./crypto.js";
import { BrokerRefusal } from "./errors.js";
import { BrokerGit, ZERO_OID } from "./git.js";
import { WormAnchor } from "./anchor.js";

/** The result of an audit append: the event's seq + the new audit-ref head. */
export interface AppendResult {
  readonly seq: number;
  readonly head: string;
}

/**
 * Resolve a signerId to its registered public key, or `null` if unknown.
 * @deprecated The audit log now binds to the dedicated attestation identity
 * (round-3 finding 2) rather than resolving arbitrary registry signers.
 */
export type PublicKeyResolver = (signerId: string) => KeyObject | null;

/** The dedicated audit-attestation trust root the audit stream is signed by (§6). */
export interface AttestationTrustRoot {
  readonly signerId: string;
  readonly publicKey: KeyObject;
}

/** The canonicalization every audit envelope must declare (§8.2). */
const AUDIT_CANONICALIZATION = "atlas-jcs-v1";

/** An idempotency record: the prior result + a content fingerprint. */
interface IdemRecord {
  readonly result: AppendResult;
  readonly fingerprint: string;
}

function idemKey(runId: string, seq: number): string {
  return `${runId} ${seq}`;
}

/** Convert a raw signature to its `ed25519:` envelope string form (§8.1). */
function rawSigToString(sig: Uint8Array): string {
  return "ed25519:" + Buffer.from(sig).toString("base64url");
}

/**
 * A stable fingerprint over the content that (runId, seq) commits to: the signer,
 * the exact signature string, and the canonical payload bytes. Two submissions of
 * the same idempotency key with ANY differing content produce different
 * fingerprints, so a collision-with-different-content is rejected rather than
 * silently returning the prior result.
 */
function fingerprintOf(signerId: string, sigString: string, event: AuditEvent): string {
  return `${signerId} ${sigString} ${Buffer.from(canonicalSerialize(event)).toString("base64")}`;
}

export class AuditLog {
  private lastSeq = -1;
  private readonly byRunSeq = new Map<string, IdemRecord>();
  private initialized = false;

  constructor(
    private readonly git: BrokerGit,
    private readonly auditRef: string,
    private readonly anchor: WormAnchor,
    private readonly attestation: AttestationTrustRoot,
  ) {}

  /**
   * Resolve `signerId` to a trusted audit-signing key. ONLY the dedicated
   * audit-attestation identity may sign the audit stream (round-3 finding 2) —
   * an approval signer (or any other registry signer) is NOT accepted here, so a
   * compromised or over-broad approval key can never forge audit history.
   * Returns `null` for any signerId other than the attestation identity.
   */
  private trustedKeyFor(signerId: string): KeyObject | null {
    return signerId === this.attestation.signerId ? this.attestation.publicKey : null;
  }

  /**
   * Reconcile in-memory state from the existing chain (broker primary state,
   * recovery contract) AND fully re-verify it: every envelope's canonicalization,
   * signer eligibility, and signature; exact sequence continuity; and the
   * `prevAuditHead` back-link to the prior commit. A break is fail-closed
   * (`broker.audit_chain_invalid`). Then run the anti-truncation/rewrite check
   * against the WORM anchor (both count AND head).
   */
  async init(): Promise<void> {
    if (this.initialized) return;
    const commits = (await this.git.revList(this.auditRef)).reverse(); // oldest → newest
    let prevCommit: string | null = null;
    let expectedSeq: number | null = null;
    for (const commit of commits) {
      const msg = await this.git.commitMessage(commit);
      let env: SignedEnvelope;
      try {
        env = JSON.parse(msg) as SignedEnvelope;
      } catch {
        throw new BrokerRefusal("broker.audit_chain_invalid", `audit commit ${commit}: message is not a JSON envelope`);
      }
      if (env.canonicalization !== AUDIT_CANONICALIZATION) {
        throw new BrokerRefusal(
          "broker.audit_chain_invalid",
          `audit commit ${commit}: unsupported canonicalization "${env.canonicalization}"`,
        );
      }
      const parsed = AuditEventSchema.safeParse(env.payload);
      if (!parsed.success) {
        throw new BrokerRefusal("broker.audit_chain_invalid", `audit commit ${commit}: ${parsed.error.message}`);
      }
      const event = parsed.data;

      // Signer eligibility + signature: ONLY the attestation identity is trusted
      // to have signed the audit stream (round-3 finding 2). Any other signer —
      // even a valid approval signer — breaks the chain fail-closed.
      const pub = this.trustedKeyFor(env.signerId);
      if (pub === null) {
        throw new BrokerRefusal(
          "broker.audit_chain_invalid",
          `audit commit ${commit}: signer "${env.signerId}" is not the audit-attestation identity`,
        );
      }
      if (!verifyBytes(canonicalSerialize(event), env.signature, pub)) {
        throw new BrokerRefusal("broker.audit_chain_invalid", `audit commit ${commit}: signature verification failed`);
      }

      // Exact sequence continuity: the first event sets the baseline; each
      // subsequent event must be exactly its predecessor + 1 (no gaps).
      if (expectedSeq !== null && event.seq !== expectedSeq) {
        throw new BrokerRefusal(
          "broker.audit_chain_invalid",
          `audit commit ${commit}: seq ${event.seq} breaks continuity (expected ${expectedSeq})`,
        );
      }

      // prevAuditHead back-link: ZERO for the first event, else the prior commit.
      const expectedPrev = prevCommit ?? ZERO_OID;
      if (event.prevAuditHead !== expectedPrev) {
        throw new BrokerRefusal(
          "broker.audit_chain_invalid",
          `audit commit ${commit}: prevAuditHead ${event.prevAuditHead} ≠ ${expectedPrev}`,
        );
      }

      this.byRunSeq.set(idemKey(event.runId, event.seq), {
        result: { seq: event.seq, head: commit },
        fingerprint: fingerprintOf(env.signerId, env.signature, event),
      });
      this.lastSeq = event.seq;
      prevCommit = commit;
      expectedSeq = event.seq + 1;
    }
    // Anti-rewrite/anti-truncation (§6): the anchored head must still sit at its
    // exact anchored position in the live chain — passing the full oldest→newest
    // list lets the anchor prove ancestry even when the live chain is LONGER than
    // the anchor (a rewrite-then-append can no longer evade detection).
    this.anchor.verifyChain(commits);
    this.initialized = true;
  }

  /** The highest seq appended so far (−1 if the chain is empty). */
  get highestSeq(): number {
    return this.lastSeq;
  }

  /**
   * Append a signed audit event. Idempotent on (runId, seq) ONLY when the resub
   * carries byte-identical content; a same-key collision with different content is
   * refused. Requires the exact next sequence and a `prevAuditHead` matching the
   * current audit head — no gaps, no forks.
   */
  async append(signed: SignedAuditEvent): Promise<AppendResult> {
    await this.init();

    const parsed = AuditEventSchema.safeParse(signed.event);
    if (!parsed.success) {
      throw new BrokerRefusal("broker.bad_request", `invalid audit event: ${parsed.error.message}`);
    }
    const event: AuditEvent = parsed.data;
    const sigString = rawSigToString(signed.signature);
    const fingerprint = fingerprintOf(signed.signerId, sigString, event);

    // Idempotency FIRST: a completed (runId, seq) replays to the same result only
    // when the content is byte-identical; otherwise it is a conflicting reuse.
    const existing = this.byRunSeq.get(idemKey(event.runId, event.seq));
    if (existing !== undefined) {
      if (existing.fingerprint !== fingerprint) {
        throw new BrokerRefusal(
          "broker.audit_idempotency_conflict",
          `(runId ${event.runId}, seq ${event.seq}) already appended with different content`,
        );
      }
      return existing.result;
    }

    // Signed events only, AND only by the dedicated audit-attestation identity
    // (round-3 finding 2): an approval signer must never be able to append audit
    // history. A non-attestation signerId is refused before any signature check.
    if (signed.signerId !== this.attestation.signerId) {
      throw new BrokerRefusal(
        "broker.audit_signer_untrusted",
        `audit signer "${signed.signerId}" is not the audit-attestation identity "${this.attestation.signerId}"`,
      );
    }
    const pub = this.trustedKeyFor(signed.signerId);
    if (pub === null) {
      throw new BrokerRefusal("broker.audit_signer_unknown", `unknown audit signer "${signed.signerId}"`);
    }
    if (!verifyRaw(canonicalSerialize(event), signed.signature, pub)) {
      throw new BrokerRefusal("broker.audit_signature_invalid", "audit event signature verification failed");
    }

    // Exact next sequence (gapless): the first append sets the baseline, each
    // subsequent one must be exactly last + 1. A gap or regression is refused.
    if (this.lastSeq !== -1 && event.seq !== this.lastSeq + 1) {
      throw new BrokerRefusal(
        "broker.audit_seq_nonmonotonic",
        `audit seq ${event.seq} is not the next sequence after ${this.lastSeq}`,
      );
    }

    // prevAuditHead must chain onto the current audit head (ZERO for the first).
    const prevHead = await this.git.readRef(this.auditRef);
    const expectedPrev = prevHead ?? ZERO_OID;
    if (event.prevAuditHead !== expectedPrev) {
      throw new BrokerRefusal(
        "broker.audit_prev_head_mismatch",
        `prevAuditHead ${event.prevAuditHead} ≠ current audit head ${expectedPrev}`,
      );
    }

    // Write the chained commit. The message is the on-wire signed envelope.
    const envelope: SignedEnvelope = {
      payload: event as unknown as Record<string, unknown>,
      signature: sigString,
      signerId: signed.signerId,
      canonicalization: AUDIT_CANONICALIZATION,
    };
    const tree = await this.git.emptyTree();
    const commit = await this.git.commitTree(tree, prevHead, JSON.stringify(envelope));

    try {
      await this.git.updateRefCas(this.auditRef, commit, prevHead ?? ZERO_OID);
    } catch {
      throw new BrokerRefusal("broker.cas_failed", `audit ref advanced concurrently; refusing append`);
    }

    const eventCount = await this.git.countCommits(this.auditRef);
    this.anchor.append(commit, eventCount);

    const result: AppendResult = { seq: event.seq, head: commit };
    this.byRunSeq.set(idemKey(event.runId, event.seq), { result, fingerprint });
    this.lastSeq = event.seq;
    return result;
  }
}

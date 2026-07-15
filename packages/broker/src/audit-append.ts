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
import { signRaw, verifyBytes, verifyRaw } from "./crypto.js";
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

/**
 * The audit-event kinds that ASSERT a canonical ref move ("the canonical ref now
 * points at this commit"). Such an assertion is only truthful when the broker
 * itself performed the move, so these kinds may be produced ONLY by the
 * protected-ref path (which binds the event to the observed move) — never by the
 * broker's generic signing entry point. `refs.ts` imports this set to enforce the
 * same boundary from the other direction (a canonical install must carry one of
 * these kinds), so the enumeration lives in exactly one place.
 */
export const CANONICAL_INSTALLING_KINDS: ReadonlySet<string> = new Set([
  "run.integrated",
  "run.rolled_back",
]);

/** An idempotency record: the prior result + a content fingerprint. */
interface IdemRecord {
  readonly result: AppendResult;
  readonly fingerprint: string;
  /**
   * A fingerprint over ONLY the caller-authored content — every audit-event
   * field EXCEPT `prevAuditHead` (the broker fills that from the live head) and
   * the signature. This is what the F4 internal-signing entry point compares a
   * re-submitted `(runId, seq)` against: a crash-recovery re-drive is byte-stable
   * on this key (same content, only the head/signature shift), whereas a genuinely
   * DIFFERENT event reusing the same key is caught (`audit_idempotency_conflict`).
   */
  readonly contentKey: string;
}

function idemKey(runId: string, seq: number): string {
  return `${runId} ${seq}`;
}

/**
 * The content fingerprint an `(runId, seq)` commits to, EXCLUDING `prevAuditHead`
 * (broker-filled) so a recovery re-drive — which re-derives `prevAuditHead` from a
 * since-advanced head — still matches, while any other field differing is a
 * conflict. Independent of JSON key order via {@link canonicalSerialize}.
 */
function contentKeyOf(event: Omit<AuditEvent, "prevAuditHead"> | AuditEvent): string {
  const rest = { ...(event as Record<string, unknown>) };
  delete rest.prevAuditHead;
  return Buffer.from(canonicalSerialize(rest as unknown as AuditEvent)).toString("base64");
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
      const { event, env } = await this.verifyCommit(commit, prevCommit, expectedSeq);
      this.byRunSeq.set(idemKey(event.runId, event.seq), {
        result: { seq: event.seq, head: commit },
        fingerprint: fingerprintOf(env.signerId, env.signature, event),
        contentKey: contentKeyOf(event),
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

  /**
   * Fully verify ONE audit commit against its expected position: JSON envelope,
   * canonicalization, schema, attestation-only signer + signature, exact seq
   * continuity, and the `prevAuditHead` back-link. Throws a fail-closed
   * `broker.audit_chain_invalid` on any break. Shared by {@link init} and the
   * read-only {@link verifyLiveChain} so both apply IDENTICAL chain semantics.
   */
  private async verifyCommit(
    commit: string,
    prevCommit: string | null,
    expectedSeq: number | null,
  ): Promise<{ event: AuditEvent; env: SignedEnvelope }> {
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
    return { event, env };
  }

  /**
   * A READ-ONLY health verdict over the LIVE `refs/audit/runs` chain (Task 1.9
   * finding 1). Re-reads the ref from git on EVERY call (no cached trust) and
   * re-verifies the full chain + the WORM anchor exactly as {@link init} does,
   * but REPORTS a break as `{ ok:false, detail }` instead of throwing — so a
   * health surface (`doctor`/`status`) can name the fault without crashing. This
   * is the authoritative anti-truncation/anti-rewrite check: it binds to the
   * actual protected-ref commits (and the broker-owned anchor), NOT to any
   * unprivileged SQLite projection.
   */
  async verifyLiveChain(): Promise<{ ok: boolean; head: string; count: number; detail?: string }> {
    let commits: string[];
    try {
      commits = (await this.git.revList(this.auditRef)).reverse(); // oldest → newest
    } catch (e) {
      return { ok: false, head: "", count: 0, detail: `audit ref unreadable: ${e instanceof Error ? e.message : String(e)}` };
    }
    const head = commits.length > 0 ? commits[commits.length - 1]! : "";
    let prevCommit: string | null = null;
    let expectedSeq: number | null = null;
    try {
      for (const commit of commits) {
        const { event } = await this.verifyCommit(commit, prevCommit, expectedSeq);
        prevCommit = commit;
        expectedSeq = event.seq + 1;
      }
      // A missing/empty WORM anchor is HEALTHY only when there are no live events
      // to anchor. If the audit ref carries events but no anchor covers them, the
      // anchor was deleted/truncated away — exactly the anti-truncation evasion the
      // anchor exists to catch — so the health probe must report it (`verifyChain`
      // itself treats a null anchor as a no-op, which is correct for first-boot
      // bootstrapping in `init` but NOT for a health verdict over a live chain).
      if (commits.length > 0 && this.anchor.latest() === null) {
        return {
          ok: false,
          head,
          count: commits.length,
          detail: `WORM anchor is missing/empty while ${commits.length} audit event(s) exist — anchor truncation`,
        };
      }
      // Bind the anchored head to its exact position in the live chain (§6).
      this.anchor.verifyChain(commits);
    } catch (e) {
      const detail = e instanceof BrokerRefusal ? e.message : e instanceof Error ? e.message : String(e);
      return { ok: false, head, count: commits.length, detail };
    }
    return { ok: true, head, count: commits.length };
  }

  /** The highest seq appended so far (−1 if the chain is empty). */
  get highestSeq(): number {
    return this.lastSeq;
  }

  /**
   * The already-anchored result for `(runId, seq)`, or `undefined` if that key
   * has never been appended. Used by the F4 internal-signing entry point to make
   * a §2.8 crash-recovery re-drive idempotent WITHOUT reproducing the original
   * `prevAuditHead` bytes: once an event is on the chain, replaying its
   * `(runId, seq)` returns the anchored `{seq, head}` before any re-sign, so the
   * reconciler never trips the fingerprint conflict that a shifted `prevAuditHead`
   * would otherwise cause.
   */
  existingResult(runId: string, seq: number): AppendResult | undefined {
    return this.byRunSeq.get(idemKey(runId, seq))?.result;
  }

  /**
   * F4 — the BROKER-OWNED signing entry point. The caller submits a VALIDATED,
   * UNSIGNED audit event WITHOUT `prevAuditHead`; the broker fills the current
   * head, signs the canonical bytes with the dedicated audit-attestation key
   * (the sole identity permitted to sign the audit stream), and appends. This
   * keeps the attestation private key broker-only — `finalizeLedgerWrite` never
   * pre-signs client-side (#22 carry-forward F4).
   *
   * Idempotent on `(runId, seq)`: an already-anchored key returns its prior
   * `{seq, head}` untouched (see {@link existingResult}).
   */
  async signAndAppend(
    unsigned: Omit<AuditEvent, "prevAuditHead">,
    privateKey: KeyObject,
  ): Promise<AppendResult> {
    await this.init();

    // Fast idempotency: an already-anchored (runId, seq) replays its result
    // without re-signing (the live head has since advanced, so a fresh sign
    // would embed a different prevAuditHead — the anchored result is authoritative).
    // But ONLY when the re-submitted content matches what was anchored: a crash
    // re-drive is byte-stable on the content key (prevAuditHead excluded), whereas
    // a DIFFERENT event reusing the same (runId, seq) must be refused — otherwise
    // it would receive the prior head and be committed locally against content that
    // was never anchored (round-2 finding).
    const prior = this.byRunSeq.get(idemKey(unsigned.runId, unsigned.seq));
    if (prior !== undefined) {
      if (prior.contentKey !== contentKeyOf(unsigned)) {
        throw new BrokerRefusal(
          "broker.audit_idempotency_conflict",
          `(runId ${unsigned.runId}, seq ${unsigned.seq}) already anchored with different content`,
        );
      }
      return prior.result;
    }

    // PURPOSE-BOUND signing gate #1 — KIND (fixes the signing-oracle finding).
    //
    // This entry point signs an event whose CONTENT (kind, subjects,
    // canonicalCommit, detail) is supplied by the caller — and the broker socket is
    // reachable by the agent identity (the run dir is `2770` setgid `atlas-git`).
    // Without this gate, any socket peer could obtain a broker attestation for a
    // FABRICATED `run.integrated` naming a canonicalCommit that was never installed,
    // which would defeat the entire point of the audit stream.
    //
    // A CANONICAL-INSTALLING event (`run.integrated` / `run.rolled_back`) asserts
    // "the canonical ref now points at this commit". That assertion is only
    // truthful if the broker ITSELF performed the move, so it may ONLY be produced
    // by the protected-ref path (`advanceProtectedRef` / `integrateSourceCapture`),
    // which binds the event to broker-OBSERVED state (runId + the exact commit being
    // installed + an installing kind) before it is ever appended. Signing such an
    // event here — where no ref move is observed — is therefore refused outright.
    //
    // The ledger orchestrator (`finalizeLedgerWrite`) legitimately needs only the
    // NON-installing kinds (`run.started`/`planned`/`rejected`/`failed`/`cancelled`/
    // `readonly`/`projection`), which assert nothing about the canonical ref.
    if (CANONICAL_INSTALLING_KINDS.has(unsigned.kind)) {
      throw new BrokerRefusal(
        "broker.audit_kind_not_signable",
        `refusing to sign a canonical-installing event ("${unsigned.kind}"): it asserts a canonical ref move, ` +
          `so it may only be produced by the protected-ref path that observes the move`,
      );
    }

    // PURPOSE-BOUND signing gate #2 — SEQ. The broker reconstructs the gapless
    // `seq` from its own observed state and refuses to sign anything other than the
    // exact next sequence, so a peer cannot obtain an attestation for an event at an
    // arbitrary position in the chain (far-ahead, backdated, or a hole): the only
    // signable new event is the immediate successor of the anchored head.
    // (`prevAuditHead` is broker-filled below; idempotent replays handled above.)
    const expectedSeq = this.lastSeq + 1;
    if (unsigned.seq !== expectedSeq) {
      throw new BrokerRefusal(
        "broker.audit_seq_nonmonotonic",
        `refusing to sign audit event: seq ${unsigned.seq} is not the next sequence ${expectedSeq}`,
      );
    }

    // Fill prevAuditHead from the live head, then validate the completed event.
    const prevHead = await this.git.readRef(this.auditRef);
    const candidate = { ...unsigned, prevAuditHead: prevHead ?? ZERO_OID };
    const parsed = AuditEventSchema.safeParse(candidate);
    if (!parsed.success) {
      throw new BrokerRefusal("broker.bad_request", `invalid audit event: ${parsed.error.message}`);
    }
    const event = parsed.data;
    const signature = signRaw(canonicalSerialize(event), privateKey);
    return this.append({ event, signature, signerId: this.attestation.signerId });
  }

  /**
   * BROKER-OWNED signing for a CANONICAL-INSTALLING event, WITHOUT appending.
   *
   * The protected-ref path (`integrateSourceCapture` / a canonical
   * `advanceProtectedRef`) is the ONLY place a `run.integrated`/`run.rolled_back`
   * event may originate (see {@link CANONICAL_INSTALLING_KINDS}), because only it
   * observes the ref move it asserts. That path re-verifies + appends the event
   * itself under CAS, so this helper only fills `prevAuditHead` from the live head
   * and signs with the broker-only attestation key — it deliberately does NOT run
   * the {@link signAndAppend} kind-gate (which forbids installing kinds outside a
   * ref move) and does NOT append. Callers MUST invoke it under the service
   * mutation lock so the `prevAuditHead` it reads is the same head the subsequent
   * `append` observes. Keeps the attestation private key broker-only (F4 / D-review
   * defect #2 — the unprivileged CLI never signs a canonical-installing event).
   */
  async signCanonicalInstalling(
    unsigned: Omit<AuditEvent, "prevAuditHead">,
    privateKey: KeyObject,
  ): Promise<SignedAuditEvent> {
    await this.init();
    if (!CANONICAL_INSTALLING_KINDS.has(unsigned.kind)) {
      // This entry point exists ONLY for the installing kinds; a non-installing
      // kind must go through `signAndAppend` (which appends), never here.
      throw new BrokerRefusal(
        "broker.bad_request",
        `signCanonicalInstalling refuses non-installing kind "${unsigned.kind}"`,
      );
    }
    const prevHead = await this.git.readRef(this.auditRef);
    const candidate = { ...unsigned, prevAuditHead: prevHead ?? ZERO_OID };
    const parsed = AuditEventSchema.safeParse(candidate);
    if (!parsed.success) {
      throw new BrokerRefusal("broker.bad_request", `invalid audit event: ${parsed.error.message}`);
    }
    const event = parsed.data;
    const signature = signRaw(canonicalSerialize(event), privateKey);
    return { event, signature, signerId: this.attestation.signerId };
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
    this.byRunSeq.set(idemKey(event.runId, event.seq), {
      result,
      fingerprint,
      contentKey: contentKeyOf(event),
    });
    this.lastSeq = event.seq;
    return result;
  }
}

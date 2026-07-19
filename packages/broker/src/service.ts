/**
 * `BrokerService` — the in-process broker authority.
 *
 * Wires the authorizer, audit log, WORM anchor, and protected-ref writer over a
 * single vault repo. The socket {@link server} and {@link BrokerClient} are thin
 * transports around this class; tests drive it directly. It holds NO ledger
 * state and imports no `@atlas/sqlite-store` (acyclic seam, §2.8).
 */
import { type KeyObject } from "node:crypto";
import {
  type AuditEvent,
  type AuthorizationChallenge,
  type AuthorizationResponse,
  type SignedAuditEvent,
  type SignerRegistryEntry,
} from "@atlas/contracts";
import { Authorizer, type PrivilegedOpDescriptor } from "./authorize.js";
import { AuditLog, type AppendResult } from "./audit-append.js";
import { WormAnchor } from "./anchor.js";
import { BrokerGit, ZERO_OID } from "./git.js";
import {
  ProtectedRefWriter,
  type ProtectedRefs,
  type RefAdvanceRequest,
  type RefAdvanceResult,
  type SourceCaptureRequest,
  type SignAndSourceCaptureRequest,
  type SignAndAdvanceRequest,
} from "./refs.js";

/** The audit-attestation keypair the broker uses to sign the WORM anchor (§4). */
export interface AttestationKey {
  readonly signerId: string;
  readonly privateKey: KeyObject;
  readonly publicKey: KeyObject;
}

/** Everything a `BrokerService` needs to run. */
export interface BrokerServiceConfig {
  /** The vault git repo the broker mutates. */
  readonly repoDir: string;
  /** The three protected refs (§3.1). */
  readonly refs: ProtectedRefs;
  /** WORM anchor file path (D8), outside the repo. */
  readonly anchorPath: string;
  /** Signer registry (§9.2) — approval-verify + audit-attestation entries. */
  readonly signers: readonly SignerRegistryEntry[];
  /** The broker's audit-attestation keypair (signs the WORM anchor). */
  readonly attestation: AttestationKey;
  /** D20: only `true` when `ATLAS_TEST_MODE=1` in the broker env. */
  readonly testMode: boolean;
  /** Injectable clock (tests). */
  readonly now?: () => number;
}

/** The result of `execAuthorized` — Phase 1 authorizes; effects land per phase. */
export interface PrivilegedOpResult {
  readonly code: "authz.ok";
  readonly authorized: true;
  readonly op: string;
}

export class BrokerService {
  readonly authorizer: Authorizer;
  private readonly git: BrokerGit;
  private readonly anchor: WormAnchor;
  private readonly audit: AuditLog;
  private readonly writer: ProtectedRefWriter;
  /** The audit-attestation private key — BROKER-ONLY (F4); never leaves this process. */
  private readonly attestationPrivateKey: KeyObject;
  /** The protected-ref names (canonical/audit/trust). */
  private readonly refs: ProtectedRefs;
  /**
   * The broker-observed canonical tip (round-3 finding 6). The broker is the SOLE
   * mutator of the protected refs, so a cache refreshed at `start()` and after every
   * canonical-moving mutation is authoritative broker state — it lets the SYNC
   * `mintChallenge`/`execAuthorized` bind privileged ledger authorizations to the
   * canonical tip the broker actually observes (not a value the calling CLI supplies)
   * and reject a stale challenge whose base no longer matches (`authz.canonical_moved`).
   */
  private canonicalTip: string | null = null;

  /** The privileged LEDGER ops whose authorization the broker binds to broker-observed canonical state. */
  private static readonly CANONICAL_BOUND_OPS: ReadonlySet<string> = new Set([
    "db restore",
    "db backup --force-unblock",
  ]);

  constructor(cfg: BrokerServiceConfig) {
    const now = cfg.now ?? (() => Date.now());
    this.attestationPrivateKey = cfg.attestation.privateKey;
    this.refs = cfg.refs;
    this.git = new BrokerGit(cfg.repoDir);
    this.authorizer = new Authorizer(cfg.signers, cfg.testMode, now);
    this.anchor = new WormAnchor(
      cfg.anchorPath,
      cfg.attestation.privateKey,
      cfg.attestation.publicKey,
      cfg.attestation.signerId,
      now,
    );
    // The audit stream is signed ONLY by the dedicated attestation identity
    // (round-3 finding 2) — the audit log is bound to that trust root, NOT the
    // general authorization registry.
    this.audit = new AuditLog(this.git, cfg.refs.audit, this.anchor, {
      signerId: cfg.attestation.signerId,
      publicKey: cfg.attestation.publicKey,
    });
    this.writer = new ProtectedRefWriter(this.git, cfg.refs, this.authorizer, this.audit);
  }

  /**
   * SERVICE-WIDE mutation lock. Every mutating operation (audit append,
   * protected-ref CAS, capture integration) runs through this single serial
   * queue, so two clients on different connections can NEVER interleave an audit
   * append with a protected-ref CAS. The broker is the one serial mutator of the
   * protected refs + audit stream, and this enforces that across ALL connections
   * — not merely per-connection (fixes the cross-connection race finding).
   */
  private mutationTail: Promise<unknown> = Promise.resolve();

  private runExclusive<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.mutationTail.then(fn, fn);
    // Keep the chain alive regardless of individual outcomes.
    this.mutationTail = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  /** Reconcile primary state + run the fail-closed anti-truncation check (§6). */
  async start(): Promise<void> {
    await this.runExclusive(async () => {
      await this.audit.init();
      this.canonicalTip = await this.git.readRef(this.refs.canonical);
    });
  }

  /** Refresh the broker-observed canonical tip after a mutation that may move it. */
  private async refreshCanonicalTip(): Promise<void> {
    this.canonicalTip = await this.git.readRef(this.refs.canonical);
  }

  /** Append a signed audit event (gapless seq, signed only, chained, anchored). */
  appendAuditEvent(e: SignedAuditEvent): Promise<AppendResult> {
    return this.runExclusive(() => this.audit.append(e));
  }

  /**
   * F4 — sign a VALIDATED UNSIGNED audit event with the broker-only attestation
   * key and append it. `finalizeLedgerWrite` (sqlite-store, §2.8 step 2) calls
   * this instead of pre-signing client-side, so the attestation private key never
   * leaves the broker and "only the attestation identity ever signs the audit
   * stream" holds. The event omits `prevAuditHead` (the broker fills the live
   * head under the mutation lock, then signs). Idempotent on `(runId, seq)`.
   */
  signAndAppendAuditEvent(unsigned: Omit<AuditEvent, "prevAuditHead">): Promise<AppendResult> {
    return this.runExclusive(() => this.audit.signAndAppend(unsigned, this.attestationPrivateKey));
  }

  /**
   * READ-ONLY audit-chain health verdict (Task 1.9 finding 1). Re-reads the live
   * `refs/audit/runs` chain from git + the WORM anchor and reports whether it is
   * intact, its head, and its event count — WITHOUT mutating anything. Runs under
   * the same mutation lock so it observes a consistent chain even while an append
   * is in flight. This is the authoritative interface the CLI health surfaces use
   * to verify the actual protected ref (not an unprivileged SQLite projection).
   */
  getAuditChainStatus(): Promise<{ ok: boolean; head: string; count: number; detail?: string }> {
    return this.runExclusive(() => this.audit.verifyLiveChain());
  }

  /** Advance a protected ref under CAS + ancestry (+ optional authorization). */
  advanceProtectedRef(r: RefAdvanceRequest): Promise<RefAdvanceResult> {
    return this.runExclusive(async () => {
      const res = await this.writer.advanceProtectedRef(r);
      await this.refreshCanonicalTip();
      return res;
    });
  }

  /** Integrate a Tier-1 source capture (sources/** + manifest only). */
  integrateSourceCapture(r: SourceCaptureRequest): Promise<RefAdvanceResult> {
    return this.runExclusive(async () => {
      const res = await this.writer.integrateSourceCapture(r);
      await this.refreshCanonicalTip();
      return res;
    });
  }

  /**
   * Sign a capture's `run.integrated` event with the broker-only attestation key
   * and integrate it (Tier-1 CAS) — the unprivileged-CLI capture path (D-review
   * defect #2). The CLI submits the VALIDATED UNSIGNED event; the broker fills
   * `prevAuditHead`, signs, and runs the same scope-checked fast-forward as
   * {@link integrateSourceCapture}, all under the single mutation lock so the
   * signed `prevAuditHead` is the head the append observes. The attestation
   * private key never leaves this process. Idempotent on `(runId, seq)` when the
   * capture already integrated (the audit append replays), and a genuine re-drive
   * whose canonical already advanced surfaces `broker.cas_failed` (the caller's
   * reconciler owns forward completion, never a re-integration).
   */
  signAndIntegrateSourceCapture(r: SignAndSourceCaptureRequest): Promise<RefAdvanceResult> {
    return this.runExclusive(async () => {
      const signed = await this.audit.signCanonicalInstalling(r.event, this.attestationPrivateKey);
      const res = await this.writer.integrateSourceCapture({
        captureCommit: r.captureCommit,
        expectedBase: r.expectedBase,
        manifest: r.manifest,
        auditEvent: signed,
        ...(r.scope !== undefined ? { scope: r.scope } : {}),
      });
      await this.refreshCanonicalTip();
      return res;
    });
  }

  /**
   * The GENERAL-SCOPE sign-and-advance for synthesis/approve/rollback (D-review defect #2): the
   * broker fills `prevAuditHead`, signs the canonical-installing event with the attestation key,
   * verifies the Tier-3 authorization (when present) + audit-event binding, and advances the
   * protected ref under CAS — all in one lock-held step. The CLI never holds the attestation key.
   */
  signAndAdvanceProtectedRef(r: SignAndAdvanceRequest): Promise<RefAdvanceResult> {
    return this.runExclusive(async () => {
      const signed = await this.audit.signCanonicalInstalling(r.event, this.attestationPrivateKey);
      const res = await this.writer.advanceProtectedRef({
        ref: r.ref,
        expectedOld: r.expectedOld,
        newCommit: r.newCommit,
        manifest: r.manifest,
        ...(r.authorization !== undefined ? { authorization: r.authorization } : {}),
        ...(r.authorizedOp !== undefined ? { authorizedOp: r.authorizedOp } : {}),
        auditEvent: signed,
      });
      await this.refreshCanonicalTip();
      return res;
    });
  }

  /**
   * Mint an authorization challenge for a privileged op. For the canonical-bound
   * LEDGER ops (round-3 finding 6) the broker OVERWRITES `canonicalBaseCommit` with
   * its own observed canonical tip, so the signed challenge commits to broker state
   * — a caller cannot pick the base the authorization is bound to.
   */
  mintChallenge(op: PrivilegedOpDescriptor): AuthorizationChallenge {
    const bound = BrokerService.CANONICAL_BOUND_OPS.has(op.op)
      ? { ...op, canonicalBaseCommit: this.canonicalTip ?? ZERO_OID }
      : op;
    return this.authorizer.mintChallenge(bound);
  }

  /**
   * Verify an authorization for `op` and (Phase 1) return the authorized verdict.
   * Concrete privileged effects (rollback/purge/restore/…) land in their own
   * phases; here the load-bearing behavior is the drift/signature/D20 gate.
   */
  execAuthorized(op: PrivilegedOpDescriptor, auth: AuthorizationResponse): PrivilegedOpResult {
    // For the canonical-bound LEDGER ops (round-3 finding 6) the broker RE-DERIVES
    // the canonical base from its own observed tip rather than trusting the value
    // the calling CLI supplies, and passes it as `currentCanonicalTip` so a stale
    // challenge (minted before the canonical tip moved) is refused
    // `authz.canonical_moved`. The CLI can no longer smuggle an all-zero base past
    // the drift gate — the broker independently binds to broker-observed state.
    const canonicalBound = BrokerService.CANONICAL_BOUND_OPS.has(op.op);
    const brokerBase = this.canonicalTip ?? ZERO_OID;
    // Bind the authorization to the CONCRETE operation the broker is asked to
    // perform: the challenge's op, run, target, base, and effect must all match
    // the re-derived descriptor. An authorization minted for operation A can
    // therefore never authorize a different operation B (drift is refused).
    this.authorizer.verify(auth, {
      ...(canonicalBound ? { currentCanonicalTip: brokerBase } : {}),
      expected: {
        op: op.op,
        ...(op.runId !== undefined ? { runId: op.runId } : {}),
        ...(op.targetCommit !== undefined ? { targetCommit: op.targetCommit } : {}),
        // Re-derived from broker state for canonical-bound ops; caller-supplied otherwise.
        canonicalBaseCommit: canonicalBound ? brokerBase : op.canonicalBaseCommit,
        intendedEffect: op.intendedEffect,
      },
    });
    return { code: "authz.ok", authorized: true, op: op.op };
  }
}

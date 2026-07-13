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
  type AuthorizationChallenge,
  type AuthorizationResponse,
  type SignedAuditEvent,
  type SignerRegistryEntry,
} from "@atlas/contracts";
import { Authorizer, type PrivilegedOpDescriptor } from "./authorize.js";
import { AuditLog, type AppendResult } from "./audit-append.js";
import { WormAnchor } from "./anchor.js";
import { BrokerGit } from "./git.js";
import {
  ProtectedRefWriter,
  type ProtectedRefs,
  type RefAdvanceRequest,
  type RefAdvanceResult,
  type SourceCaptureRequest,
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

  constructor(cfg: BrokerServiceConfig) {
    const now = cfg.now ?? (() => Date.now());
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
    await this.runExclusive(() => this.audit.init());
  }

  /** Append a signed audit event (gapless seq, signed only, chained, anchored). */
  appendAuditEvent(e: SignedAuditEvent): Promise<AppendResult> {
    return this.runExclusive(() => this.audit.append(e));
  }

  /** Advance a protected ref under CAS + ancestry (+ optional authorization). */
  advanceProtectedRef(r: RefAdvanceRequest): Promise<RefAdvanceResult> {
    return this.runExclusive(() => this.writer.advanceProtectedRef(r));
  }

  /** Integrate a Tier-1 source capture (sources/** + manifest only). */
  integrateSourceCapture(r: SourceCaptureRequest): Promise<RefAdvanceResult> {
    return this.runExclusive(() => this.writer.integrateSourceCapture(r));
  }

  /** Mint an authorization challenge for a privileged op. */
  mintChallenge(op: PrivilegedOpDescriptor): AuthorizationChallenge {
    return this.authorizer.mintChallenge(op);
  }

  /**
   * Verify an authorization for `op` and (Phase 1) return the authorized verdict.
   * Concrete privileged effects (rollback/purge/restore/…) land in their own
   * phases; here the load-bearing behavior is the drift/signature/D20 gate.
   */
  execAuthorized(op: PrivilegedOpDescriptor, auth: AuthorizationResponse): PrivilegedOpResult {
    // Bind the authorization to the CONCRETE operation the broker is asked to
    // perform: the challenge's op, run, target, base, and effect must all match
    // the re-derived descriptor. An authorization minted for operation A can
    // therefore never authorize a different operation B (drift is refused).
    this.authorizer.verify(auth, {
      expected: {
        op: op.op,
        ...(op.runId !== undefined ? { runId: op.runId } : {}),
        ...(op.targetCommit !== undefined ? { targetCommit: op.targetCommit } : {}),
        canonicalBaseCommit: op.canonicalBaseCommit,
        intendedEffect: op.intendedEffect,
      },
    });
    return { code: "authz.ok", authorized: true, op: op.op };
  }
}

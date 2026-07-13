/**
 * Protected-ref primitives (security/broker contract §3, §12; plan Task 1.6).
 *
 * The broker is the SOLE mutator of the protected refs (canonical branch,
 * `refs/audit/runs`, `refs/trust/ledger`). Every advance is a compare-and-swap
 * (CAS) with ancestry + signature + audit-event re-verification:
 *   - {@link advanceProtectedRef} — general CAS advance under an optional
 *     authorization (Tier-3 integrate/refresh/rollback/trust), fast-forward-only.
 *   - {@link integrateSourceCapture} — the narrowly scoped Tier-1 capture
 *     integration: the capture commit may touch ONLY `sources/**` + manifest
 *     paths, and canonical fast-forwards under CAS (fixes R1-F2).
 *
 * Carry-forward #12: only PROTECTED refs are broker-only; the git object store is
 * group-writable, so agents freely write blobs/trees/commits — this code never
 * fights that, it only gates the protected-ref pointer moves.
 */
import {
  type RunManifest,
  type SignedAuditEvent,
  type AuthorizationResponse,
  type IntendedEffect,
} from "@atlas/contracts";
import { BrokerRefusal } from "./errors.js";
import { BrokerGit, ZERO_OID } from "./git.js";
import { Authorizer, type ExpectedAuthorization } from "./authorize.js";
import { AuditLog, CANONICAL_INSTALLING_KINDS } from "./audit-append.js";

/**
 * The audit-event kinds that legitimately INSTALL a new canonical commit — the
 * only kinds allowed to accompany a canonical-ref advance / capture integration.
 * Binding the kind stops an unrelated event (e.g. `run.rejected`) from being
 * laundered onto a real canonical move (round-3 finding 2).
 */
// (imported from ./audit-append.js — single source of truth for this set)

/**
 * The op + effect a privileged ref mutation represents. The broker binds the
 * supplied authorization to THIS descriptor (round-3 finding 3): a challenge
 * minted for a different op or a different `intendedEffect` — even with the same
 * runId/targetCommit/base — is refused, so a permitted challenge for operation A
 * can never authorize a differently-shaped effect B on the same target.
 */
export interface AuthorizedOp {
  readonly op: string;
  readonly intendedEffect: IntendedEffect;
}

/** The broker-only-writable protected refs (§3.1). */
export interface ProtectedRefs {
  readonly canonical: string;
  readonly audit: string;
  readonly trust: string;
}

/** A request to advance a protected ref under CAS. */
export interface RefAdvanceRequest {
  readonly ref: string;
  readonly expectedOld: string;
  readonly newCommit: string;
  readonly manifest: RunManifest;
  readonly authorization?: AuthorizationResponse;
  /**
   * The op + intended effect this ref mutation represents. REQUIRED whenever
   * `authorization` is present, so the broker can bind the authorization to the
   * concrete operation/effect (round-3 finding 3).
   */
  readonly authorizedOp?: AuthorizedOp;
  readonly auditEvent: SignedAuditEvent;
}

/** A request to integrate a Tier-1 source capture. */
export interface SourceCaptureRequest {
  readonly captureCommit: string;
  readonly expectedBase: string;
  readonly manifest: RunManifest;
  readonly auditEvent: SignedAuditEvent;
}

/** The result of a successful protected-ref advance. */
export interface RefAdvanceResult {
  readonly ok: true;
  readonly ref: string;
  readonly newCommit: string;
  readonly seq: number;
  readonly auditHead: string;
}

/**
 * True iff `p` is an allowed source-capture path: anything under `sources/`, or a
 * capture manifest file (`manifest.json` / `manifest.yaml` / `manifest.yml`,
 * top-level or nested). ASSUMPTION (noted per the step's ambiguity rule): the
 * contract says "sources/** + manifest paths"; capture manifests live inside the
 * capture tree, so any path under `sources/` already covers manifests written
 * there, and a top-level `manifest.*` is additionally permitted.
 */
export function isCaptureAllowedPath(p: string): boolean {
  if (p.startsWith("sources/")) return true;
  return /(^|\/)manifest\.(json|ya?ml)$/.test(p);
}

/**
 * The protected-ref mutator. Holds the git handle, the protected-ref set, the
 * authorizer, and the audit log — but NEVER the ledger (acyclic seam).
 */
export class ProtectedRefWriter {
  constructor(
    private readonly git: BrokerGit,
    private readonly refs: ProtectedRefs,
    private readonly authorizer: Authorizer,
    private readonly audit: AuditLog,
  ) {}

  private isProtected(ref: string): boolean {
    return ref === this.refs.canonical || ref === this.refs.audit || ref === this.refs.trust;
  }

  /**
   * Re-derive and bind the security-relevant audit-event fields to the observed
   * operation (round-3 finding 2). Refuses (`broker.event_binding_mismatch`)
   * when the event does not belong to the manifest's run, does not commit to the
   * exact commit being installed, or (for a canonical install) is not a
   * canonical-installing kind. Runs BEFORE any append so a mismatch leaves the
   * audit ref + anchor untouched.
   */
  private bindAuditEventToOperation(
    signed: SignedAuditEvent,
    expected: { runId: string; canonicalCommit?: string | undefined; requireCanonicalKind: boolean },
  ): void {
    const ev = signed.event;
    if (ev.runId !== expected.runId) {
      throw new BrokerRefusal(
        "broker.event_binding_mismatch",
        `audit event runId ${ev.runId} ≠ manifest runId ${expected.runId}`,
      );
    }
    if (expected.canonicalCommit !== undefined && ev.canonicalCommit !== expected.canonicalCommit) {
      throw new BrokerRefusal(
        "broker.event_binding_mismatch",
        `audit event canonicalCommit ${ev.canonicalCommit} ≠ commit being installed ${expected.canonicalCommit}`,
      );
    }
    if (expected.requireCanonicalKind && !CANONICAL_INSTALLING_KINDS.has(ev.kind)) {
      throw new BrokerRefusal(
        "broker.event_binding_mismatch",
        `audit event kind "${ev.kind}" cannot accompany a canonical install`,
      );
    }
  }

  /** Advance a protected ref under CAS + ancestry (+ optional authorization). */
  async advanceProtectedRef(req: RefAdvanceRequest): Promise<RefAdvanceResult> {
    if (!this.isProtected(req.ref)) {
      throw new BrokerRefusal("broker.ref_not_protected", `"${req.ref}" is not a broker-writable protected ref`);
    }
    // The audit ref has a DEDICATED atomic append path (`audit.append`). Routing
    // it through this generic primitive would first advance+anchor the audit ref
    // (a durable side effect) and only THEN fail the requested CAS on a now-stale
    // expected old head — leaving audit history mutated for a failed op. Refuse it
    // outright BEFORE any side effect (round-3 finding 6).
    if (req.ref === this.refs.audit) {
      throw new BrokerRefusal(
        "broker.ref_not_protected",
        `${req.ref} must be mutated via the dedicated audit append path, not advanceProtectedRef`,
      );
    }

    const current = await this.git.readRef(req.ref);
    const currentOrZero = current ?? ZERO_OID;
    if (currentOrZero !== req.expectedOld) {
      throw new BrokerRefusal(
        "broker.cas_failed",
        `CAS failed on ${req.ref}: expected ${req.expectedOld}, found ${currentOrZero}`,
      );
    }

    const newSha = await this.git.readRef(req.newCommit);
    if (newSha === null) {
      throw new BrokerRefusal("broker.unknown_commit", `newCommit ${req.newCommit} does not resolve`);
    }

    // Fast-forward only (except the very first commit onto an empty ref).
    if (current !== null && !(await this.git.isAncestor(current, newSha))) {
      throw new BrokerRefusal(
        "broker.not_fast_forward",
        `${req.newCommit} does not descend from ${current} — non-fast-forward advance refused`,
      );
    }

    // Authorization (Tier-3 privileged advances). Bind the authorization to the
    // CONCRETE effect the broker is about to perform: the target commit must be
    // the commit being integrated, the run must be the manifest's run, and (for a
    // canonical advance) the signed base must be the current canonical tip. An
    // authorization minted for a different commit/run/base is refused as drift —
    // an authorization for operation A can never advance to a different B.
    if (req.authorization !== undefined) {
      if (req.authorizedOp === undefined) {
        throw new BrokerRefusal(
          "broker.bad_request",
          "an authorization requires authorizedOp (the op + intendedEffect it authorizes)",
        );
      }
      const isCanonical = req.ref === this.refs.canonical;
      const expected: ExpectedAuthorization = {
        // Bind the op + effect the mutation actually represents (finding 3) …
        op: req.authorizedOp.op,
        intendedEffect: req.authorizedOp.intendedEffect,
        // … as well as the run + target commit + (canonical) base it observes.
        runId: req.manifest.runId,
        targetCommit: newSha,
        ...(isCanonical ? { canonicalBaseCommit: currentOrZero } : {}),
      };
      this.authorizer.verify(req.authorization, {
        ...(isCanonical ? { currentCanonicalTip: current } : {}),
        expected,
      });
    }

    // Bind the audit event to the OBSERVED operation state (round-3 finding 2):
    // the event must belong to this run and (for a canonical install) commit to
    // the exact commit being installed with a canonical-installing kind — a
    // caller cannot append an unrelated or mismatched event alongside the move.
    this.bindAuditEventToOperation(req.auditEvent, {
      runId: req.manifest.runId,
      canonicalCommit: req.ref === this.refs.canonical ? newSha : undefined,
      requireCanonicalKind: req.ref === this.refs.canonical,
    });

    // Re-verify + append the audit event (signature + monotonic seq re-checked).
    const appended = await this.audit.append(req.auditEvent);

    // Only now advance the protected ref, under CAS.
    try {
      await this.git.updateRefCas(req.ref, newSha, req.expectedOld);
    } catch {
      throw new BrokerRefusal("broker.cas_failed", `${req.ref} advanced concurrently; refusing`);
    }

    return { ok: true, ref: req.ref, newCommit: newSha, seq: appended.seq, auditHead: appended.head };
  }

  /**
   * Integrate a Tier-1 source capture: verify the capture commit touches only
   * `sources/**` + manifest paths, then fast-forward canonical under CAS.
   */
  async integrateSourceCapture(req: SourceCaptureRequest): Promise<RefAdvanceResult> {
    const canonical = this.refs.canonical;
    const current = await this.git.readRef(canonical);
    const currentOrZero = current ?? ZERO_OID;
    if (currentOrZero !== req.expectedBase) {
      throw new BrokerRefusal(
        "broker.cas_failed",
        `capture base moved: expected ${req.expectedBase}, canonical is ${currentOrZero}`,
      );
    }

    const captureSha = await this.git.readRef(req.captureCommit);
    if (captureSha === null) {
      throw new BrokerRefusal("broker.unknown_commit", `captureCommit ${req.captureCommit} does not resolve`);
    }

    // Scope: EVERY commit added by the capture (the whole expectedBase..capture
    // range, not just the tip vs its parent) may touch ONLY sources/** + manifest
    // paths — a multi-commit capture cannot smuggle a forbidden path through an
    // earlier commit while the tip stays clean.
    const changed =
      current === null
        ? await this.git.changedPaths(captureSha)
        : await this.git.changedPathsInRange(currentOrZero, captureSha);
    const offending = changed.filter((p) => !isCaptureAllowedPath(p));
    if (offending.length > 0) {
      throw new BrokerRefusal(
        "broker.capture_scope_violation",
        `source capture touches paths outside sources/** + manifest: ${offending.join(", ")}`,
      );
    }

    // Fast-forward only.
    if (current !== null && !(await this.git.isAncestor(current, captureSha))) {
      throw new BrokerRefusal(
        "broker.not_fast_forward",
        `capture ${req.captureCommit} does not descend from canonical ${current}`,
      );
    }

    // Bind the audit event to the capture being installed (round-3 finding 2).
    this.bindAuditEventToOperation(req.auditEvent, {
      runId: req.manifest.runId,
      canonicalCommit: captureSha,
      requireCanonicalKind: true,
    });

    const appended = await this.audit.append(req.auditEvent);

    try {
      await this.git.updateRefCas(canonical, captureSha, req.expectedBase);
    } catch {
      throw new BrokerRefusal("broker.cas_failed", `canonical advanced concurrently; refusing capture`);
    }

    return { ok: true, ref: canonical, newCommit: captureSha, seq: appended.seq, auditHead: appended.head };
  }
}

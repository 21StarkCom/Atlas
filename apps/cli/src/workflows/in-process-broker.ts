/**
 * `workflows/in-process-broker` — the IN-PROCESS collapse of the broker's
 * canonical-installing surface (ADR-0003, phase-2 in-process cutover, task 2.2).
 *
 * The privilege-separated broker is retired: with "zero provisioning" there is no
 * separate OS identity holding the attestation key, so the canonical-ref advance
 * runs IN-PROCESS and the attestation-signed `refs/audit/runs` append + WORM anchor
 * are DROPPED (both needed OS key custody). Only the git fast-forward of
 * `git.canonical_ref` survives this phase (Phase-3 collapses onto a direct
 * `refs/heads/main` commit).
 *
 * This object is deliberately shaped as an in-process drop-in for the exact
 * `BrokerClient` methods the two integration seams consume today — so
 * `makeBrokerIntegrator(client)` (the `RunIntegrator` for enrich/reconcile/maintain/
 * git-refresh) and `brokerSignedIntegration(client, scope)` / the capture seam (the
 * `CaptureIntegration` for ingest/note add/sync) are called UNCHANGED, with an
 * in-process client in place of a socket-connected one. No call site of the two
 * seams changes; only the client construction (in-process, not `BrokerClient.connect`)
 * differs. It is "the in-process BrokerService shape minus the attestation/audit
 * append", not a net-new integration path.
 *
 * The one substantive behavior change from the broker: the audit append + WORM
 * anchor are gone. Everything else the broker enforced BEFORE the ref move is
 * PRESERVED in-process — the FF-only CAS (via {@link advanceCanonicalRef}) and, for
 * captures, the `"sources"`/`"note"`/`"sync"` scope policy over the whole
 * `base..commit` range (so a capture seam can never advance an arbitrary FF commit).
 */
import type { AuditEvent } from "@atlas/contracts";
import {
  advanceCanonicalRef,
  type Repo,
} from "@atlas/git";
import {
  isCaptureAllowedPath,
  isNoteAddAllowedPath,
  isSyncAllowedPath,
  type CaptureScope,
  type RefAdvanceResult,
  type SignAndAdvanceRequest,
  type SignAndSourceCaptureRequest,
} from "@atlas/broker";
import type { AuditBroker, UnsignedAuditEvent } from "@atlas/sqlite-store";
import { CanonicalRefError } from "@atlas/git";

/** The all-zeros object id a CAS uses for "the ref must not already exist". */
const ZERO_OID = "0".repeat(40);

/**
 * The RAW git name-status letters a `"sync"` absorb may carry — byte-for-byte the
 * broker's `SYNC_ALLOWED_STATUSES` (packages/broker/src/refs.ts): A/M/D and BOTH
 * rename (`R`) and copy (`C`), the latter because the raw parser reports a copy
 * under `C` (no fold to `A`). Anything else — `T` (typechange, e.g. a note
 * swapped for a symlink), `U`, `X`, `B`, or an unknown future letter — fails
 * closed. Kept over RAW letters (not `@atlas/git`'s normalized `ChangeStatus`) so
 * a `T` the broker rejects is not silently laundered into an accepted `M`.
 */
const SYNC_ALLOWED_STATUSES: ReadonlySet<string> = new Set(["A", "M", "D", "R", "C"]);

/** The kinds whose canonical-installing effect the ref-advance seam owns (never a generic append). */
const CANONICAL_INSTALLING_KINDS = new Set(["run.integrated", "run.rolled_back"]);

/**
 * A no-daemon, no-attestation-key audit-append refusal for canonical-installing
 * kinds. Carries the broker-compatible `broker.audit_kind_not_signable` code so the
 * engine's / reconciler's integration-crash probe classifies a `run.integrated` as
 * un-anchored exactly as it did against the real broker (`signAndAppendAuditEvent`
 * refuses installing kinds; only the protected-ref path may attest them).
 */
export class InProcessAuditKindNotSignable extends Error {
  readonly code = "broker.audit_kind_not_signable";
  constructor(kind: string) {
    super(`audit kind "${kind}" is canonical-installing; it is produced by the ref-advance seam, never appended`);
    this.name = "InProcessAuditKindNotSignable";
  }
}

/**
 * The in-process client. Implements the `BrokerClient` methods the integration
 * seams call + the {@link AuditBroker} the run state machine appends its
 * non-installing events through — one object, so a single value is both the
 * `broker` (AuditBroker) dep and the client passed to `makeBrokerIntegrator` /
 * `brokerSignedIntegration`.
 */
/**
 * The STRUCTURAL client shape the capture-integration seam (`brokerSignedIntegration`
 * / `buildCaptureDeps`) consumes: the {@link AuditBroker} the run state machine
 * appends its non-installing events through, the Tier-1 capture integrate, and a
 * `close()`. Deliberately the SUBSET a socket-connected `BrokerClient` ALSO satisfies
 * — so the seam contract stays identical and either client (in-process OR the
 * socket `BrokerClient`) can be handed to it unchanged (the seam never depends on the
 * concrete in-process return type).
 */
export interface CaptureClient extends AuditBroker {
  /** The Tier-1 capture integrate (`brokerSignedIntegration`). Scope-checked + FF-only CAS; no audit/WORM in-process. */
  signAndIntegrateSourceCapture(r: SignAndSourceCaptureRequest): Promise<RefAdvanceResult>;
  /** Release any transport (a no-op for the in-process client; the socket for a `BrokerClient`). */
  close(): void;
}

export interface InProcessBrokerClient extends CaptureClient {
  /** The general-scope canonical advance (`makeBrokerIntegrator`). FF-only CAS; no audit/WORM. */
  signAndAdvanceProtectedRef(r: SignAndAdvanceRequest): Promise<RefAdvanceResult>;
}

/** The seq carried by an unsigned canonical-installing event (echoed back — no audit append allocates one). */
function eventSeq(event: Omit<AuditEvent, "prevAuditHead">): number {
  return event.seq;
}

/**
 * Validate that the commit range `base..commit` touches ONLY the paths (and, for
 * `"note"`/`"sync"`, the statuses) the broker's `integrateSourceCapture` scope
 * policy permitted — over the WHOLE range, so a multi-commit capture cannot smuggle
 * a forbidden path/status through an earlier commit while the tip stays clean. Throws
 * a `broker.capture_scope_violation`-coded {@link CanonicalRefError} fail-closed on
 * any offending change (mirrors the broker refusal code so callers see the same
 * verdict). Empty change sets are refused for `"note"`/`"sync"` (an absorb/note-add
 * that mirrors nothing has no business advancing canonical, and is also the shape a
 * silently-misparsed diff would take); `"sources"` permits an empty set (parity with
 * the broker, which only filtered paths).
 */
async function assertCaptureScope(repo: Repo, base: string, commit: string, scope: CaptureScope): Promise<void> {
  const from = base === ZERO_OID ? null : base;
  // ALL-REACHABLE + RAW statuses (`git log … -m`), NOT a first-parent walk — the
  // exact inspection the broker's scope gate runs (`changedPathStatuses*`). This is
  // what makes the in-process gate equivalent: a forbidden change made (or made and
  // reverted) on a MERGED SIDE BRANCH surfaces here (a first-parent walk would miss
  // it), and a `T` typechange stays `T` (a normalized `M` would wrongly pass the
  // sync gate). Renames/copies contribute BOTH sides as separate entries.
  const changes = await repo.changedStatusesInRange(from, commit);

  const violation = (detail: string): never => {
    throw new CanonicalRefError("broker.capture_scope_violation", detail);
  };

  if (scope === "note") {
    if (changes.length === 0) violation("note add changed no paths (or the change set could not be read) — refusing");
    const offending = changes.filter((e) => e.status !== "A" || !isNoteAddAllowedPath(e.path));
    if (offending.length > 0) {
      violation(`note add must only ADD *.md files outside sources/: ${offending.map((e) => `${e.status} ${e.path}`).join(", ")}`);
    }
    return;
  }
  if (scope === "sync") {
    if (changes.length === 0) violation("sync absorb changed no paths (or the change set could not be read) — refusing");
    // Every reported path of every allowed-status entry is path-validated — both
    // sides of a rename/copy land as separate entries, so a rename INTO or OUT OF
    // sources/ fails on whichever side lands there. Any status outside {A,M,D,R,C}
    // — `T` included — fails closed (a change the gate does not understand).
    const offending = changes.filter(
      (e) => !SYNC_ALLOWED_STATUSES.has(e.status) || !isSyncAllowedPath(e.path),
    );
    if (offending.length > 0) {
      violation(`sync absorb may only ADD/MODIFY/DELETE/RENAME *.md files outside sources/: ${offending.map((e) => `${e.status} ${e.path}`).join(", ")}`);
    }
    return;
  }
  // "sources" (default): sources/** + manifest paths; both rename sides checked
  // (each reported path is validated individually).
  const offending = changes.filter((e) => !isCaptureAllowedPath(e.path));
  if (offending.length > 0) {
    violation(`source capture touches paths outside sources/** + manifest: ${offending.map((e) => e.path).join(", ")}`);
  }
}

/**
 * Bind the canonical-installing audit event to the OBSERVED operation BEFORE any
 * ref moves — the in-process mirror of the broker's `bindAuditEventToOperation`
 * (packages/broker/src/refs.ts). Refuses (`broker.event_binding_mismatch`) when
 * the event does not belong to the manifest's run, does not commit to the exact
 * commit being installed, or is not a canonical-installing kind. Without this an
 * advance would accept an event with the wrong runId, a stale/forged
 * canonicalCommit, or a non-installing kind (e.g. `run.rejected`) laundered onto a
 * real canonical move.
 */
function bindEventToCanonicalInstall(
  event: Omit<AuditEvent, "prevAuditHead">,
  expected: { runId: string; canonicalCommit: string },
): void {
  if (event.runId !== expected.runId) {
    throw new CanonicalRefError(
      "broker.event_binding_mismatch",
      `audit event runId ${event.runId} ≠ manifest runId ${expected.runId}`,
    );
  }
  if (event.canonicalCommit !== expected.canonicalCommit) {
    throw new CanonicalRefError(
      "broker.event_binding_mismatch",
      `audit event canonicalCommit ${event.canonicalCommit} ≠ commit being installed ${expected.canonicalCommit}`,
    );
  }
  if (!CANONICAL_INSTALLING_KINDS.has(event.kind)) {
    throw new CanonicalRefError(
      "broker.event_binding_mismatch",
      `audit event kind "${event.kind}" cannot accompany a canonical install`,
    );
  }
}

/**
 * Build the in-process broker client over the vault {@link Repo}. `canonicalRef` is
 * the config-supplied canonical ref (`git.canonical_ref`) the capture integrate
 * fast-forwards — the broker read it from its own config; here it is threaded in, so
 * `signAndIntegrateSourceCapture` (whose request carries no ref) advances the same
 * ref the general path does.
 */
export function makeInProcessBrokerClient(repo: Repo, canonicalRef: string): InProcessBrokerClient {
  return {
    async signAndAppendAuditEvent(unsigned: UnsignedAuditEvent): Promise<{ seq: number; head: string }> {
      // Canonical-installing kinds are produced by the ref-advance seam, never
      // appended — refuse with the broker-compatible code (the recovery probe relies
      // on it). Every non-installing kind (`run.started`/`run.planned`/terminals/
      // `run.refreshed`) is a no-op append: the caller's SQLite step still records the
      // `audit_events` row (the local ledger the state machine reads), so this hands
      // back the allocated `seq` and an empty git head (no audit ref this phase).
      if (CANONICAL_INSTALLING_KINDS.has(unsigned.kind)) {
        throw new InProcessAuditKindNotSignable(unsigned.kind);
      }
      return { seq: unsigned.seq, head: "" };
    },

    async signAndAdvanceProtectedRef(r: SignAndAdvanceRequest): Promise<RefAdvanceResult> {
      // CONFINE to the configured canonical ref (the broker's general advance was
      // limited to its protected-ref set; with audit/trust retired only canonical
      // remains). A request naming any other ref is refused BEFORE any side effect —
      // otherwise this seam could FF an arbitrary ref. `assertCanonicalRef` inside
      // `advanceCanonicalRef` still blocks the audit/trust namespaces defensively.
      if (r.ref !== canonicalRef) {
        throw new CanonicalRefError(
          "broker.ref_not_protected",
          `"${r.ref}" is not the configured canonical ref (${canonicalRef}); the in-process advance moves canonical only`,
        );
      }
      // Resolve the target commit + bind the audit event to the OBSERVED install
      // (runId, exact commit, installing kind) BEFORE the ref moves — the broker's
      // `bindAuditEventToOperation` equivalent, so a wrong-run / mismatched-commit /
      // non-installing event can never accompany the move.
      const newSha = await repo.readRef(r.newCommit);
      if (newSha === null) {
        throw new CanonicalRefError("broker.bad_commit", `newCommit "${r.newCommit}" does not resolve to a commit`);
      }
      bindEventToCanonicalInstall(r.event, { runId: r.manifest.runId, canonicalCommit: newSha });
      // FF-only CAS advance of canonical; audit/WORM dropped. A CAS miss surfaces as
      // `broker.cas_failed` (via advanceCanonicalRef), so the synthesis-apply retry
      // loop rebases exactly as it did against the broker.
      const newCommit = await advanceCanonicalRef(repo.dir, canonicalRef, newSha, r.expectedOld);
      return { ok: true, ref: canonicalRef, newCommit, seq: eventSeq(r.event), auditHead: "" };
    },

    async signAndIntegrateSourceCapture(r: SignAndSourceCaptureRequest): Promise<RefAdvanceResult> {
      // Preserve the broker-enforced capture scope IN-PROCESS (over the whole
      // base..commit range) BEFORE the ref moves — a capture seam can never advance a
      // commit that touches paths/statuses outside its declared scope.
      await assertCaptureScope(repo, r.expectedBase, r.captureCommit, r.scope ?? "sources");
      // Resolve the capture commit + bind the audit event to it (runId, the exact
      // commit being installed, installing kind) BEFORE the ref moves — same
      // event/manifest binding the broker enforces on the capture path.
      const captureSha = await repo.readRef(r.captureCommit);
      if (captureSha === null) {
        throw new CanonicalRefError("broker.bad_commit", `captureCommit "${r.captureCommit}" does not resolve to a commit`);
      }
      bindEventToCanonicalInstall(r.event, { runId: r.manifest.runId, canonicalCommit: captureSha });
      const newCommit = await advanceCanonicalRef(repo.dir, canonicalRef, captureSha, r.expectedBase);
      return { ok: true, ref: canonicalRef, newCommit, seq: eventSeq(r.event), auditHead: "" };
    },

    close(): void {
      /* no socket — no-op drop-in for the seam call sites' `close()`. */
    },
  };
}

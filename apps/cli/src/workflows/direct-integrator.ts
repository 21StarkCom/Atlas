/**
 * `workflows/direct-integrator` — the v2 daemon-free canonical-install seams
 * (task 3-3b, #325). The single-process replacement for the retired Phase-2
 * broker-client factories (`makeInProcessBrokerClient` / `makeBrokerIntegrator` /
 * `brokerSignedIntegration`): the canonical ref is now `refs/heads/main` with NO
 * config indirection, and a run's `integrated` checkpoint fast-forwards it
 * directly through {@link advanceCanonicalRef} (@atlas/git's v2 FF-only CAS
 * carve-out) — no socket, no attestation key, no `refs/audit/runs` append, no WORM.
 *
 * Two seams the engine already consumes are preserved UNCHANGED in shape:
 *  - {@link RunIntegrator} (`makeCanonicalIntegrator`) — the general synthesis
 *    Tier-2 advance used by enrich/reconcile/maintain/evidence resolve/refresh;
 *  - {@link CaptureIntegration} (`makeDirectCaptureIntegration`) — the Tier-1
 *    capture advance for source add / ingest / note add / sync, which STILL
 *    re-enforces the `"sources"` / `"note"` / `"sync"` path-and-status SCOPE
 *    policy over the whole `base..commit` range before the FF advance (so a
 *    capture can never install a commit touching paths outside its declared
 *    scope). A `broker.cas_failed` refusal propagates unchanged so the engine's
 *    CAS-rebase loop is untouched.
 *
 * A single {@link inProcessAuditBroker} shim provides the {@link AuditBroker} the
 * run state machine appends its NON-installing events through (a no-op that echoes
 * the allocated `seq` and an empty head — there is no git audit ref in v2). It
 * refuses the canonical-installing kinds fail-closed, exactly as the retired
 * in-process broker did, so the reconciler's un-anchored-integration probe keeps
 * classifying a `run.integrated` correctly.
 */
import type { AuditEvent } from "@atlas/contracts";
import { advanceCanonicalRef, CanonicalRefError, type Repo } from "@atlas/git";
import {
  isCaptureAllowedPath,
  isNoteAddAllowedPath,
  isSyncAllowedPath,
  type CaptureScope,
} from "@atlas/broker";
import type { AuditBroker, UnsignedAuditEvent } from "@atlas/sqlite-store";
import type { BrokerIntegration, IntegrationContext, RunIntegrator } from "./index.js";
import type { CaptureIntegration } from "../ingest/capture.js";
import { makeBrokerSignedCaptureIntegrator } from "../ingest/capture.js";

/** The one branch v2 installs onto — canonical IS `refs/heads/main` (no indirection). */
export const CANONICAL_BRANCH = "refs/heads/main";

/** The all-zeros object id a CAS uses for "the ref must not already exist". */
const ZERO_OID = "0".repeat(40);

/** RAW git name-status letters a `"sync"` absorb may carry (A/M/D + rename/copy). */
const SYNC_ALLOWED_STATUSES: ReadonlySet<string> = new Set(["A", "M", "D", "R", "C"]);

/** The kinds whose canonical-installing effect the ref-advance seam owns. */
const CANONICAL_INSTALLING_KINDS = new Set(["run.integrated", "run.rolled_back"]);

function rfc3339Ms(): string {
  return new Date().toISOString();
}

/**
 * The daemon-free {@link AuditBroker}. Canonical-installing kinds are produced by
 * the ref-advance seam, never appended — refused fail-closed with the
 * broker-compatible code the reconciler's probe relies on. Every non-installing
 * kind is a no-op append that echoes the allocated `seq` (the SQLite step still
 * records the local `audit_events` row) with an empty git head (no audit ref in v2).
 */
export function inProcessAuditBroker(): AuditBroker {
  return {
    async signAndAppendAuditEvent(unsigned: UnsignedAuditEvent): Promise<{ seq: number; head: string }> {
      if (CANONICAL_INSTALLING_KINDS.has(unsigned.kind)) {
        throw new CanonicalRefError(
          "broker.audit_kind_not_signable",
          `audit kind "${unsigned.kind}" is canonical-installing; it is produced by the ref-advance seam, never appended`,
        );
      }
      return { seq: unsigned.seq, head: "" };
    },
  };
}

/**
 * Bind the canonical-installing audit event to the OBSERVED operation BEFORE any
 * ref moves — refuses (`broker.event_binding_mismatch`) on a wrong runId, a
 * stale/forged commit, or a non-installing kind.
 */
function bindEventToCanonicalInstall(
  event: Omit<AuditEvent, "prevAuditHead">,
  expected: { runId: string; canonicalCommit: string },
): void {
  if (event.runId !== expected.runId) {
    throw new CanonicalRefError("broker.event_binding_mismatch", `audit event runId ${event.runId} ≠ manifest runId ${expected.runId}`);
  }
  if (event.canonicalCommit !== expected.canonicalCommit) {
    throw new CanonicalRefError("broker.event_binding_mismatch", `audit event canonicalCommit ${event.canonicalCommit} ≠ commit being installed ${expected.canonicalCommit}`);
  }
  if (!CANONICAL_INSTALLING_KINDS.has(event.kind)) {
    throw new CanonicalRefError("broker.event_binding_mismatch", `audit event kind "${event.kind}" cannot accompany a canonical install`);
  }
}

/**
 * The general synthesis {@link RunIntegrator}: FF-advance `refs/heads/main` to the
 * agent commit under CAS, binding the unsigned `run.integrated` event to the
 * install first. `broker.cas_failed` propagates so `applySynthesis` rebases.
 */
export function makeCanonicalIntegrator(repo: Repo): RunIntegrator {
  return async (ctx: IntegrationContext): Promise<BrokerIntegration> => {
    const newSha = await repo.readRef(ctx.commitSha);
    if (newSha === null) {
      throw new CanonicalRefError("broker.bad_commit", `commit "${ctx.commitSha}" does not resolve`);
    }
    bindEventToCanonicalInstall(ctx.event, { runId: ctx.runId, canonicalCommit: newSha });
    const newCommit = await advanceCanonicalRef(repo.dir, CANONICAL_BRANCH, newSha, ctx.baseRef);
    return { canonicalRef: CANONICAL_BRANCH, canonicalSha: newCommit, seq: ctx.event.seq, auditHead: "" };
  };
}

/**
 * Validate that `base..commit` touches ONLY the paths (and, for `"note"`/`"sync"`,
 * the statuses) the declared capture scope permits — over the WHOLE range, so a
 * multi-commit capture cannot smuggle a forbidden path through an earlier commit.
 */
async function assertCaptureScope(repo: Repo, base: string, commit: string, scope: CaptureScope): Promise<void> {
  const from = base === ZERO_OID ? null : base;
  const changes = await repo.changedStatusesInRange(from, commit);
  const violation = (detail: string): never => {
    throw new CanonicalRefError("broker.capture_scope_violation", detail);
  };
  if (scope === "note") {
    if (changes.length === 0) violation("note add changed no paths (or the change set could not be read) — refusing");
    const offending = changes.filter((e) => e.status !== "A" || !isNoteAddAllowedPath(e.path));
    if (offending.length > 0) violation(`note add must only ADD *.md files outside sources/: ${offending.map((e) => `${e.status} ${e.path}`).join(", ")}`);
    return;
  }
  if (scope === "sync") {
    if (changes.length === 0) violation("sync absorb changed no paths (or the change set could not be read) — refusing");
    const offending = changes.filter((e) => !SYNC_ALLOWED_STATUSES.has(e.status) || !isSyncAllowedPath(e.path));
    if (offending.length > 0) violation(`sync absorb may only ADD/MODIFY/DELETE/RENAME *.md files outside sources/: ${offending.map((e) => `${e.status} ${e.path}`).join(", ")}`);
    return;
  }
  const offending = changes.filter((e) => !isCaptureAllowedPath(e.path));
  if (offending.length > 0) violation(`source capture touches paths outside sources/** + manifest: ${offending.map((e) => e.path).join(", ")}`);
}

/**
 * The daemon-free {@link CaptureIntegration} (Tier-1). Re-enforces the capture
 * SCOPE policy over the whole `base..commit` range, binds the event, then
 * FF-advances `refs/heads/main` — the direct replacement for the retired
 * `brokerSignedIntegration(makeInProcessBrokerClient(...))` pair. `broker` is the
 * {@link inProcessAuditBroker} shim; `close()` is a no-op (no socket).
 */
export function makeDirectCaptureIntegration(repo: Repo, scope: CaptureScope = "sources"): CaptureIntegration {
  const broker = inProcessAuditBroker();
  const integrate = makeBrokerSignedCaptureIntegrator({
    integrateSourceCapture: async (r) => {
      await assertCaptureScope(repo, r.expectedBase, r.captureCommit, scope);
      const captureSha = await repo.readRef(r.captureCommit);
      if (captureSha === null) {
        throw new CanonicalRefError("broker.bad_commit", `captureCommit "${r.captureCommit}" does not resolve`);
      }
      bindEventToCanonicalInstall(r.event, { runId: r.manifest.runId, canonicalCommit: captureSha });
      const newCommit = await advanceCanonicalRef(repo.dir, CANONICAL_BRANCH, captureSha, r.expectedBase);
      return { newCommit, seq: r.event.seq, auditHead: "", ref: CANONICAL_BRANCH };
    },
  });
  return { broker, integrate, close: () => {} };
}

void rfc3339Ms;

/**
 * `workflows/direct-integrator` — the v2 daemon-free canonical-install seam. The
 * canonical ref is `refs/heads/main` with NO config indirection, and a run's
 * `integrated` checkpoint fast-forwards it directly through {@link advanceCanonicalRef}
 * (@atlas/git's v2 FF-only CAS carve-out) — no socket, no attestation key, no
 * `refs/audit/runs` append, no WORM, no audit event.
 *
 * v2 (#338): the §2.8 audit ledger is retired, so the `inProcessAuditBroker` shim and
 * the unsigned-event binding are gone — a canonical install is now purely the git
 * FF-CAS. The surviving seam is {@link RunIntegrator} (`makeCanonicalIntegrator`) —
 * the general synthesis Tier-2 advance. v2 #340 retired the Tier-1
 * `makeDirectCaptureIntegration` capture seam + its `"sources"`/`"note"`/`"sync"`
 * path-scope gate with the capture engine: `ingest` now commits its produced note
 * DIRECTLY through the common `runMutation` + `commitPaths` mutation order (like
 * `note add`), so there is no separate capture integrator left to scope-check.
 */
import { advanceCanonicalRef, CanonicalRefError, type Repo } from "@atlas/git";
import type { BrokerIntegration, IntegrationContext, RunIntegrator } from "./index.js";

/** The one branch v2 installs onto — canonical IS `refs/heads/main` (no indirection). */
export const CANONICAL_BRANCH = "refs/heads/main";

/**
 * The general synthesis {@link RunIntegrator}: FF-advance `refs/heads/main` to the
 * agent commit under CAS. `broker.cas_failed` propagates so `applySynthesis` rebases.
 */
export function makeCanonicalIntegrator(repo: Repo): RunIntegrator {
  return async (ctx: IntegrationContext): Promise<BrokerIntegration> => {
    const newSha = await repo.readRef(ctx.commitSha);
    if (newSha === null) {
      throw new CanonicalRefError("broker.bad_commit", `commit "${ctx.commitSha}" does not resolve`);
    }
    const newCommit = await advanceCanonicalRef(repo.dir, CANONICAL_BRANCH, newSha, ctx.baseRef);
    return { canonicalRef: CANONICAL_BRANCH, canonicalSha: newCommit };
  };
}

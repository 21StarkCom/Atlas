/**
 * `workflows/direct-integrator` — the v2 daemon-free canonical-install seams. The
 * canonical ref is `refs/heads/main` with NO config indirection, and a run's
 * `integrated` checkpoint fast-forwards it directly through {@link advanceCanonicalRef}
 * (@atlas/git's v2 FF-only CAS carve-out) — no socket, no attestation key, no
 * `refs/audit/runs` append, no WORM, no audit event.
 *
 * v2 (#338): the §2.8 audit ledger is retired, so the `inProcessAuditBroker` shim and
 * the unsigned-event binding are gone — a canonical install is now purely the git
 * FF-CAS. Two seams the engine consumes are preserved in shape:
 *  - {@link RunIntegrator} (`makeCanonicalIntegrator`) — the general synthesis
 *    Tier-2 advance used by enrich/reconcile/maintain/evidence resolve/refresh;
 *  - {@link CaptureIntegration} (`makeDirectCaptureIntegration`) — the Tier-1
 *    capture advance for source add / ingest / note add / sync, which STILL
 *    re-enforces the `"sources"` / `"note"` / `"sync"` path-and-status SCOPE policy
 *    over the whole `base..commit` range before the FF advance (so a capture can
 *    never install a commit touching paths outside its declared scope). A
 *    `broker.cas_failed` refusal propagates unchanged so the engine's CAS-rebase loop
 *    is untouched.
 */
import { advanceCanonicalRef, CanonicalRefError, type Repo } from "@atlas/git";
import {
  isCaptureAllowedPath,
  isNoteAddAllowedPath,
  isSyncAllowedPath,
  type CaptureScope,
} from "./capture-scope.js";
import type { BrokerIntegration, IntegrationContext, RunIntegrator } from "./index.js";
import type { CaptureIntegration } from "../ingest/capture.js";
import { makeBrokerSignedCaptureIntegrator } from "../ingest/capture.js";

/** The one branch v2 installs onto — canonical IS `refs/heads/main` (no indirection). */
export const CANONICAL_BRANCH = "refs/heads/main";

/** The all-zeros object id a CAS uses for "the ref must not already exist". */
const ZERO_OID = "0".repeat(40);

/** RAW git name-status letters a `"sync"` absorb may carry (A/M/D + rename/copy). */
const SYNC_ALLOWED_STATUSES: ReadonlySet<string> = new Set(["A", "M", "D", "R", "C"]);

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
 * SCOPE policy over the whole `base..commit` range, then FF-advances
 * `refs/heads/main`. `close()` is a no-op (no socket).
 */
export function makeDirectCaptureIntegration(repo: Repo, scope: CaptureScope = "sources"): CaptureIntegration {
  const integrate = makeBrokerSignedCaptureIntegrator({
    integrateSourceCapture: async (r) => {
      await assertCaptureScope(repo, r.expectedBase, r.captureCommit, scope);
      const captureSha = await repo.readRef(r.captureCommit);
      if (captureSha === null) {
        throw new CanonicalRefError("broker.bad_commit", `captureCommit "${r.captureCommit}" does not resolve`);
      }
      const newCommit = await advanceCanonicalRef(repo.dir, CANONICAL_BRANCH, captureSha, r.expectedBase);
      return { newCommit, ref: CANONICAL_BRANCH };
    },
  });
  return { integrate, close: () => {} };
}

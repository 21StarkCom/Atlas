/**
 * `ingest/wiring` — assemble the capture dependencies from a {@link RunContext}.
 *
 * The MUTATING deps (store open+migrate, canonical-install seam, worktree) are handed
 * to `captureSource` as LAZY factories so they are assembled ONLY after the
 * scan-before-persist preflight succeeds. v2 (#338): the canonical install is a plain
 * git FF-CAS onto `refs/heads/main` — no audit ledger, no attestation key, no backup.
 */
import { openRepo } from "@atlas/git";
import type { RunContext } from "../handlers.js";
import type { CaptureScope } from "../workflows/capture-scope.js";
import { openWorkflowStore } from "../workflows/index.js";
import { makeDirectCaptureIntegration, CANONICAL_BRANCH } from "../workflows/direct-integrator.js";
import { openMigratedStore } from "../commands/store-open.js";
import { ledgerDbPath, resolvePath } from "../commands/paths.js";
import { type CaptureDeps, type CaptureIntegration } from "./capture.js";

/** A read-only projection probe for `ingest` preview (never creates/migrates a store). */
export function probeStore(ctx: RunContext): (() => ReturnType<typeof openMigratedStore> | null) {
  return () => {
    try {
      return openMigratedStore(ctx);
    } catch {
      return null; // no migrated ledger yet ⇒ nothing to reuse; preview persists nothing
    }
  };
}

/**
 * Build the capture-integration seam for an applied capture — DAEMON-FREE (ADR-0003).
 * Resolves the vault {@link Repo} from `ctx` (the SINGLE resolution, reused by {@link
 * buildCaptureDeps}) and returns the in-process {@link makeDirectCaptureIntegration}
 * seam; no socket connect, so an applied capture needs no running broker. The canonical
 * ref is now ALWAYS `refs/heads/main` ({@link CANONICAL_BRANCH}) — no config indirection.
 * Kept `async` + same signature so `buildCaptureDeps`' `connectIntegration` factory (and
 * its callers) are unchanged.
 */
export async function connectBrokerIntegration(ctx: RunContext, scope: CaptureScope = "sources"): Promise<CaptureIntegration> {
  const repo = openRepo(resolvePath(ctx, ctx.config.config.vault.path));
  return makeDirectCaptureIntegration(repo, scope);
}

/**
 * Assemble the {@link CaptureDeps} for an applied capture. The vault {@link Repo} is
 * resolved ONCE here and the SAME `repo` instance is reused for both the run's git ops
 * (`CaptureDeps.repo`) and the integration seam (`connectIntegration`) — a ctx-resolved
 * vault path and a raw relative one must never diverge (finding: commit creation +
 * integration must target the same repository even when `ctx.cwd` ≠ `process.cwd`).
 */
export function buildCaptureDeps(ctx: RunContext, command: string, idempotencyKey?: string, scope: CaptureScope = "sources"): CaptureDeps {
  const repo = openRepo(resolvePath(ctx, ctx.config.config.vault.path));
  return {
    openStore: () => openWorkflowStore({ path: ledgerDbPath(ctx) }),
    repo,
    connectIntegration: () => Promise.resolve(makeDirectCaptureIntegration(repo, scope)),
    worktreesPath: resolvePath(ctx, ctx.config.config.git.worktrees_path),
    canonicalRef: CANONICAL_BRANCH,
    command,
    ...(idempotencyKey !== undefined ? { idempotencyKey } : {}),
  };
}

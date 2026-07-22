/**
 * `ingest/wiring` — assemble the capture dependencies from a {@link RunContext}.
 *
 * The guard is built up front (its only side effect is quarantining a detected
 * secret, to a dir OUTSIDE the vault/repo). The MUTATING deps (store open+migrate,
 * broker connection, worktree) are handed to `captureSource` as LAZY factories so
 * they are assembled ONLY after the scan-before-persist preflight succeeds
 * (DEFECT #1). The broker-side integration seam signs the `run.integrated` event —
 * the CLI never holds the audit-attestation key (DEFECT #2).
 */
import { type CaptureScope } from "@atlas/broker";
import { PrePersistenceGuard } from "@atlas/scan";
import { openRepo } from "@atlas/git";
import type { RunContext } from "../handlers.js";
import { quarantineStoreFromContext } from "../quarantine/config.js";
import { openWorkflowStore } from "../workflows/index.js";
import { makeDirectCaptureIntegration, CANONICAL_BRANCH } from "../workflows/direct-integrator.js";
import { openMigratedStore } from "../commands/store-open.js";
import { backupConfig, ledgerDbPath, resolvePath } from "../commands/backup-config.js";
import { type CaptureDeps, type CaptureIntegration } from "./capture.js";

/** Build the required scan-before-persist guard (quarantine sink outside the vault). */
export function buildGuard(ctx: RunContext): PrePersistenceGuard {
  return new PrePersistenceGuard(quarantineStoreFromContext(ctx));
}

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
    backup: backupConfig(ctx),
    worktreesPath: resolvePath(ctx, ctx.config.config.git.worktrees_path),
    canonicalRef: CANONICAL_BRANCH,
    command,
    ...(idempotencyKey !== undefined ? { idempotencyKey } : {}),
  };
}

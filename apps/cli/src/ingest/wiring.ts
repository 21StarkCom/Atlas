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
import { type CaptureScope, DEFAULT_CANONICAL_REF } from "@atlas/broker";
import { PrePersistenceGuard } from "@atlas/scan";
import { openRepo } from "@atlas/git";
import type { RunContext } from "../handlers.js";
import { quarantineStoreFromContext } from "../quarantine/config.js";
import { openWorkflowStore, makeInProcessBrokerClient, type CaptureClient } from "../workflows/index.js";
import { openMigratedStore } from "../commands/store-open.js";
import { backupConfig, ledgerDbPath, resolvePath } from "../commands/backup-config.js";
import { makeBrokerSignedCaptureIntegrator, type CaptureDeps, type CaptureIntegration } from "./capture.js";

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
 * Build the capture-integration seam over a capture `client` (ADR-0003, phase-2
 * in-process cutover). `client` is the STRUCTURAL {@link CaptureClient} — the
 * `AuditBroker` + `signAndIntegrateSourceCapture` + `close` subset a socket-connected
 * `BrokerClient` ALSO satisfies — so the seam contract is unchanged and either client
 * (in-process today, a socket `BrokerClient` if ever re-wired) can be handed in. Kept
 * its production name + shape: it wraps the `client.signAndIntegrateSourceCapture`
 * method with the SAME `makeBrokerSignedCaptureIntegrator` seam a socket-connected
 * capture used — only the `client` is now in-process by default. The
 * privilege-separated broker is retired: the canonical-ref advance runs in-process and
 * the attestation-signed `refs/audit/runs` append + WORM anchor are DROPPED (no OS key
 * custody). What is NOT dropped is the capture-commit path/status SCOPE policy
 * (`"sources"` / `"note"` / `"sync"`): the in-process client re-enforces it over the
 * whole `base..commit` range before any FF advance, so a capture seam can never advance
 * an arbitrary commit. The `broker` field is the same client (its `signAndAppendAuditEvent`
 * appends the run state machine's non-installing events — no git audit ref, no WORM).
 */
export function brokerSignedIntegration(client: CaptureClient, scope: CaptureScope = "sources"): CaptureIntegration {
  const integrate = makeBrokerSignedCaptureIntegrator({
    // The UNSIGNED `run.integrated` event is threaded through with its NATURAL type
    // straight to the in-process integrate; the declared `scope` selects which path
    // policy the client enforces over the whole `base..commit` range.
    integrateSourceCapture: (r) =>
      client.signAndIntegrateSourceCapture({
        captureCommit: r.captureCommit,
        expectedBase: r.expectedBase,
        manifest: r.manifest,
        event: r.event,
        scope,
      }),
  });
  return {
    broker: client,
    integrate,
    close: () => client.close(),
  };
}

/**
 * Build the capture-integration seam for an applied capture — now DAEMON-FREE
 * (ADR-0003). Resolves the vault {@link Repo} + canonical ref from `ctx` (the SINGLE
 * resolution, reused by {@link buildCaptureDeps}) and returns the in-process seam; no
 * socket connect, so an applied capture needs no running broker. Kept `async` + same
 * signature so `buildCaptureDeps`' `connectIntegration` factory (and its callers) are
 * unchanged.
 */
export async function connectBrokerIntegration(ctx: RunContext, scope: CaptureScope = "sources"): Promise<CaptureIntegration> {
  const repo = openRepo(resolvePath(ctx, ctx.config.config.vault.path));
  const canonicalRef = ctx.config.config.git.canonical_ref ?? DEFAULT_CANONICAL_REF;
  return brokerSignedIntegration(makeInProcessBrokerClient(repo, canonicalRef), scope);
}

/**
 * Assemble the {@link CaptureDeps} for an applied capture. The vault {@link Repo} +
 * canonical ref are resolved ONCE here and the SAME `repo` instance is reused for both
 * the run's git ops (`CaptureDeps.repo`) and the integration seam
 * (`connectIntegration`) — a ctx-resolved vault path and a raw relative one must never
 * diverge (finding: commit creation + integration must target the same repository even
 * when `ctx.cwd` ≠ `process.cwd`).
 */
export function buildCaptureDeps(ctx: RunContext, command: string, idempotencyKey?: string, scope: CaptureScope = "sources"): CaptureDeps {
  const repo = openRepo(resolvePath(ctx, ctx.config.config.vault.path));
  const canonicalRef = ctx.config.config.git.canonical_ref ?? DEFAULT_CANONICAL_REF;
  return {
    openStore: () => openWorkflowStore({ path: ledgerDbPath(ctx) }),
    repo,
    connectIntegration: () => Promise.resolve(brokerSignedIntegration(makeInProcessBrokerClient(repo, canonicalRef), scope)),
    backup: backupConfig(ctx),
    worktreesPath: resolvePath(ctx, ctx.config.config.git.worktrees_path),
    canonicalRef,
    command,
    ...(idempotencyKey !== undefined ? { idempotencyKey } : {}),
  };
}

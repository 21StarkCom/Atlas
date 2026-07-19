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
import { BrokerClient, type CaptureScope } from "@atlas/broker";
import { PrePersistenceGuard } from "@atlas/scan";
import { openRepo } from "@atlas/git";
import { CliError, EXIT } from "../errors/envelope.js";
import type { RunContext } from "../handlers.js";
import { quarantineStoreFromContext } from "../quarantine/config.js";
import { openWorkflowStore } from "../workflows/index.js";
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
 * Build the broker-side capture-integration seam over an ALREADY-CONNECTED
 * {@link BrokerClient}. The `run.integrated` event is a canonical-installing kind
 * that ONLY the broker's protected-ref path may attest, so the CLI submits it
 * UNSIGNED and the broker signs it internally via `signAndIntegrateSourceCapture`
 * (DEFECT #2 — the CLI never holds the attestation key). The broker fills
 * `prevAuditHead`, signs the event with its attestation key, scope-checks the
 * capture commit (`sources/**` + manifest only), and fast-forwards canonical under
 * Tier-1 CAS — all in one lock-held RPC. This is the SINGLE production construction
 * of the seam; both `connectBrokerIntegration` (daemon socket) and the Phase-2 E2E
 * harness drive it, so the E2E exercises the real wiring rather than a duplicate.
 */
export function brokerSignedIntegration(client: BrokerClient, scope: CaptureScope = "sources"): CaptureIntegration {
  const integrate = makeBrokerSignedCaptureIntegrator({
    // The UNSIGNED `run.integrated` event is threaded through with its NATURAL type
    // (`Omit<AuditEvent, "prevAuditHead">`) straight to the capture RPC — no
    // `SignedAuditEvent` masquerade (round-3 finding #6). The broker fills
    // `prevAuditHead` + signs it internally under its protected-ref lock. The
    // declared `scope` selects which broker-enforced path policy applies
    // (`"sources"`: sources/** + manifest; `"note"`: additions-only *.md, #262).
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
 * Connect the broker daemon socket and build the broker-side capture-integration
 * seam ({@link brokerSignedIntegration}). Surfaces an unreachable broker as a
 * typed `broker-unreachable` CliError so an applied capture fails clearly rather
 * than silently.
 */
export async function connectBrokerIntegration(ctx: RunContext, scope: CaptureScope = "sources"): Promise<CaptureIntegration> {
  let client: BrokerClient;
  try {
    client = await BrokerClient.connect(ctx.config.config.broker.socket_path);
  } catch (e) {
    throw new CliError({
      code: "broker-unreachable",
      message: `the broker is unreachable at ${ctx.config.config.broker.socket_path}: ${e instanceof Error ? e.message : String(e)}`,
      hint: "Start the broker daemon before an applied capture (it signs the run.integrated event + performs the Tier-1 CAS).",
      exitCode: EXIT.INTERNAL,
      cause: e,
    });
  }
  return brokerSignedIntegration(client, scope);
}

/** Assemble the {@link CaptureDeps} for an applied capture. */
export function buildCaptureDeps(ctx: RunContext, command: string, idempotencyKey?: string, scope: CaptureScope = "sources"): CaptureDeps {
  return {
    openStore: () => openWorkflowStore({ path: ledgerDbPath(ctx) }),
    repo: openRepo(ctx.config.config.vault.path),
    connectIntegration: () => connectBrokerIntegration(ctx, scope),
    backup: backupConfig(ctx),
    worktreesPath: resolvePath(ctx, ctx.config.config.git.worktrees_path),
    command,
    ...(idempotencyKey !== undefined ? { idempotencyKey } : {}),
  };
}

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
import { BrokerClient } from "@atlas/broker";
import { PrePersistenceGuard } from "@atlas/scan";
import { openRepo } from "@atlas/git";
import { CliError, EXIT } from "../errors/envelope.js";
import type { RunContext } from "../handlers.js";
import { quarantineStoreFromContext } from "../quarantine/config.js";
import { openWorkflowStore } from "../workflows/index.js";
import { openMigratedStore } from "../commands/store-open.js";
import { backupConfig, ledgerDbPath, resolvePath } from "../commands/backup-config.js";
import { makeCaptureIntegrator, type CaptureDeps, type CaptureIntegration } from "./capture.js";

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
 * Connect the broker-side capture-integration seam. The `run.integrated` event is a
 * canonical-installing kind that ONLY the broker's protected-ref path may attest, so
 * the broker signs it (DEFECT #2 — the CLI holds no attestation key). ASSUMPTION
 * (noted per the step's ambiguity rule): a Tier-1 capture reaches broker-side signing
 * through the injected seam; the tests provide an in-process broker seam, and the
 * production seam connects the broker daemon socket. The broker's own
 * `integrateSourceCapture` binds + appends the signed event, so the seam supplies the
 * signed event via the broker rather than a CLI-held key.
 */
export async function connectBrokerIntegration(ctx: RunContext): Promise<CaptureIntegration> {
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
  const integrate = makeCaptureIntegrator({
    // The broker signs canonical-installing events inside its protected-ref path; the
    // CLI never signs. A stock IPC broker exposes no standalone canonical-signing
    // method, so an applied capture requires a broker that produces the signed
    // integration event — surfaced clearly rather than smuggling a CLI-held key.
    sign: () => {
      throw new CliError({
        code: "capture-integration-unavailable",
        message: "the connected broker does not expose canonical-event signing over IPC",
        hint: "An applied capture requires a broker that signs the run.integrated event broker-side (the CLI never holds the attestation key).",
        exitCode: EXIT.INTERNAL,
      });
    },
    integrateSourceCapture: (r) => client.integrateSourceCapture(r),
  });
  return {
    broker: client,
    integrate,
    close: () => client.close(),
  };
}

/** Assemble the {@link CaptureDeps} for an applied capture. */
export function buildCaptureDeps(ctx: RunContext, command: string, idempotencyKey?: string): CaptureDeps {
  return {
    openStore: () => openWorkflowStore({ path: ledgerDbPath(ctx) }),
    repo: openRepo(ctx.config.config.vault.path),
    connectIntegration: () => connectBrokerIntegration(ctx),
    backup: backupConfig(ctx),
    worktreesPath: resolvePath(ctx, ctx.config.config.git.worktrees_path),
    command,
    ...(idempotencyKey !== undefined ? { idempotencyKey } : {}),
  };
}

/**
 * `sync reset` command handler (60-B Phase 5) — the privileged OQ#5 escape hatch.
 *
 * Two EXCLUSIVE modes (this is what makes the signed flow obtainable at all):
 *  - `--export-challenge`: scanned, READ-ONLY planning (dry scanners, no lock, no
 *    mutation) → emit the broker AuthorizationChallenge on stdout, exit 0.
 *  - `--authorization <path>`: verify the signed challenge (the operator-consent
 *    gate) and re-converge the canonical ref to the upstream tree.
 * A mutating invocation with NEITHER is action-required (exit 6). Both flags ⇒
 * usage (exit 5). `--yes` is inert in both modes (never authorizes).
 */
import { BrokerClient } from "@atlas/broker";
import { bindEnqueueContext, productionEnqueueContext } from "@atlas/jobs";
import { assertBackupHealthy, BackupUnhealthyError } from "@atlas/sqlite-store";
import type { AuthorizationResponse } from "@atlas/contracts";
import { readFileSync } from "node:fs";
import { registerCommand, type RunContext } from "../handlers.js";
import { CliError, EXIT, emitJson } from "../errors/envelope.js";
import { buildCaptureDeps } from "../ingest/wiring.js";
import { DEFAULT_CANONICAL_REF } from "../ingest/capture.js";
import { realScanners } from "./sync.js";
import { exportResetChallenge, applySyncReset, type SyncResetDeps, type SyncResetEnvelope } from "../sync/reset.js";

interface ResetArgs {
  readonly exportChallenge: boolean;
  readonly authorization: string | undefined;
}

export function parseResetArgs(argv: readonly string[]): ResetArgs {
  let exportChallenge = false;
  let authorization: string | undefined;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === "--export-challenge") exportChallenge = true;
    else if (a === "--authorization") authorization = argv[++i];
    else if (a.startsWith("--authorization=")) authorization = a.slice("--authorization=".length);
    else if (a === "--yes") continue; // inert — never authorizes a privileged mutation
    else if (a === "--idempotency-key" || a.startsWith("--idempotency-key=")) {
      if (a === "--idempotency-key") i++;
    } else throw CliError.usage(`unknown argument for sync reset: ${a}`);
  }
  if (exportChallenge && authorization !== undefined) {
    throw CliError.usage("sync reset: --export-challenge and --authorization are mutually exclusive");
  }
  if (authorization === "" ) throw CliError.usage("sync reset: --authorization requires a path");
  return { exportChallenge, authorization };
}

function connectBroker(ctx: RunContext): () => Promise<BrokerClient> {
  return async () => {
    try {
      return await BrokerClient.connect(ctx.config.config.broker.socket_path);
    } catch (e) {
      throw new CliError({
        code: "broker-unreachable",
        message: `the broker is unreachable at ${ctx.config.config.broker.socket_path}`,
        hint: "Start the broker daemon before running sync reset.",
        exitCode: EXIT.CONFIG,
        cause: e,
      });
    }
  };
}

function renderReset(ctx: RunContext, env: SyncResetEnvelope): void {
  if (ctx.output.mode === "json") {
    emitJson(env);
    return;
  }
  const lines = [
    `sync reset (${env.mode}): ${env.canonicalRef} → ${env.reBaselinedTo?.slice(0, 12) ?? "?"} (upstream ${env.upstreamRef})`,
    `captured ${env.captured.length} · archived ${env.archived.length} · quarantined ${env.quarantined.length}${env.historyGapAccepted ? " · history gap accepted" : ""}`,
  ];
  if (env.reconcileJobId !== null) lines.push(`index:reconcile enqueued: ${env.reconcileJobId}`);
  ctx.render(lines.join("\n"));
}

async function syncResetHandler(ctx: RunContext): Promise<number> {
  const args = parseResetArgs(ctx.argv);
  const cap = buildCaptureDeps(ctx, "sync reset", undefined, "sync");

  const baseDeps = (store: ReturnType<typeof cap.openStore>): SyncResetDeps => ({
    store,
    repo: cap.repo,
    connectIntegration: cap.connectIntegration,
    connectBroker: connectBroker(ctx),
    backup: cap.backup,
    worktreesPath: cap.worktreesPath,
    canonicalRef: cap.canonicalRef,
    defaultCanonicalRef: DEFAULT_CANONICAL_REF,
    noteGlobs: ctx.config.config.vault.note_globs,
    now: cap.now ?? (() => new Date().toISOString()),
    ...realScanners(ctx),
  });

  // --export-challenge: read-only, no lock, no mutation → emit the challenge.
  if (args.exportChallenge) {
    const store = cap.openStore();
    try {
      const res = await exportResetChallenge({ ...baseDeps(store), ...dryScannersForExport() });
      if (res.challenge !== undefined) emitJson(res.challenge);
      return res.exitCode;
    } finally {
      store.close();
    }
  }

  // A mutating invocation needs an authorization.
  if (args.authorization === undefined) {
    throw new CliError({
      code: "action-required",
      message: "sync reset requires a broker authorization",
      hint: "Re-run with --export-challenge, sign the challenge with an enrolled approver key, then pass --authorization <path>. --yes never authorizes.",
      exitCode: EXIT.ACTION_REQUIRED,
    });
  }
  const authorization = JSON.parse(readFileSync(args.authorization, "utf8")) as AuthorizationResponse;

  return ctx.withLock("vault-maintenance", async () => {
    const store = cap.openStore();
    try {
      try {
        assertBackupHealthy(store.db);
      } catch (e) {
        if (e instanceof BackupUnhealthyError) {
          throw new CliError({
            code: "backup-unhealthy",
            message: e.message,
            hint: "A degraded backup blocks ledger-writing runs; run `db backup` / `db restore` first.",
            exitCode: EXIT.CONFIG,
          });
        }
        throw e;
      }
      bindEnqueueContext(store.db, productionEnqueueContext({ defaultMaxAttempts: ctx.config.config.jobs.max_attempts }));
      const res = await applySyncReset(baseDeps(store), authorization);
      renderReset(ctx, res.envelope);
      return res.exitCode;
    } finally {
      store.close();
    }
  });
}

/**
 * Dry scanners for --export-challenge: verdict-only (no quarantine record
 * persisted), but the generated-artifact scan is REAL — export must refuse to
 * mint a challenge for a reset whose audit-ref-bound ids/paths carry a secret
 * (else it would export a challenge for a reset that then blocks at apply). It
 * throws SecretDetectedError (exit 3) without persisting anything.
 */
function dryScannersForExport(): Pick<SyncResetDeps, "scanNoteBytes" | "scanGeneratedArtifact"> {
  return {
    scanNoteBytes: async (bytes, origin) => {
      const { scanBytes } = await import("@atlas/scan");
      const v = scanBytes({ bytes, context: { origin, boundary: "pre-persistence", kind: "raw" } });
      return v.clean ? { clean: true } : { clean: false, quarantineId: "" };
    },
    scanGeneratedArtifact: async (text, runId) => {
      const { scanBytes, SecretDetectedError } = await import("@atlas/scan");
      const origin = `run:${runId}→audit`;
      const v = scanBytes({ bytes: new TextEncoder().encode(text), context: { origin, boundary: "generated-artifact", sink: "audit" } });
      if (!v.clean) throw new SecretDetectedError(origin, v.findings, "generated-artifact");
    },
  };
}

registerCommand("sync reset", syncResetHandler);

export { syncResetHandler };

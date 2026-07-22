/**
 * `brain db backup [--force-unblock] [--export-challenge | --authorization <path>]`
 * (Task 1.7).
 *
 * Produces a verified encrypted ledger backup (Online Backup snapshot →
 * temp-then-rename AEAD bundle, content-hash + schema stamp, retention prune) and
 * advances the fail-closed watermark — the primary unblock (contract T5). Under
 * the exclusive `ledger-maintenance` lock. `--force-unblock` is the audited
 * PRIVILEGED override (T6): it requires a broker `op: "db backup --force-unblock"`
 * authorization bound to the accepted RPO gap (`latestLedgerSeq` + `acceptedRpoGap`)
 * via the non-interactive `--export-challenge` → sign → `--authorization` flow,
 * then records a `db.force_unblock` ledger audit row (D6).
 */
import { readFileSync } from "node:fs";
import {
  forceUnblock,
  latestRunSeq,
  listBackups,
  openStore,
  takeBackup,
  watermarkHealth,
} from "@atlas/sqlite-store";
import { BrokerClient, type PrivilegedOpDescriptor } from "@atlas/broker";
import type { AuthorizationResponse } from "@atlas/contracts";
import { CliError, EXIT, emitJson } from "../errors/envelope.js";
import { registerCommand, type RunContext } from "../handlers.js";
import { backupConfig, ledgerDbPath } from "./backup-config.js";

interface BackupArgs {
  forceUnblock: boolean;
  exportChallenge: boolean;
  authorizationPath: string | null;
}

function parseArgs(argv: string[]): BackupArgs {
  let forceUnblock = false;
  let exportChallenge = false;
  let authorizationPath: string | null = null;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === "--force-unblock") forceUnblock = true;
    else if (a === "--export-challenge") exportChallenge = true;
    else if (a === "--authorization") {
      // Missing/empty required flag value ⇒ usage (exit 5), not a silent "no auth".
      const v = argv[++i];
      if (v === undefined || v.length === 0) throw CliError.usage("--authorization requires a <path> value");
      authorizationPath = v;
    } else if (a.startsWith("--authorization=")) {
      const v = a.slice("--authorization=".length);
      if (v.length === 0) throw CliError.usage("--authorization requires a <path> value");
      authorizationPath = v;
    } else throw CliError.usage(`unknown flag for \`db backup\`: ${a}`);
  }
  if ((exportChallenge || authorizationPath !== null) && !forceUnblock) {
    throw CliError.usage("--export-challenge/--authorization apply only to `db backup --force-unblock`");
  }
  if (exportChallenge && authorizationPath !== null) {
    throw CliError.usage("--export-challenge and --authorization are mutually exclusive");
  }
  return { forceUnblock, exportChallenge, authorizationPath };
}

/** The `db backup --force-unblock` op descriptor, bound to the accepted RPO gap (§7.4). */
function forceUnblockDescriptor(latestLedgerSeq: number, acceptedRpoGap: number): PrivilegedOpDescriptor {
  return {
    op: "db backup --force-unblock",
    canonicalBaseCommit: "0".repeat(40),
    intendedEffect: { kind: "forceUnblock", latestLedgerSeq, acceptedRpoGap },
  };
}

async function dbBackup(ctx: RunContext): Promise<number> {
  const args = parseArgs(ctx.argv);
  const cfg = backupConfig(ctx);
  const store = openStore({ path: ledgerDbPath(ctx) });
  try {
    return await ctx.withLock("ledger-maintenance", async () => {
      if (args.forceUnblock) {
        return dbForceUnblock(ctx, store, args, cfg);
      }

      let result;
      try {
        result = await takeBackup(store, cfg);
      } catch (e) {
        throw new CliError({
          code: "backup-failed",
          message: `ledger backup failed: ${e instanceof Error ? e.message : String(e)}`,
          exitCode: EXIT.VALIDATION,
          cause: e,
        });
      }
      const h = watermarkHealth(store.db);
      ctx.log.info("db.backup", { backupRef: result.backupRef, seq: result.seq, method: result.method });
      emit(ctx, {
        command: "db backup",
        backupRef: result.backupRef,
        // The subsystem uses −1 as the "nothing covered" sentinel (finding 3); the
        // committed --json schema requires seq/coveredSeq ≥ 0, so clamp for display.
        seq: Math.max(0, result.seq),
        coveredSeq: Math.max(0, h.coveredSeq),
        healthy: h.healthy,
      });
      return EXIT.OK;
    });
  } finally {
    store.close();
  }
}

/**
 * The audited privileged `--force-unblock` override (T6). Binds the broker
 * authorization to the accepted RPO gap computed under the lock, so an
 * authorization can never clear a DIFFERENT (larger) gap than the approver saw.
 */
async function dbForceUnblock(
  ctx: RunContext,
  store: ReturnType<typeof openStore>,
  args: BackupArgs,
  cfg: ReturnType<typeof backupConfig>,
): Promise<number> {
  // The accepted RPO gap is derived under the lock (no concurrent ledger write).
  const h0 = watermarkHealth(store.db);
  const latestLedgerSeq = Math.max(0, latestRunSeq(store.db));
  const acceptedRpoGap = Math.max(0, h0.seq - h0.coveredSeq);
  const socket = ctx.config.config.broker.socket_path;
  const desc = forceUnblockDescriptor(latestLedgerSeq, acceptedRpoGap);

  // --export-challenge: mint + emit the challenge, then exit action-required (6).
  if (args.exportChallenge) {
    const broker = await BrokerClient.connect(socket);
    try {
      emitJson(await broker.mintChallenge(desc));
    } finally {
      broker.close();
    }
    return EXIT.CONFIG;
  }

  // No authorization supplied → action-required (6). `--force-unblock` is never
  // authorized by `--yes`; only a signed broker authorization clears the block.
  if (args.authorizationPath === null) {
    throw new CliError({
      code: "authorization-required",
      message: "db backup --force-unblock requires a signed authorization (--authorization <path>)",
      hint: "Run with --force-unblock --export-challenge, sign the challenge with an enrolled approver key, then pass --authorization.",
      exitCode: EXIT.CONFIG,
    });
  }

  // Verify the authorization with the broker (drift/signature/nonce/D20 gate); the
  // effect (latestLedgerSeq + acceptedRpoGap) must match what we re-derived here.
  const auth = JSON.parse(readFileSync(args.authorizationPath, "utf8")) as AuthorizationResponse;
  const broker = await BrokerClient.connect(socket);
  try {
    await broker.execAuthorized(desc, auth);
  } catch (e) {
    throw new CliError({
      code: "authorization-invalid",
      message: `force-unblock authorization rejected: ${e instanceof Error ? e.message : String(e)}`,
      exitCode: EXIT.CONFIG,
      cause: e,
    });
  } finally {
    broker.close();
  }

  // Authorized: clear the block, recording the accepted RPO gap (D6 audit row).
  const { fromSeq, toSeq } = forceUnblock(store);
  const latest = listBackups(cfg)[0];
  const h = watermarkHealth(store.db);
  ctx.log.info("db.force_unblock", { fromSeq, toSeq, acceptedRpoGap });
  emit(ctx, {
    command: "db backup",
    backupRef: latest?.backupRef ?? "",
    seq: Math.max(0, toSeq),
    coveredSeq: Math.max(0, h.coveredSeq),
    healthy: h.healthy,
    forcedUnblock: { fromSeq: Math.max(0, fromSeq), toSeq: Math.max(0, toSeq) },
  });
  return EXIT.OK;
}

function emit(ctx: RunContext, obj: Record<string, unknown>): void {
  if (ctx.output.mode === "json") emitJson(obj);
  else ctx.render(`backup ${String(obj.backupRef)} — seq ${String(obj.seq)} (healthy: ${String(obj.healthy)})`);
}

registerCommand("db backup", dbBackup);

export { dbBackup };

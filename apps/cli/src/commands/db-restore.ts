/**
 * `brain db restore <backupRef> [--export-challenge | --authorization <path>]`
 * (Task 1.7) — privileged, destructive emergency restore (contract §10).
 *
 * Authorized ONLY by the broker `op: "db.restore"` challenge (bound to `backupRef`
 * + content hash) via the non-interactive `--export-challenge` → sign →
 * `--authorization` flow; `--yes` never authorizes. On authorization it acquires
 * the exclusive `vault-maintenance` + `ledger-maintenance` locks (§2.5 order),
 * registers the projection-rebuild post-restore hook, and calls the sqlite-store
 * transactional restore (which verifies the bundle, atomically replaces the
 * ledger tables, establishes a fresh watermark, writes the D6 `db.restore` row,
 * then runs the hooks).
 */
import { existsSync, readFileSync } from "node:fs";
import {
  BackupIntegrityError,
  openStore,
  readBundleHeader,
  recoverInterruptedRestore,
  registerPostRestoreRebuild,
  rebuildProjections,
  resolveBackupRef,
  restoreBackup,
  _resetPostRestoreRebuild,
} from "@atlas/sqlite-store";
import { dirname } from "node:path";
import { BrokerClient, type PrivilegedOpDescriptor } from "@atlas/broker";
import type { AuthorizationResponse } from "@atlas/contracts";
import { readVault } from "../vault/reader.js";
import { CliError, EXIT, emitJson } from "../errors/envelope.js";
import { registerCommand, type RunContext } from "../handlers.js";
import { backupConfig, backupConfigForKeyId, ledgerDbPath } from "./backup-config.js";
import { rebuildIndexFromVault } from "./index-ops.js";

/** Map a bundle-integrity failure to the committed db-restore error class (exit 1). */
function backupIntegrityCliError(backupRef: string, e: unknown): CliError {
  const msg = e instanceof Error ? e.message : String(e);
  if (/schema/.test(msg)) {
    return new CliError({
      code: "backup-schema-incompatible",
      message: `backup ${backupRef} schema is incompatible with this binary: ${msg}`,
      exitCode: EXIT.VALIDATION,
      cause: e,
    });
  }
  return new CliError({
    code: "backup-corrupt",
    message: `backup ${backupRef} failed verification: ${msg}`,
    exitCode: EXIT.VALIDATION,
    cause: e,
  });
}

interface RestoreArgs {
  backupRef: string;
  exportChallenge: boolean;
  authorizationPath: string | null;
}

function parseArgs(argv: string[]): RestoreArgs {
  let backupRef: string | undefined;
  let exportChallenge = false;
  let authorizationPath: string | null = null;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === "--export-challenge") exportChallenge = true;
    else if (a === "--authorization") {
      // A required flag value that is missing/empty is a USAGE error (exit 5),
      // NOT a silent "no authorization" (which would misfire action-required, 6).
      const v = argv[++i];
      if (v === undefined || v.length === 0) throw CliError.usage("--authorization requires a <path> value");
      authorizationPath = v;
    } else if (a.startsWith("--authorization=")) {
      const v = a.slice("--authorization=".length);
      if (v.length === 0) throw CliError.usage("--authorization requires a <path> value");
      authorizationPath = v;
    } else if (a.startsWith("-")) throw CliError.usage(`unknown flag for \`db restore\`: ${a}`);
    else if (backupRef === undefined) backupRef = a;
    else throw CliError.usage(`unexpected argument: ${a}`);
  }
  if (backupRef === undefined) throw CliError.usage("db restore requires a <backupRef> argument");
  if (exportChallenge && authorizationPath !== null) {
    throw CliError.usage("--export-challenge and --authorization are mutually exclusive");
  }
  return { backupRef, exportChallenge, authorizationPath };
}

/**
 * The `db.restore` op descriptor. `canonicalBaseCommit` is a placeholder here: for
 * the canonical-bound ledger ops the BROKER re-derives the base from its own
 * observed canonical tip at both mint and verify (round-3 finding 6), so the value
 * the CLI supplies is ignored and cannot be used to smuggle a stale/forged base
 * past the drift gate. The security-relevant binding is the AEAD-authenticated
 * `backupContentHash`.
 */
function restoreDescriptor(backupRef: string, contentHash: string): PrivilegedOpDescriptor {
  return {
    op: "db restore",
    canonicalBaseCommit: "0".repeat(40), // broker re-derives; see doc above (finding 6)
    intendedEffect: { kind: "restore", backupRef, backupContentHash: `sha256:${contentHash}` },
  };
}

async function dbRestore(ctx: RunContext): Promise<number> {
  const args = parseArgs(ctx.argv);

  // Startup crash-recovery for an interrupted prior restore (round-3 finding 4):
  // roll a half-completed swap back to a consistent state BEFORE opening the store.
  recoverInterruptedRestore(dirname(ledgerDbPath(ctx)));

  // `readBundleHeader` needs no key (the header is authenticated-but-plaintext); it
  // yields the STAMPED key id + content hash. A missing file is backup-not-found; an
  // unreadable/invalid bundle is backup-corrupt (both exit 1, per the committed schema).
  const cfgCurrent = backupConfig(ctx);
  const resolvedRef = resolveBackupRef(cfgCurrent, args.backupRef);
  if (!existsSync(resolvedRef)) {
    throw new CliError({
      code: "backup-not-found",
      message: `backup ${args.backupRef} does not exist`,
      exitCode: EXIT.VALIDATION,
    });
  }
  let header;
  try {
    header = readBundleHeader(cfgCurrent, args.backupRef);
  } catch (e) {
    throw backupIntegrityCliError(args.backupRef, e);
  }
  // F7 (round-3 finding 7): resolve the key STAMPED in the bundle, so a backup taken
  // under a rotated-out key still verifies + restores (custody retains prior ids).
  const cfg = backupConfigForKeyId(ctx, header.keyId);
  const socket = ctx.config.config.broker.socket_path;

  // --export-challenge: mint + emit the challenge, then exit action-required (6).
  if (args.exportChallenge) {
    const broker = await BrokerClient.connect(socket);
    try {
      const challenge = await broker.mintChallenge(restoreDescriptor(args.backupRef, header.contentHash));
      emitJson(challenge);
    } finally {
      broker.close();
    }
    return EXIT.CONFIG;
  }

  // No authorization supplied → action-required (6).
  if (args.authorizationPath === null) {
    throw new CliError({
      code: "authorization-required",
      message: "db restore requires a signed authorization (--authorization <path>)",
      hint: "Run with --export-challenge, sign the challenge with an enrolled approver key, then pass --authorization.",
      exitCode: EXIT.CONFIG,
    });
  }

  // Verify the authorization with the broker (drift/signature/nonce/D20 gate).
  const auth = JSON.parse(readFileSync(args.authorizationPath, "utf8")) as AuthorizationResponse;
  const broker = await BrokerClient.connect(socket);
  try {
    await broker.execAuthorized(restoreDescriptor(args.backupRef, header.contentHash), auth);
  } catch (e) {
    throw new CliError({
      code: "authorization-invalid",
      message: `restore authorization rejected: ${e instanceof Error ? e.message : String(e)}`,
      exitCode: EXIT.CONFIG,
      cause: e,
    });
  } finally {
    broker.close();
  }

  // Authorized: acquire exclusive vault-maintenance ⊐ ledger-maintenance (§2.5 order).
  return ctx.withLock("vault-maintenance", () =>
    ctx.withLock("ledger-maintenance", async () => {
      // Register the projection-rebuild post-restore hook (index rebuild added Phase 3).
      _resetPostRestoreRebuild();
      const hooksRun: { hook: string; ok: boolean }[] = [];
      registerPostRestoreRebuild(async (hookCtx) => {
        const snapshot = await readVault(ctx.config.config);
        rebuildProjections(hookCtx.db, snapshot);
        hooksRun.push({ hook: "projection-rebuild", ok: true });
      });
      // Phase 3 (R1-F1): rebuild the LanceDB retrieval index after the projections
      // re-land, so `db restore` ends with a consistent index. BEST-EFFORT — a restore
      // is data recovery and must NOT be rolled back because the egress broker is down
      // or the index is unconfigured; the index is disposable derived state and can be
      // rebuilt later via `brain index rebuild`. Runs AFTER the projection rebuild.
      registerPostRestoreRebuild(async (hookCtx) => {
        try {
          const report = await rebuildIndexFromVault(ctx, hookCtx.db, ctx.runId);
          hooksRun.push({ hook: "index-rebuild", ok: report.unresolved.length === 0 });
        } catch (e) {
          ctx.log.info("db.restore.index-rebuild-skipped", { reason: e instanceof Error ? e.message : String(e) });
          hooksRun.push({ hook: "index-rebuild", ok: false });
        }
      });

      const store = openStore({ path: ledgerDbPath(ctx) });
      let result;
      try {
        // F7: enforce the AUTHORIZED content hash against the AUTHENTICATED bundle
        // at restore time under the lock — a bundle swapped in at `backupRef` after
        // authorization (TOCTOU) cannot pass, since `header.contentHash` is
        // AEAD-authenticated and re-verified against the decrypted snapshot.
        result = await restoreBackup(store, args.backupRef, cfg, {
          expectedContentHash: header.contentHash,
        });
      } catch (e) {
        // A bundle-integrity failure (corrupt/wrong-key/schema) is exit 1; any other
        // restore fault (hook, filesystem) is restore-failed (exit 4). The prior DB is
        // left intact either way (all-or-nothing).
        if (e instanceof BackupIntegrityError) throw backupIntegrityCliError(args.backupRef, e);
        throw new CliError({
          code: "restore-failed",
          message: `ledger restore failed (prior DB left intact): ${e instanceof Error ? e.message : String(e)}`,
          exitCode: EXIT.INTERNAL,
          cause: e,
        });
      } finally {
        // restoreBackup closes + replaces the DB; the store handle is spent.
        try {
          store.close();
        } catch {
          /* already closed by the atomic swap */
        }
      }

      ctx.log.info("db.restore", { backupRef: args.backupRef, restoredSeq: result.restoredCutSeq });
      const out = {
        command: "db restore",
        restoredFromRef: args.backupRef,
        restoredSeq: result.restoredCutSeq,
        priorSeq: Math.max(0, result.preRestoreSeq),
        rebuildHooksRun: hooksRun,
      };
      if (ctx.output.mode === "json") emitJson(out);
      else ctx.render(`restored ${args.backupRef} → seq ${result.restoredCutSeq}`);
      return EXIT.OK;
    }),
  );
}

registerCommand("db restore", dbRestore);

export { dbRestore };

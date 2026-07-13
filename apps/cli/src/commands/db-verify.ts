/**
 * `brain db verify [--backup <backupRef>]` (Task 1.7 backup portion).
 *
 * Read-only integrity verification. Without `--backup`: runs the store invariant
 * queries (dictionary §7). With `--backup`: additionally validates a backup bundle
 * per ledger-backup-contract §8 — decryptability, content hash, and **schema
 * compatibility** with the current binary. Writes NO ledger row (non-persisting;
 * available even in the `backup-unhealthy` blocked mode) and mutates nothing. Exits
 * `0` on success, `1` on any invariant or backup-integrity failure.
 *
 * The bundle is decrypted with the key id STAMPED in its header (via custody
 * key-id retention), so a backup taken under a rotated-out key still verifies (§7).
 */
import { openStore, readBundleHeader, verifyBackup } from "@atlas/sqlite-store";
import { CliError, EXIT, emitJson } from "../errors/envelope.js";
import { registerCommand, type RunContext } from "../handlers.js";
import { backupConfig, backupConfigForKeyId, ledgerDbPath } from "./backup-config.js";

function parseArgs(argv: string[]): { backupRef: string | null } {
  let backupRef: string | null = null;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === "--backup") {
      // A bare `--backup` with no following value is a USAGE error (exit 5) — NOT a
      // silent fall-through to ordinary invariant verification (round-3 finding 11).
      const v = argv[++i];
      if (v === undefined || v.length === 0) throw CliError.usage("db verify --backup requires a <backupRef>");
      backupRef = v;
    } else if (a.startsWith("--backup=")) {
      backupRef = a.slice("--backup=".length);
    } else throw CliError.usage(`unknown flag for \`db verify\`: ${a}`);
  }
  if (backupRef !== null && backupRef.length === 0) {
    throw CliError.usage("db verify --backup requires a <backupRef>");
  }
  return { backupRef };
}

interface VerifyOutput {
  command: "db verify";
  ok: boolean;
  invariants: { name: string; ok: boolean; detail?: string }[];
  backup?: {
    backupRef: string;
    decryptable: boolean;
    contentHashOk: boolean;
    schemaCompatible: boolean;
  };
}

function dbVerify(ctx: RunContext): number {
  const args = parseArgs(ctx.argv);
  const store = openStore({ path: ledgerDbPath(ctx) });
  try {
    const report = store.verify();
    const out: VerifyOutput = {
      command: "db verify",
      ok: report.ok,
      invariants: report.invariantViolations.map((v) => ({ name: v.invariant, ok: false, detail: v.detail })),
    };

    if (args.backupRef !== null) {
      // Select the custody key by the bundle's STAMPED key id (rotation retention).
      // `readBundleHeader` needs no key (the header is authenticated-but-plaintext).
      let cfg;
      try {
        const header = readBundleHeader(backupConfig(ctx), args.backupRef);
        cfg = backupConfigForKeyId(ctx, header.keyId);
      } catch (e) {
        // Unreadable / not-a-bundle → not decryptable, verify fails.
        out.backup = { backupRef: args.backupRef, decryptable: false, contentHashOk: false, schemaCompatible: false };
        out.ok = false;
        void e;
        return finish(ctx, out);
      }
      try {
        // Throws on decrypt/auth-tag/content-hash/schema-compat failure (§8).
        verifyBackup(cfg, args.backupRef);
        out.backup = { backupRef: args.backupRef, decryptable: true, contentHashOk: true, schemaCompatible: true };
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        const schemaFail = /schema/.test(msg);
        // A schema-incompatible bundle IS decryptable + hash-ok but not compatible;
        // any other integrity error means it did not decrypt/authenticate.
        out.backup = {
          backupRef: args.backupRef,
          decryptable: schemaFail,
          contentHashOk: schemaFail,
          schemaCompatible: false,
        };
        out.ok = false;
      }
    }

    return finish(ctx, out);
  } finally {
    store.close();
  }
}

function finish(ctx: RunContext, out: VerifyOutput): number {
  if (ctx.output.mode === "json") emitJson(out);
  else ctx.render(`db verify — ${out.ok ? "ok" : "FAILED"}${out.backup ? ` (backup ${out.backup.backupRef})` : ""}`);
  // Non-mutating; exit 1 on any invariant or backup-integrity failure (contract §8).
  return out.ok ? EXIT.OK : EXIT.VALIDATION;
}

registerCommand("db verify", dbVerify);

export { dbVerify };

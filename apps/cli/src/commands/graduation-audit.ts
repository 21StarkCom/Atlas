/**
 * `brain graduation audit` (Task 5.2 / #58) — the read-only bootstrap audit of the graduation copy.
 * Fail-closed on ordering: it refuses unless a CLEAN `graduation scan` of the recorded copy exists
 * (scan-gate-open, exit 2). Then it inventories the copy's legacy notes by the bootstrap-migration
 * §7 category set (missing id/type/schema_version, ambiguous alias, duplicate identity, incompatible
 * link, unknown type, unsupported schema version; detected-credential is empty by the clean-gate
 * precondition) with ZERO mutation — asserting the copy's tree hash is byte-identical before/after.
 * Records exactly one `run.readonly` audited-read event. Output ⇒ `graduation-audit.schema.json`.
 */
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { CliError, EXIT, emitJson } from "../errors/envelope.js";
import { registerCommand, type RunContext } from "../handlers.js";
import { openWorkflowStore } from "../workflows/index.js";
import { runReadAudit } from "../audit/readonly.js";
import { readVault } from "../vault/reader.js";
import { categorizeGraduationCopy } from "../graduation/audit.js";
import { readScanState, scanStatePath } from "../graduation/state.js";
import { ledgerDbPath } from "./backup-config.js";
import { newRunId } from "@atlas/contracts";

function parseArgs(argv: string[]): void {
  for (const a of argv) throw CliError.usage(`\`graduation audit\`: unexpected argument ${a}`);
}

function treeHash(copy: string): string {
  return execFileSync("git", ["-C", copy, "rev-parse", "HEAD^{tree}"], { encoding: "utf8" }).trim();
}

async function graduationAudit(ctx: RunContext): Promise<number> {
  parseArgs(ctx.argv);

  // Fail-closed ordering gate: a CLEAN scan of the recorded copy MUST exist.
  const state = readScanState(scanStatePath(ledgerDbPath(ctx)));
  if (state === null) {
    throw new CliError({ code: "scan-gate-open", message: "no graduation scan-state gate found; run `brain graduation scan` first", hint: "Audit refuses until a clean scan of the copy has run.", exitCode: EXIT.CONFIG });
  }
  if (state.gate !== "clean") {
    throw new CliError({ code: "scan-gate-open", message: `the graduation scan gate is ${state.gate} (${state.findingCount} finding(s)); resolve them before auditing`, hint: "Resolve the quarantined findings and re-run `brain graduation scan`.", exitCode: EXIT.CONFIG });
  }
  if (!existsSync(state.copy)) {
    throw new CliError({ code: "config-invalid", message: `the scanned graduation copy no longer exists at ${state.copy}`, hint: "Re-run `brain graduation scan --copy <path>`.", exitCode: EXIT.CONFIG });
  }

  // Read-only postcondition: the copy's tree hash must be byte-identical before/after the audit.
  const before = treeHash(state.copy);
  const snapshot = await readVault({ ...ctx.config.config, vault: { ...ctx.config.config.vault, path: state.copy } });
  const { totalNotes, categories } = categorizeGraduationCopy(state.copy, snapshot);
  const after = treeHash(state.copy);
  if (before !== after) {
    throw new CliError({ code: "internal", message: "graduation audit perturbed the copy tree (read-only invariant violated)", exitCode: EXIT.INTERNAL });
  }

  // Record exactly one run.readonly audited-read (strict backup: an unhealthy watermark exits 2).
  const store = openWorkflowStore({ path: ledgerDbPath(ctx) });
  try {
    try {
      await runReadAudit(ctx, "run.readonly", "graduation audit", store, { runId: newRunId(), strictBackup: true });
    } catch (e) {
      const cause = e instanceof CliError ? e : undefined;
      if (cause && /backup/i.test(cause.message)) {
        throw new CliError({ code: "backup-unhealthy", message: `graduation audit could not take its covering backup: ${cause.message}`, hint: "Repair backup custody, then retry.", exitCode: EXIT.CONFIG, cause: e });
      }
      throw e;
    }

    const out = { command: "graduation audit", totalNotes, categories, treeHashUnchanged: true as const };
    if (ctx.output.mode === "json") emitJson(out);
    else {
      const flagged = Object.values(categories).reduce((n, arr) => n + arr.length, 0);
      ctx.render(`graduation audit — ${totalNotes} note(s), ${flagged} flagged across §7 categories (tree unchanged)`);
    }
    return EXIT.OK;
  } finally {
    store.close();
  }
}

registerCommand("graduation audit", graduationAudit);

export { graduationAudit };

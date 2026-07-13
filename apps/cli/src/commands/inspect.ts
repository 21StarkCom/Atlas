/**
 * `brain inspect` (Task 1.9 / #25) — a read-only vault overview.
 *
 * Reads + parses the configured vault and reports its note inventory (count +
 * per-`type` breakdown) and every structural issue (bad frontmatter, duplicate
 * ids, identity collisions, broken/ambiguous links) as DATA — it never throws on a
 * malformed vault, it reports it (per the committed `inspect.schema.json`). The
 * summary stays available regardless of ledger/broker health.
 *
 * As an executed Tier-0 read it ALSO appends exactly one terminal `run.readonly`
 * audit event (via {@link runReadAudit} → `finalizeLedgerWrite`, §2.8), with
 * read-run backup coalescing so cheap high-frequency inspects cannot amplify into
 * storage growth. The audit is best-effort: if the broker/ledger is unavailable or
 * the backup watermark is blocked, the run degrades to pure and the summary still
 * prints. Exit 0 on success; the aggregate `ok` is false when any `error`-severity
 * issue is present (the exit code is still 0 — inspect reports, it does not gate).
 */
import { existsSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import type { VaultError, VaultSnapshot } from "@atlas/contracts";
import { openStore } from "@atlas/sqlite-store";
import { readVault } from "../vault/reader.js";
import { CliError, EXIT, emitJson } from "../errors/envelope.js";
import { registerCommand, type RunContext } from "../handlers.js";
import { ledgerDbPath } from "./backup-config.js";
import { runReadAudit } from "../audit/readonly.js";

/** `inspect` takes no args/flags beyond the global ones (already consumed). */
function parseArgs(argv: string[]): void {
  for (const a of argv) throw CliError.usage(`unknown flag/argument for \`inspect\`: ${a}`);
}

interface InspectIssue {
  severity: "info" | "warning" | "error";
  code: string;
  message: string;
  location?: { file: string; line?: number };
}

/**
 * The projection-store summary (Task 1.9: inspect reports vault AND projection).
 * `available` is false when no migrated projection store exists yet; otherwise it
 * reports the projected note count and whether the projection has DIVERGED from
 * the freshly parsed vault (a note present/absent on one side, or a content-hash
 * mismatch — the signal that `db rebuild` is needed).
 */
interface ProjectionSummary {
  available: boolean;
  noteCount: number;
  diverged: boolean;
  detail?: string;
}

interface InspectOutput {
  command: "inspect";
  vault: string;
  noteCount: number;
  byType: Record<string, number>;
  projection: ProjectionSummary;
  issues: InspectIssue[];
  ok: boolean;
}

/**
 * Every vault-read problem is an `error`-severity issue — a malformed note,
 * duplicate id, identity collision, or unresolved/ambiguous link all make the
 * projection non-derivable, so `ok` is false when any is present. The
 * `VaultError.kind` is a stable machine code carried straight through.
 */
function toIssue(e: VaultError): InspectIssue {
  return {
    severity: "error",
    code: e.kind,
    message: e.message,
    location: { file: e.path },
  };
}

/**
 * Read the projection store (best-effort) and summarize it against the parsed
 * vault. Never throws — an absent/unmigrated/unopenable projection store reports
 * `available: false` (finding F9: "test … an unavailable projection store"), so
 * the inspect summary stays available even when the ledger is down.
 */
function projectionSummary(ctx: RunContext, snapshot: VaultSnapshot): ProjectionSummary {
  const dbPath = ledgerDbPath(ctx);
  if (!existsSync(dbPath)) {
    return { available: false, noteCount: 0, diverged: false, detail: "no projection store yet (run `db migrate` + `db rebuild`)" };
  }
  let store;
  try {
    store = openStore({ path: dbPath, readonly: true });
    // A store without the `notes` table has not been migrated for projections.
    const hasNotes = store.db.prepare(`SELECT 1 FROM sqlite_master WHERE type='table' AND name='notes'`).get() !== undefined;
    if (!hasNotes) {
      return { available: false, noteCount: 0, diverged: false, detail: "projection store not migrated (notes table absent)" };
    }
    const projRows = store.db.prepare(`SELECT note_id, content_hash FROM notes`).all() as {
      note_id: string;
      content_hash: string;
    }[];
    const proj = new Map(projRows.map((r) => [r.note_id, r.content_hash]));
    const vault = new Map(snapshot.notes.map((n) => [n.id, n.contentHash]));

    const missingInProjection = [...vault.keys()].filter((id) => !proj.has(id));
    const staleInProjection = [...proj.keys()].filter((id) => !vault.has(id));
    const contentMismatch = [...vault.entries()].filter(([id, h]) => proj.has(id) && proj.get(id) !== h).map(([id]) => id);
    const diverged = missingInProjection.length > 0 || staleInProjection.length > 0 || contentMismatch.length > 0;

    const summary: ProjectionSummary = { available: true, noteCount: proj.size, diverged };
    if (diverged) {
      const parts: string[] = [];
      if (missingInProjection.length) parts.push(`${missingInProjection.length} vault note(s) missing from projection`);
      if (staleInProjection.length) parts.push(`${staleInProjection.length} stale projection note(s) not in vault`);
      if (contentMismatch.length) parts.push(`${contentMismatch.length} content-hash mismatch(es)`);
      summary.detail = `projection diverged from vault: ${parts.join("; ")} — run \`db rebuild\``;
    }
    return summary;
  } catch (e) {
    return { available: false, noteCount: 0, diverged: false, detail: `projection store unavailable: ${e instanceof Error ? e.message : String(e)}` };
  } finally {
    store?.close();
  }
}

function buildOutput(vaultAbs: string, snapshot: VaultSnapshot, projection: ProjectionSummary): InspectOutput {
  const byType: Record<string, number> = {};
  for (const note of snapshot.notes) {
    byType[note.type] = (byType[note.type] ?? 0) + 1;
  }
  const issues = snapshot.errors.map(toIssue);
  return {
    command: "inspect",
    vault: vaultAbs,
    noteCount: snapshot.notes.length,
    byType,
    projection,
    issues,
    ok: issues.every((i) => i.severity !== "error"),
  };
}

async function inspect(ctx: RunContext): Promise<number> {
  parseArgs(ctx.argv);

  const vaultPath = ctx.config.config.vault.path;
  const vaultAbs = isAbsolute(vaultPath) ? vaultPath : resolve(ctx.cwd, vaultPath);

  let snapshot: VaultSnapshot;
  try {
    snapshot = await readVault(ctx.config.config);
  } catch (e) {
    // Only a truly unreadable vault ROOT propagates here (per the reader contract).
    throw new CliError({
      code: "vault-error",
      message: `cannot read vault at ${vaultAbs}: ${e instanceof Error ? e.message : String(e)}`,
      hint: "Check that vault.path in brain.config.yaml exists and is readable.",
      exitCode: EXIT.CONFIG,
      cause: e,
    });
  }

  const projection = projectionSummary(ctx, snapshot);
  const out = buildOutput(vaultAbs, snapshot, projection);

  // Best-effort Tier-0 audit (exactly one run.readonly when the audit path is up).
  const audit = await runReadAudit(ctx, "run.readonly", "inspect");
  ctx.log.info("inspect", { noteCount: out.noteCount, issues: out.issues.length, projectionDiverged: projection.diverged, audited: audit.recorded, runId: audit.runId });

  if (ctx.output.mode === "json") {
    emitJson(out);
  } else {
    const proj = out.projection.available
      ? `projection ${out.projection.noteCount} note(s)${out.projection.diverged ? " — DIVERGED" : ""}`
      : "projection unavailable";
    ctx.render(
      `inspect ${out.vault} — ${out.noteCount} note(s), ${out.issues.length} issue(s), ${proj} — ${out.ok ? "ok" : "issues found"}`,
    );
  }
  return EXIT.OK;
}

registerCommand("inspect", inspect);

export { inspect };

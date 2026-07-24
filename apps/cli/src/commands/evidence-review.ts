/**
 * `brain evidence review [<note>]` — a paginated, READ-ONLY listing of v2
 * vault-derived evidence needing attention (Phase-4 task 4-4). "Needs attention" is
 * the read-time EFFECTIVE state ({@link effectiveEvidenceState}), NOT just the stored
 * `status`: the command reads the CURRENT working-tree vault and re-resolves each
 * row's soft target, so an edited-but-unsynced note surfaces as `state: needs-review`
 * with a `detail` (via the `sourceNoteHash` guard), and a deleted note / renamed
 * section surfaces as `target: missing` — never a crash, never silently stale. It
 * scans ALL rows so a row whose stored status is `resolved` but whose target has since
 * drifted re-surfaces. Non-mutating, no ledger/audit. Deterministic order
 * (createdAt desc, id tie-break). Output ⇒ `evidence-review.schema.json`.
 */
import { EvidenceRepo, type EvidenceRow } from "@atlas/sqlite-store";
import type { ParsedNote } from "@atlas/contracts";
import { CliError, EXIT, emitJson } from "../errors/envelope.js";
import { registerCommand, type RunContext } from "../handlers.js";
import { openWorkflowStore } from "../workflows/index.js";
import { ledgerDbPath } from "./paths.js";
import { readVault } from "../vault/reader.js";
import { effectiveEvidenceState } from "./evidence-common.js";
import { parseLimit, parseOffset, assertOffsetInRange, buildPagination, DEFAULT_LIMIT } from "./pagination.js";

interface Parsed { note?: string; limit: number; offset: number }
function parseArgs(argv: string[]): Parsed {
  let note: string | undefined, limit = DEFAULT_LIMIT, offset = 0;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === "--limit") limit = parseLimit("evidence review", argv[++i] ?? "");
    else if (a.startsWith("--limit=")) limit = parseLimit("evidence review", a.slice("--limit=".length));
    else if (a === "--offset") offset = parseOffset("evidence review", argv[++i] ?? "");
    else if (a.startsWith("--offset=")) offset = parseOffset("evidence review", a.slice("--offset=".length));
    else if (a.startsWith("-")) throw CliError.usage(`\`evidence review\`: unknown flag ${a}`);
    else if (note === undefined) note = a;
    else throw CliError.usage(`\`evidence review\`: unexpected argument ${a}`);
  }
  return { ...(note !== undefined ? { note } : {}), limit, offset };
}

interface Item { evidenceId: string; noteId: string; state: string; target: "present" | "missing"; detail?: string; updatedAt: string }

async function evidenceReview(ctx: RunContext): Promise<number> {
  const p = parseArgs(ctx.argv);
  const cfg = ctx.config.config;
  const store = openWorkflowStore({ path: ledgerDbPath(ctx) });
  try {
    const repo = new EvidenceRepo(store.db);
    // Read the CURRENT working tree so staleness (on-disk edit) + a gone target are
    // detected at read time — `sourceNoteHash` is compared here, not just stamped.
    const snapshot = await readVault(cfg);
    const noteById = new Map<string, ParsedNote>(snapshot.notes.map((n) => [n.id, n]));

    // Scan ALL rows (scoped to a note when given) + compute effective state so a
    // now-drifted `resolved` row re-surfaces; keep only those effectively needing attention.
    const rows: EvidenceRow[] = p.note !== undefined ? repo.forNote(p.note) : repo.all();
    const attention = rows
      .map((row) => ({ row, eff: effectiveEvidenceState(row, noteById) }))
      .filter((x) => x.eff.state !== "resolved");

    // Deterministic total order: (createdAt desc, id asc).
    attention.sort((a, b) => {
      const ca = a.row.createdAt ?? "";
      const cb = b.row.createdAt ?? "";
      if (ca !== cb) return ca < cb ? 1 : -1;
      return a.row.id < b.row.id ? -1 : a.row.id > b.row.id ? 1 : 0;
    });

    const total = attention.length;
    assertOffsetInRange("evidence review", p.offset, total);
    const page = attention.slice(p.offset, p.offset + p.limit);
    const items: Item[] = page.map((x) => ({
      evidenceId: x.row.id,
      noteId: x.row.noteId ?? "(unknown)",
      state: x.eff.state,
      target: x.eff.target,
      ...(x.eff.detail !== null ? { detail: x.eff.detail } : {}),
      updatedAt: x.row.lastCheckedAt ?? x.row.createdAt ?? "",
    }));

    const out = { command: "evidence review", items, pagination: buildPagination({ limit: p.limit, offset: p.offset }, total, page.length) };
    if (ctx.output.mode === "json") emitJson(out);
    else ctx.render(`evidence review: ${page.length} of ${total} needing attention`);
    return EXIT.OK;
  } finally {
    store.close();
  }
}

registerCommand("evidence review", evidenceReview);

export { evidenceReview, parseArgs };

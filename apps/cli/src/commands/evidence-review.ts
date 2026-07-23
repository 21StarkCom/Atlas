/**
 * `brain evidence review [<note>]` — a paginated, READ-ONLY listing of v2
 * vault-derived evidence needing attention: rows whose `status` is anything other
 * than `resolved` (pending / failed / needs-review), optionally scoped to a single
 * note. Non-mutating, no ledger/audit — reads the flat `evidence` projection only
 * (Phase-4 task 4-4). Each item's `target` is a best-effort read-time resolution of
 * the SOFT `noteId`: a note that no longer resolves surfaces as `target: missing`
 * (eligible for `needs-review`) — never a crash, never silently dropped.
 * Deterministic order (createdAt desc, id tie-break). Output ⇒ `evidence-review.schema.json`.
 */
import { EvidenceRepo, type EvidenceRow } from "@atlas/sqlite-store";
import { CliError, EXIT, emitJson } from "../errors/envelope.js";
import { registerCommand, type RunContext } from "../handlers.js";
import { openWorkflowStore } from "../workflows/index.js";
import { ledgerDbPath } from "./backup-config.js";
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

interface Item { evidenceId: string; noteId: string; state: string; target: "present" | "missing"; updatedAt: string }

/** Map a v2 evidence row's status to the review `state` enum (NULL = not-yet-checked ⇒ pending). */
function stateOf(row: EvidenceRow): string {
  return row.status ?? "pending";
}

async function evidenceReview(ctx: RunContext): Promise<number> {
  const p = parseArgs(ctx.argv);
  const store = openWorkflowStore({ path: ledgerDbPath(ctx) });
  try {
    const repo = new EvidenceRepo(store.db);
    const total = repo.countNeedingAttention(p.note);
    assertOffsetInRange("evidence review", p.offset, total);
    const rows = repo.needingAttention({ ...(p.note !== undefined ? { noteId: p.note } : {}), limit: p.limit, offset: p.offset });

    // Best-effort read-time target resolution: does the soft-referenced note still
    // resolve to a live projection row? A missing note ⇒ target:missing (eligible
    // for needs-review) — never a crash.
    const noteExists = store.db.prepare(`SELECT 1 FROM notes WHERE note_id = ?`);
    const items: Item[] = rows.map((r) => ({
      evidenceId: r.id,
      noteId: r.noteId ?? "(unknown)",
      state: stateOf(r),
      target: r.noteId !== null && noteExists.get(r.noteId) !== undefined ? "present" : "missing",
      updatedAt: r.lastCheckedAt ?? r.createdAt ?? "",
    }));

    const out = { command: "evidence review", items, pagination: buildPagination({ limit: p.limit, offset: p.offset }, total, rows.length) };
    if (ctx.output.mode === "json") emitJson(out);
    else ctx.render(`evidence review: ${rows.length} of ${total} needing attention`);
    return EXIT.OK;
  } finally {
    store.close();
  }
}

registerCommand("evidence review", evidenceReview);

export { evidenceReview, parseArgs };

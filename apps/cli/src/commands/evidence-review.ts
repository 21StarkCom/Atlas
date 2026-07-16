/**
 * `brain evidence review [<note>]` (Task 4.7 / #59) — a paginated, READ-ONLY listing of evidence
 * that needs attention: current heads whose verification is not `valid` (stale / pending / failed
 * re-verification), optionally scoped to a single note. Non-mutating, no audit event. Deterministic
 * order (updatedAt desc, evidenceId tie-break). Output ⇒ `evidence-review.schema.json`.
 */
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

interface Item { evidenceId: string; noteId: string; state: string; updatedAt: string }

async function evidenceReview(ctx: RunContext): Promise<number> {
  const p = parseArgs(ctx.argv);
  const store = openWorkflowStore({ path: ledgerDbPath(ctx) });
  try {
    const scope = p.note !== undefined ? " AND c.owning_note_id = @note" : "";
    const where = `WHERE e.current = 1 AND e.verification != 'valid'${scope}`;
    const params = p.note !== undefined ? { note: p.note } : {};
    const total = (store.db.prepare(`SELECT COUNT(*) AS n FROM claim_evidence e JOIN claims c ON c.claim_id = e.claim_id ${where}`).get(params) as { n: number }).n;
    assertOffsetInRange("evidence review", p.offset, total);
    // Deterministic total order: (updatedAt desc, evidenceId) — created_at is the head's entry time.
    const rows = store.db.prepare(
      `SELECT e.evidence_id AS evidenceId, c.owning_note_id AS noteId, e.verification AS state, e.created_at AS updatedAt
       FROM claim_evidence e JOIN claims c ON c.claim_id = e.claim_id ${where}
       ORDER BY e.created_at DESC, e.evidence_id ASC LIMIT @limit OFFSET @offset`,
    ).all({ ...params, limit: p.limit, offset: p.offset }) as Item[];

    const out = { command: "evidence review", items: rows, pagination: buildPagination({ limit: p.limit, offset: p.offset }, total, rows.length) };
    if (ctx.output.mode === "json") emitJson(out);
    else ctx.render(`evidence review: ${rows.length} of ${total} needing attention`);
    return EXIT.OK;
  } finally {
    store.close();
  }
}

registerCommand("evidence review", evidenceReview);

export { evidenceReview, parseArgs };

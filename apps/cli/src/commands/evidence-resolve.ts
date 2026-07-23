/**
 * `brain evidence resolve <evidenceId>` — v2 DETERMINISTIC reverification (task 4-4).
 * Re-anchors a flat vault-derived evidence row to the CURRENT state of its note:
 *   - the note (and its `evidence:` frontmatter entry) still resolves ⇒ writes
 *     `status: resolved` + a verdict + `lastCheckedAt` into the note frontmatter
 *     through the canonical mutation order (one commit onto `refs/heads/main`, then
 *     re-fold) — `outcome: resolved`, exit 0;
 *   - the note or its entry no longer resolves ⇒ `outcome: target-missing`,
 *     `status: needs-review`, NO mutation, exit 0 (surfaced, never a crash).
 * No renditions, no run ledger, no audit signature (ADR-0003). A dirty target note
 * is refused by the mutation order's dirty-vault gate (exit 2). Missing evidence ⇒
 * not-found (exit 1). Output ⇒ `evidence-resolve.schema.json`.
 */
import { EXIT, emitJson } from "../errors/envelope.js";
import { CliError } from "../errors/envelope.js";
import { registerCommand, type RunContext } from "../handlers.js";
import { mutateEvidence } from "./evidence-common.js";

interface Parsed { evidenceId: string }
function parseArgs(argv: string[]): Parsed {
  let evidenceId: string | undefined;
  for (const a of argv) {
    if (a.startsWith("-")) throw CliError.usage(`\`evidence resolve\`: unknown flag ${a}`);
    else if (evidenceId === undefined) evidenceId = a;
    else throw CliError.usage(`\`evidence resolve\`: unexpected argument ${a}`);
  }
  if (evidenceId === undefined) throw CliError.usage(`\`evidence resolve\`: expected an <evidenceId> argument`);
  return { evidenceId };
}

async function evidenceResolve(ctx: RunContext): Promise<number> {
  const { evidenceId } = parseArgs(ctx.argv);
  const r = await mutateEvidence(ctx, evidenceId, { bumpAttempts: false });
  const out = {
    command: "evidence resolve",
    outcome: r.outcome,
    evidenceId: r.evidenceId,
    noteId: r.noteId,
    status: r.status,
    ...(r.commit !== undefined ? { commit: r.commit } : {}),
  };
  if (ctx.output.mode === "json") emitJson(out);
  else ctx.render(`evidence resolve ${r.evidenceId}: ${r.outcome} (${r.status})`);
  return EXIT.OK;
}

registerCommand("evidence resolve", evidenceResolve);

export { evidenceResolve, parseArgs };

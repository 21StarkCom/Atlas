/**
 * `brain evidence retry <evidenceId>` — v2 SYNCHRONOUS retry (task 4-4). Re-runs the
 * deterministic reverification of `evidence resolve` and, when the target note
 * resolves, ALSO increments the `attempts` counter in the note's `evidence:`
 * frontmatter entry (one commit onto `refs/heads/main`, then re-fold). `attempts`
 * lives in the note (the vault is authority) — there is no jobs queue and no ledger
 * event in v2 (the rendition-coupled `reverify` job was retired). A gone target ⇒
 * `outcome: target-missing`, attempts unchanged, no mutation. Missing evidence ⇒
 * not-found (exit 1). Output ⇒ `evidence-retry.schema.json`.
 */
import { EXIT, emitJson } from "../errors/envelope.js";
import { CliError } from "../errors/envelope.js";
import { registerCommand, type RunContext } from "../handlers.js";
import { mutateEvidence } from "./evidence-common.js";

interface Parsed { evidenceId: string }
function parseArgs(argv: string[]): Parsed {
  let evidenceId: string | undefined;
  for (const a of argv) {
    if (a.startsWith("-")) throw CliError.usage(`\`evidence retry\`: unknown flag ${a}`);
    else if (evidenceId === undefined) evidenceId = a;
    else throw CliError.usage(`\`evidence retry\`: unexpected argument ${a}`);
  }
  if (evidenceId === undefined) throw CliError.usage(`\`evidence retry\`: expected an <evidenceId> argument`);
  return { evidenceId };
}

async function evidenceRetry(ctx: RunContext): Promise<number> {
  const { evidenceId } = parseArgs(ctx.argv);
  const r = await mutateEvidence(ctx, evidenceId, { bumpAttempts: true });
  const out = {
    command: "evidence retry",
    outcome: r.outcome,
    evidenceId: r.evidenceId,
    noteId: r.noteId,
    status: r.status,
    attempts: r.attempts,
    ...(r.commit !== undefined ? { commit: r.commit } : {}),
  };
  if (ctx.output.mode === "json") emitJson(out);
  else ctx.render(`evidence retry ${r.evidenceId}: ${r.outcome} (attempts ${r.attempts})`);
  return EXIT.OK;
}

registerCommand("evidence retry", evidenceRetry);

export { evidenceRetry, parseArgs };

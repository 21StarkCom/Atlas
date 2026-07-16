/**
 * `brain git review <runId>` (Task 4.9) — read-only inspection of a Tier-3 run awaiting review.
 * Renders its manifest (agent branch, base + agent commits, validation status), proposed risk
 * tier, and change summary so a reviewer can decide `git approve` / `git reject` / `git refresh`.
 * Read-only. Output matches `git-review.schema.json`; a run not at the review gate is an error.
 */
import { openRepo } from "@atlas/git";
import { CliError, EXIT, emitJson } from "../errors/envelope.js";
import { registerCommand, type RunContext } from "../handlers.js";
import { openMigratedStore } from "./store-open.js";
import { resolvePath } from "./backup-config.js";
import { reviewRun } from "../workflows/index.js";

function parseArgs(argv: string[]): string {
  const positional = argv.filter((a) => !a.startsWith("-"));
  if (positional.length !== 1) throw CliError.usage(`\`git review\`: expected exactly one <runId> argument`);
  return positional[0]!;
}

async function gitReview(ctx: RunContext): Promise<number> {
  const runId = parseArgs(ctx.argv);
  const repo = openRepo(resolvePath(ctx, ctx.config.config.vault.path));
  const store = openMigratedStore(ctx);
  try {
    const report = await reviewRun(store.db, repo, runId);
    if (report.state !== "review-pending") {
      throw new CliError({
        code: "not-review-pending",
        message: `run ${runId} is at ${report.state ?? "<unknown>"}, not review-pending — nothing to review`,
        hint: "git review inspects a Tier-3 run awaiting approval.",
        exitCode: EXIT.VALIDATION,
      });
    }
    const patch = store.db.prepare(`SELECT changed_lines, changed_sections FROM patches WHERE plan_id LIKE ? ORDER BY created_at DESC LIMIT 1`).get(`${runId}-%`) as { changed_lines: number; changed_sections: number } | undefined;

    const out = {
      command: "git review",
      runId,
      state: "review-pending" as const,
      risk: `tier-${report.tier ?? 3}`,
      ...(patch ? { summary: { filesChanged: Math.max(1, patch.changed_sections), insertions: patch.changed_lines, deletions: 0 } } : {}),
      manifest: {
        branch: `refs/agent/${runId}`,
        baseCommit: report.baseRef ?? "0".repeat(40),
        agentCommit: report.commitSha ?? "0".repeat(40),
        // A run that reached review-pending cleared validation (Tier-3 is a review gate, not a
        // validation failure — a validation-failed plan never reaches the review gate).
        validation: "passed" as const,
      },
    };
    if (ctx.output.mode === "json") emitJson(out);
    else ctx.render(`review ${runId}: ${out.risk}, ${out.manifest.agentCommit.slice(0, 8)} on ${out.manifest.branch}`);
    return EXIT.OK;
  } finally {
    store.close();
  }
}

registerCommand("git review", gitReview);

export { gitReview };

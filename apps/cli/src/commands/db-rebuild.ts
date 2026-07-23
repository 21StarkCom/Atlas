/**
 * `brain db rebuild [--from-git]` (Task 1.9 / #25 — projection-audit wiring).
 *
 * Transactionally rebuilds the vault-projection tables from Markdown (Task 1.4's
 * `rebuildProjections`), replacing only the projection set that exists at this
 * migration frontier and NEVER touching the ledger tables or `db_schema_migrations`
 * (per the committed `db-rebuild.schema.json`). Runs under the exclusive
 * `vault-maintenance` lock; a crash mid-rebuild leaves the prior projection
 * readable (the rebuild is one transaction).
 *
 * v2 (#334, ADR-0003): the `run.projection` audit event + mandatory covering
 * backup are retired with the audit machinery; the transactional rebuild itself
 * is the whole command. The underlying engine is `@atlas/sqlite-store`'s
 * `rebuildProjections` (strict) / the CLI's `rebuildFromGit` (DR, gaps-not-throws).
 */
import { rebuildProjections, SnapshotHasErrorsError, DanglingLinkError, type RebuildReport } from "@atlas/sqlite-store";
import type { VaultSnapshot } from "@atlas/contracts";
import { readVault } from "../vault/reader.js";
import { CliError, EXIT, emitJson } from "../errors/envelope.js";
import { registerCommand, type RunContext } from "../handlers.js";
import { openMigratedStore } from "./store-open.js";
import { rebuildFromGit, type FromGitGap } from "../workflows/rebuild-from-git.js";

function parseArgs(argv: string[]): { fromGit: boolean } {
  let fromGit = false;
  for (const a of argv) {
    if (a === "--from-git") fromGit = true;
    else throw CliError.usage(`unknown flag/argument for \`db rebuild\`: ${a}`);
  }
  return { fromGit };
}

interface RebuildOutput {
  command: "db rebuild";
  rebuilt: { table: string; rows: number }[];
  durationMs: number;
  fromGit?: boolean;
  gaps?: FromGitGap[];
}

async function dbRebuild(ctx: RunContext): Promise<number> {
  const { fromGit } = parseArgs(ctx.argv);

  return ctx.withLock("vault-maintenance", async () => {
    // Read the vault snapshot INSIDE the lock (round-2 finding): reading it before
    // acquiring `vault-maintenance` let a mutation commit in between, so the rebuild
    // could replace projections from a stale snapshot. Under the lock no writer can
    // move the vault while we snapshot → rebuild.
    let snapshot: VaultSnapshot;
    try {
      snapshot = await readVault(ctx.config.config);
    } catch (e) {
      throw new CliError({
        code: "vault-error",
        message: `cannot read vault: ${e instanceof Error ? e.message : String(e)}`,
        hint: "Check that vault.path in brain.config.yaml exists and is readable.",
        exitCode: EXIT.CONFIG,
        cause: e,
      });
    }

    // Require an EXISTING migrated ledger — `db rebuild` must NEVER create the DB
    // or apply DDL / touch db_schema_migrations (round-2 finding F5); that is
    // `db migrate`'s job. A projection rebuild only replaces projection rows.
    const store = openMigratedStore(ctx);

    try {
      const started = Date.now();
      let report: RebuildReport | undefined;
      // --from-git (DR): best-effort rebuild that surfaces gaps instead of throwing. The gaps
      // are captured here so they land in the output even though the fold ran inside finalize.
      let gaps: FromGitGap[] | undefined;
      let fromGitRebuilt: { notes: number; identityKeys: number; links: number } | undefined;

      // v2 (#334): the run.projection audit event + covering backup are retired
      // (ADR-0003). The rebuild itself stays transactional — rebuildProjections /
      // rebuildFromGit replace the projection set in ONE SQLite transaction, so a
      // failure (snapshot errors / dangling link) still rolls back to the prior
      // readable projection.
      try {
        if (fromGit) {
          const r = rebuildFromGit(store.db, snapshot);
          gaps = [...r.gaps];
          fromGitRebuilt = r.rebuilt;
        } else {
          report = rebuildProjections(store.db, snapshot, { now: () => new Date().toISOString().replace(/\.\d{3}Z$/, "Z") });
        }
      } catch (e) {
        // Surface a rebuild-specific failure (snapshot errors / dangling link)
        // with its own code. (--from-git never reaches here for those — gaps.)
        const cause = e instanceof CliError ? e.cause : e;
        if (cause instanceof SnapshotHasErrorsError || cause instanceof DanglingLinkError) {
          throw new CliError({
            code: "rebuild-failed",
            message: `projection rebuild failed and was rolled back: ${cause.message}`,
            hint: "Fix the vault issues surfaced by `brain validate`, then retry (or use --from-git to rebuild the clean subset and surface the rest as gaps).",
            exitCode: EXIT.INTERNAL,
            cause,
          });
        }
        throw e;
      }
      const durationMs = Date.now() - started;

      if (fromGit) {
        if (fromGitRebuilt === undefined || gaps === undefined) {
          throw new CliError({ code: "rebuild-failed", message: "from-git rebuild did not execute", exitCode: EXIT.INTERNAL });
        }
        ctx.log.info("db.rebuild", { fromGit: true, notes: fromGitRebuilt.notes, links: fromGitRebuilt.links, gaps: gaps.length, runId: ctx.runId });
        const out: RebuildOutput = {
          command: "db rebuild",
          rebuilt: [
            { table: "notes", rows: fromGitRebuilt.notes },
            { table: "note_identity_keys", rows: fromGitRebuilt.identityKeys },
            { table: "note_links", rows: fromGitRebuilt.links },
          ],
          durationMs,
          fromGit: true,
          gaps,
        };
        if (ctx.output.mode === "json") emitJson(out);
        else ctx.render(`db rebuild --from-git — ${fromGitRebuilt.notes} note(s), ${fromGitRebuilt.links} link(s), ${gaps.length} gap(s) in ${durationMs}ms`);
        return EXIT.OK;
      }

      if (report === undefined) {
        // Defensive: the strict branch must have produced a report.
        throw new CliError({
          code: "rebuild-failed",
          message: "projection rebuild did not execute",
          exitCode: EXIT.INTERNAL,
        });
      }
      ctx.log.info("db.rebuild", { notes: report.notes, links: report.links, runId: ctx.runId });

      const out: RebuildOutput = {
        command: "db rebuild",
        rebuilt: [
          { table: "notes", rows: report.notes },
          { table: "note_identity_keys", rows: report.identityKeys },
          { table: "note_links", rows: report.links },
          { table: "vault_schema_migrations", rows: report.schemaVersions },
        ],
        durationMs,
      };

      if (ctx.output.mode === "json") emitJson(out);
      else ctx.render(`db rebuild — ${report.notes} note(s), ${report.links} link(s) in ${durationMs}ms`);
      return EXIT.OK;
    } finally {
      store.close();
    }
  });
}

registerCommand("db rebuild", dbRebuild);

export { dbRebuild };

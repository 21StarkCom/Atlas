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
 * As an executed projection-only command it appends EXACTLY ONE terminal
 * `run.projection` audit event (via {@link runReadAudit} → `finalizeLedgerWrite`,
 * §2.8) — wired here so the Phase-1 projection-only command is audited from day
 * one. Unlike a Tier-0 read, a projection rebuild is a real state change, so it is
 * NOT backup-coalesced: it takes its mandatory covering backup like any write run.
 *
 * NB: the projection-audit wiring for `db rebuild` lives with this task (#25) per
 * the plan's Task 1.9 ("`db rebuild` … wired here"); the underlying rebuild engine
 * is owned by Task 1.4 (`@atlas/sqlite-store`).
 */
import { rebuildProjections, SnapshotHasErrorsError, DanglingLinkError, type RebuildReport } from "@atlas/sqlite-store";
import type { VaultSnapshot } from "@atlas/contracts";
import { readVault } from "../vault/reader.js";
import { CliError, EXIT, emitJson } from "../errors/envelope.js";
import { registerCommand, type RunContext } from "../handlers.js";
import { openMigratedStore } from "./store-open.js";
import { runReadAudit, assertReadAuditReady } from "../audit/readonly.js";

function parseArgs(argv: string[]): void {
  for (const a of argv) {
    if (a === "--from-git") {
      // --from-git contracts an audit-ref fold + ledger reconstruction that is
      // owned by a LATER phase (Phase 2 disaster-recovery); it is not implemented
      // here. Rather than accept it and report a FALSE success (round-2 finding
      // F4), reject it explicitly until its owning phase lands.
      throw new CliError({
        code: "unsupported",
        message: "`db rebuild --from-git` is not supported yet",
        hint: "The from-git audit-ref fold / ledger reconstruction is owned by a later phase. Run `db rebuild` (rebuild projections from Markdown) without --from-git.",
        exitCode: EXIT.USAGE,
      });
    }
    throw CliError.usage(`unknown flag/argument for \`db rebuild\`: ${a}`);
  }
}

interface RebuildOutput {
  command: "db rebuild";
  rebuilt: { table: string; rows: number }[];
  durationMs: number;
}

async function dbRebuild(ctx: RunContext): Promise<number> {
  parseArgs(ctx.argv);

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

  return ctx.withLock("vault-maintenance", async () => {
    // Require an EXISTING migrated ledger — `db rebuild` must NEVER create the DB
    // or apply DDL / touch db_schema_migrations (round-2 finding F5); that is
    // `db migrate`'s job. A projection rebuild only replaces projection rows.
    const store = openMigratedStore(ctx);

    try {
      // Fast PRE-FLIGHT gate (round-2 finding F2): refuse up-front with a clear
      // error if the audit clearly cannot land — custody missing, watermark blocked,
      // or broker unreachable. This is UX-only; correctness no longer rests on it
      // (round-3 finding 2 — the readiness probe was TOCTOU). The load-bearing
      // guarantee is below: the projection replacement is committed ATOMICALLY with
      // the `run.projection` audit event INSIDE the §2.8 transaction, so an audit
      // failure rolls the projection back rather than leaving it changed.
      await assertReadAuditReady(ctx, store);

      const started = Date.now();
      let report: RebuildReport | undefined;

      // The projection rebuild runs INSIDE finalize's step-3 transaction (as
      // `extraCommit`), atomically with the `run.projection` audit row. A rebuild
      // failure (snapshot errors / dangling link) throws here → the whole §2.8
      // transaction rolls back → the prior projection stays readable AND no audit
      // event is committed. `strictBackup` makes an exhausted covering-backup THROW
      // rather than silently blocking, so a rebuild never reports exit 0 without a
      // covering backup (round-3 finding 2). NOT backup-coalesced — a projection is
      // a real state change.
      let audit;
      try {
        audit = await runReadAudit(ctx, "run.projection", "db rebuild", store, {
          extraCommit: (db) => {
            report = rebuildProjections(db, snapshot, { now: () => new Date().toISOString().replace(/\.\d{3}Z$/, "Z") });
          },
          strictBackup: true,
        });
      } catch (e) {
        // Surface a rebuild-specific failure (snapshot errors / dangling link) with
        // its own code, even though it propagated through the audit orchestrator.
        const cause = e instanceof CliError ? e.cause : e;
        if (cause instanceof SnapshotHasErrorsError || cause instanceof DanglingLinkError) {
          throw new CliError({
            code: "rebuild-failed",
            message: `projection rebuild failed and was rolled back: ${cause.message}`,
            hint: "Fix the vault issues surfaced by `brain inspect`, then retry.",
            exitCode: EXIT.INTERNAL,
            cause,
          });
        }
        throw e;
      }
      if (report === undefined) {
        // Defensive: finalize returned without running the step-3 commit closure.
        throw new CliError({
          code: "rebuild-failed",
          message: "projection rebuild did not execute inside the audit transaction",
          exitCode: EXIT.INTERNAL,
        });
      }
      const durationMs = Date.now() - started;
      ctx.log.info("db.rebuild", { notes: report.notes, links: report.links, audited: audit.recorded, runId: audit.runId });

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

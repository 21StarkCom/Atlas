/**
 * `brain db migrate` (Task 1.4 engine / Task 2.7 composition root) — the SHARED
 * migration composition root.
 *
 * This is the ONE command that CREATES the ledger and applies pending DDL. It opens
 * the store, registers EVERY feature-owned migration through
 * {@link registerFeatureMigrations} — `0002_jobs` (`@atlas/jobs`) and
 * `0006_workflow_idempotency` (workflows) — BEFORE `store.migrate()`, so `db migrate`
 * discovers them via the normal checksum-guarded, gap-tolerant runner (plan §2.7 /
 * Review-Hint: "registerJobsMigration must run at the composition root before
 * store.migrate() — no undiscoverable migration"). Because feature migrations are
 * registered HERE rather than in `openStore`'s default set, `db.migrate-ownership`'s
 * fresh-DB diff (a bare `openStore`) stays exactly the §2.7 core/provenance/claims set.
 *
 * Runs under the exclusive `vault-maintenance` lock (`db-migrate.schema.json`), is
 * intrinsically idempotent (an already-applied migration is a checksum-verified
 * no-op), and never drops tables on downgrade. Every OTHER ledger command opens an
 * ALREADY-migrated store (`openMigratedStore`) and never applies DDL.
 */
import { openStore, MigrationChecksumError, type MigrationReport } from "@atlas/sqlite-store";
import { CliError, EXIT, emitJson } from "../errors/envelope.js";
import { registerCommand, type RunContext } from "../handlers.js";
import { ledgerDbPath } from "./paths.js";
import { registerFeatureMigrations } from "./store-open.js";

function parseArgs(argv: string[]): void {
  for (const a of argv) throw CliError.usage(`unknown flag/argument for \`db migrate\`: ${a}`);
}

interface MigrateOutput {
  command: "db migrate";
  head: string;
  applied: { id: string; checksum: string }[];
  alreadyApplied: string[];
}

/** The highest applied migration id after the run (lexicographic max over all applied). */
function head(report: MigrationReport): string {
  return report.applied.map((a) => a.id).sort((x, y) => (x < y ? -1 : x > y ? 1 : 0)).at(-1) ?? "";
}

async function dbMigrate(ctx: RunContext): Promise<number> {
  parseArgs(ctx.argv);

  return ctx.withLock("vault-maintenance", () => {
    // The sole creator/migrator of the ledger: open (creating the file if absent),
    // register every feature migration BEFORE migrate, then apply the pending set.
    const store = openStore({ path: ledgerDbPath(ctx) });
    try {
      registerFeatureMigrations(store); // BEFORE migrate() — composition-root ordering
      let report: MigrationReport;
      try {
        report = store.migrate();
      } catch (e) {
        // A changed migration body vs the recorded checksum is a hard, non-retryable
        // failure (exit 1) — never a silent overwrite.
        if (e instanceof MigrationChecksumError) {
          throw new CliError({
            code: "migration-checksum-mismatch",
            message: e.message,
            hint: "A migration body must never change after it is applied; revert the DDL or supersede it with a new migration.",
            exitCode: EXIT.VALIDATION,
            cause: e,
          });
        }
        // Any other failure rolled the migration transaction back (all-or-nothing).
        throw new CliError({
          code: "migration-failed",
          message: `migration failed and was rolled back: ${e instanceof Error ? e.message : String(e)}`,
          exitCode: EXIT.INTERNAL,
          cause: e,
        });
      }

      const applied = report.applied
        .filter((a) => a.action === "applied")
        .map((a) => ({ id: a.id, checksum: a.checksum }));
      const alreadyApplied = report.applied.filter((a) => a.action === "skipped").map((a) => a.id);
      const out: MigrateOutput = { command: "db migrate", head: head(report), applied, alreadyApplied };

      ctx.log.info("db.migrate", { head: out.head, applied: applied.length, alreadyApplied: alreadyApplied.length });
      if (ctx.output.mode === "json") emitJson(out);
      else ctx.render(`db migrate — head ${out.head}, ${applied.length} applied, ${alreadyApplied.length} up-to-date`);
      return EXIT.OK;
    } finally {
      store.close();
    }
  });
}

registerCommand("db migrate", dbMigrate);

export { dbMigrate };

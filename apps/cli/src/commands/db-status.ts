/**
 * `brain db status` (Task 1.x) — read-only SQLite store status: the applied migration head + full
 * applied list, per-table row counts, and the backup-watermark health. PURE diagnostic (no ledger
 * write, no lock, no audit) and — unlike a ledger-writing read — it stays AVAILABLE in the
 * backup-unhealthy blocked mode, so an operator can always inspect a blocked store. A fresh/
 * unmigrated DB reports an empty head + no tables. Output ⇒ `db-status.schema.json`.
 */
import { openStore, watermarkHealth, type SqliteDatabase } from "@atlas/sqlite-store";
import { EXIT, emitJson } from "../errors/envelope.js";
import { registerCommand, type RunContext } from "../handlers.js";
import { ledgerDbPath } from "./backup-config.js";

function tableExists(db: SqliteDatabase, name: string): boolean {
  return db.prepare(`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?`).get(name) !== undefined;
}

async function dbStatus(ctx: RunContext): Promise<number> {
  const store = openStore({ path: ledgerDbPath(ctx) });
  try {
    const db = store.db;

    // Schema: the applied migration ids (sorted); head = the highest applied (empty on a fresh DB).
    const applied = tableExists(db, "db_schema_migrations")
      ? (db.prepare(`SELECT id FROM db_schema_migrations ORDER BY id ASC`).all() as { id: string }[]).map((r) => r.id)
      : [];
    const head = applied.length > 0 ? applied[applied.length - 1]! : "";

    // Per-table row counts over the real (non-internal) tables, name-sorted for determinism.
    const names = (db.prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name ASC`).all() as { name: string }[]).map((r) => r.name);
    const tables = names.map((name) => ({ name, rowCount: (db.prepare(`SELECT COUNT(*) AS n FROM "${name}"`).get() as { n: number }).n }));

    // Backup watermark health — reported even in the blocked state (never gates this read).
    const backup = tableExists(db, "backup_watermark")
      ? (() => {
          const h = watermarkHealth(db);
          // watermarkHealth reports -1 for "no ledger events yet"; the status contract is a
          // non-negative count, so clamp the empty-ledger sentinel to 0.
          return { watermarkSeq: Math.max(0, h.seq), coveredSeq: Math.max(0, h.coveredSeq), healthy: h.healthy };
        })()
      : { watermarkSeq: 0, coveredSeq: 0, healthy: true };

    const out = { command: "db status", schema: { head, applied }, tables, backup };
    if (ctx.output.mode === "json") emitJson(out);
    else ctx.render(`db status — schema ${head || "(fresh)"}, ${tables.length} table(s), backup ${backup.healthy ? "healthy" : "BLOCKED"} (${backup.coveredSeq}/${backup.watermarkSeq})`);
    return EXIT.OK;
  } finally {
    store.close();
  }
}

registerCommand("db status", dbStatus);

export { dbStatus };

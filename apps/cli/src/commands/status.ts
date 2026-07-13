/**
 * `brain status` (Task 1.9 / #25) — the read-only live-state summary (design D12).
 *
 * Reports: open runs by workflow state, queued/failed job counts, the quarantine
 * count, backup watermark health (watermark seq vs covered seq + healthy flag),
 * and the audit head + WORM-anchor reconciliation. As an executed Tier-0 read it
 * appends exactly one terminal `run.readonly` audit event (via {@link runReadAudit}
 * → `finalizeLedgerWrite`, §2.8) with read-run backup coalescing.
 *
 * The pure summary stays available even when the audit path is down: if the broker
 * is unreachable, the ledger is unavailable, or the backup watermark is BLOCKED,
 * the run degrades to non-persisting and the summary still prints (per the
 * committed `status.schema.json`). Phase-1 tables that do not exist yet (`jobs`
 * → 0002, quarantine → later) are read defensively as zero, so `status` is correct
 * at every migration frontier.
 */
import { watermarkHealth, type SqliteDatabase } from "@atlas/sqlite-store";
import { BrokerClient } from "@atlas/broker";
import { CliError, EXIT, emitJson } from "../errors/envelope.js";
import { registerCommand, type RunContext } from "../handlers.js";
import { openMigratedStore } from "./store-open.js";
import { runReadAudit } from "../audit/readonly.js";
import { verifyAuditAnchor, type AuditChainProbe } from "../audit/anchor-check.js";

/** The terminal workflow states (§2.5) — every OTHER state counts as an open run. */
const TERMINAL_STATES: ReadonlySet<string> = new Set([
  "finalized",
  "rejected",
  "rolled-back",
  "failed",
  "cancelled",
]);

interface StatusOutput {
  command: "status";
  openRuns: Record<string, number>;
  jobs: { queued: number; failed: number };
  quarantineCount: number;
  backup: { watermarkSeq: number; coveredSeq: number; healthy: boolean };
  audit: { headSeq: number; head: string; anchorOk: boolean; anchorSource: "git" | "sqlite-only" };
}

function parseArgs(argv: string[]): void {
  for (const a of argv) throw CliError.usage(`unknown flag/argument for \`status\`: ${a}`);
}

function tableExists(db: SqliteDatabase, name: string): boolean {
  return db.prepare(`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?`).get(name) !== undefined;
}

/**
 * The count of quarantined notes. The `notes` projection carries a `quarantined`
 * flag from `0001_core` (dictionary §), so the D12 summary reports the real count
 * rather than a placeholder. Guarded by `tableExists` so a pre-migration DB (no
 * `notes` table yet) reports 0 instead of throwing.
 */
function quarantineCount(db: SqliteDatabase): number {
  if (!tableExists(db, "notes")) return 0;
  const r = db.prepare(`SELECT COUNT(*) AS n FROM notes WHERE quarantined = 1`).get() as { n: number };
  return r.n;
}

/** Non-terminal `agent_runs` grouped by state; `{}` when there are none. */
function openRuns(db: SqliteDatabase): Record<string, number> {
  const rows = db.prepare(`SELECT status, COUNT(*) AS n FROM agent_runs GROUP BY status`).all() as {
    status: string;
    n: number;
  }[];
  const out: Record<string, number> = {};
  for (const r of rows) {
    if (!TERMINAL_STATES.has(r.status)) out[r.status] = r.n;
  }
  return out;
}

/** Queued/failed jobs — 0/0 until the `0002_jobs` migration lands (Phase 2). */
function jobCounts(db: SqliteDatabase): { queued: number; failed: number } {
  if (!tableExists(db, "jobs")) return { queued: 0, failed: 0 };
  const q = db.prepare(`SELECT COUNT(*) AS n FROM jobs WHERE state IN ('pending','ready','running')`).get() as {
    n: number;
  };
  const f = db.prepare(`SELECT COUNT(*) AS n FROM jobs WHERE state = 'failed'`).get() as { n: number };
  return { queued: q.n, failed: f.n };
}

async function status(ctx: RunContext): Promise<number> {
  parseArgs(ctx.argv);

  // Read-only surface: require an ALREADY-migrated ledger — `status` must never
  // create the DB or apply DDL (round-2 finding F5). `openMigratedStore` throws a
  // mapped `db-unavailable` CliError when absent/unmigrated.
  const store = openMigratedStore(ctx);

  try {
    const wm = watermarkHealth(store.db);
    // Verify the ACTUAL audit ref via the broker's read-only interface (round-3
    // finding 1), falling back to the SQLite-only structural check if the broker
    // is unreachable. Connected best-effort — a down broker never fails `status`.
    let probe: BrokerClient | null = null;
    try {
      probe = await BrokerClient.connect(ctx.config.config.broker.socket_path);
    } catch {
      probe = null;
    }
    let anchor;
    try {
      anchor = await verifyAuditAnchor(store.db, ctx.config.config.git.audit_anchor_path, ctx.env, probe as AuditChainProbe | null);
    } finally {
      probe?.close();
    }
    const out: StatusOutput = {
      command: "status",
      openRuns: openRuns(store.db),
      jobs: jobCounts(store.db),
      quarantineCount: quarantineCount(store.db),
      backup: {
        // The subsystem uses −1 as the "nothing covered" sentinel; the committed
        // schema requires seq/coveredSeq ≥ 0, so clamp for the summary surface.
        watermarkSeq: Math.max(0, wm.seq),
        coveredSeq: Math.max(0, wm.coveredSeq),
        healthy: wm.healthy,
      },
      audit: {
        headSeq: anchor.headSeq,
        head: anchor.head,
        anchorOk: anchor.ok,
        // Surface WHICH chain was verified: a bare anchorOk:true hides that the
        // authoritative protected ref may never have been checked (broker down →
        // "sqlite-only"). A viewer must be able to distinguish a fully-verified
        // "git" verdict from a degraded structural-only one.
        anchorSource: anchor.source,
      },
    };

    // Best-effort Tier-0 audit — reuse THIS store so we don't open a second handle.
    const audit = await runReadAudit(ctx, "run.readonly", "status", store);
    ctx.log.info("status", { openRuns: Object.keys(out.openRuns).length, audited: audit.recorded, runId: audit.runId });

    if (ctx.output.mode === "json") {
      emitJson(out);
    } else {
      ctx.render(
        `status — watermark seq ${out.backup.watermarkSeq} (covered ${out.backup.coveredSeq}, healthy: ${out.backup.healthy}); ` +
          `audit head seq ${out.audit.headSeq} (anchor ${out.audit.anchorOk ? "ok" : "MISMATCH"}` +
          `${out.audit.anchorSource === "sqlite-only" ? ", UNVERIFIED: broker unavailable, sqlite-only" : ""})`,
      );
    }
    return EXIT.OK;
  } finally {
    store.close();
  }
}

registerCommand("status", status);

export { status };

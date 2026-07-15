/**
 * `graduation/audit` — the read-only bootstrap audit (Task 5.2 / #58). Before a copied vault
 * is graduated, its ledger state is verified through the AUTHORITATIVE read-only surfaces — the
 * broker's live audit-chain verdict, the backup watermark, and the open-run census — so a
 * partially-migrated or tampered copy is caught before any privileged graduation step runs.
 * Purely read-only + fail-closed: any unhealthy signal makes the whole audit `ok: false`.
 */
import { watermarkHealth, type SqliteDatabase, type WatermarkHealth } from "@atlas/sqlite-store";

/** The broker's read-only audit-chain health verdict (mirrors `BrokerClient.getAuditChainStatus`). */
export interface AuditChainStatus {
  readonly ok: boolean;
  readonly head: string;
  readonly count: number;
  readonly detail?: string;
}

/** The aggregated bootstrap-audit report. */
export interface GraduationAuditReport {
  /** `true` iff EVERY checked signal is healthy — the only state that permits graduation. */
  readonly ok: boolean;
  readonly auditChain: AuditChainStatus;
  readonly backup: WatermarkHealth;
  /** Count of runs that are neither finalized nor terminal (must be zero to graduate cleanly). */
  readonly openRuns: number;
  /** Human-readable reasons the audit is not ok (empty iff ok). */
  readonly blockers: readonly string[];
}

/** Count runs still in flight (not finalized and not a terminal state). */
function openRunCount(db: SqliteDatabase): number {
  const row = db
    .prepare(
      `SELECT COUNT(*) AS n FROM agent_runs
        WHERE status NOT IN ('finalized','rejected','rolled-back','failed','cancelled')`,
    )
    .get() as { n: number };
  return row.n;
}

/**
 * Run the read-only bootstrap audit over a copied vault's ledger. `auditChain` is the broker's
 * AUTHORITATIVE live-chain verdict (injected — the broker owns `refs/audit/runs`), verified
 * against the SQLite-side backup watermark + open-run census. Fail-closed: an unhealthy chain,
 * a blocked/unhealthy backup, or any open run blocks graduation with named blockers.
 */
export function graduationAudit(db: SqliteDatabase, auditChain: AuditChainStatus): GraduationAuditReport {
  const backup = watermarkHealth(db);
  const openRuns = openRunCount(db);
  const blockers: string[] = [];
  if (!auditChain.ok) blockers.push(`audit chain unhealthy: ${auditChain.detail ?? "broken"}`);
  if (!backup.healthy) blockers.push(`backup watermark unhealthy (covered ${backup.coveredSeq} of ${backup.seq})`);
  if (openRuns > 0) blockers.push(`${openRuns} run(s) still in flight (must reach a terminal/finalized state before graduation)`);
  return { ok: blockers.length === 0, auditChain, backup, openRuns, blockers };
}

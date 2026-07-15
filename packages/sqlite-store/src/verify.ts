/**
 * `verify` — `atlas db verify`: the invariant-validation queries (dictionary §7)
 * plus the versioned index contract's query-plan (EQP) assertions (§6).
 *
 * Both suites are **table-aware**: a query/assertion that references a table not
 * yet created (jobs → `0002`, claims/provenance → `0003`/`0004`) is skipped, so
 * `verify` is correct at every migration frontier. In this package's frontier
 * (`0001_core` only) it exercises invariant §7.1 (one slug per note) + §7.7
 * (audit terminal cardinality) and the six §6 assertions whose tables/indexes
 * `0001_core` owns.
 */
import type { SqliteDatabase } from "./connection.js";

/** A single invariant violation (the offending key + which invariant). */
export interface InvariantViolation {
  readonly invariant: string;
  readonly detail: string;
}

/** A single query-plan assertion failure. */
export interface QueryPlanViolation {
  readonly pattern: string;
  readonly plan: string;
}

/** The `db verify` result. `ok` iff both violation lists are empty. */
export interface VerifyReport {
  readonly ok: boolean;
  readonly invariantViolations: readonly InvariantViolation[];
  readonly queryPlanViolations: readonly QueryPlanViolation[];
  /** Invariants/assertions skipped because their table did not exist yet. */
  readonly skipped: readonly string[];
}

function tableExists(db: SqliteDatabase, name: string): boolean {
  return (
    db
      .prepare(`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?`)
      .get(name) !== undefined
  );
}

interface InvariantSpec {
  readonly name: string;
  readonly tables: readonly string[];
  readonly sql: string;
}

/** The §7 invariant queries; each is a violation if it returns any row. */
const INVARIANTS: readonly InvariantSpec[] = [
  {
    name: "one-slug-per-note",
    tables: ["notes", "note_identity_keys"],
    sql: `SELECT n.note_id FROM notes n
      LEFT JOIN (SELECT note_id, COUNT(*) c FROM note_identity_keys WHERE kind='slug' GROUP BY note_id) k
        ON k.note_id = n.note_id
      WHERE COALESCE(k.c, 0) <> 1;`,
  },
  {
    name: "no-dangling-evidence-rendition",
    tables: ["claim_evidence", "source_renditions"],
    sql: `SELECT e.evidence_id FROM claim_evidence e
      LEFT JOIN source_renditions r
        ON r.raw_content_hash = e.raw_content_hash AND r.canonical_media_type = e.canonical_media_type
       AND r.extractor_version = e.extractor_version AND r.normalizer_version = e.normalizer_version
      WHERE r.raw_content_hash IS NULL;`,
  },
  {
    name: "note-sources-renditions-resolve",
    tables: ["note_sources", "source_renditions"],
    sql: `SELECT s.note_id FROM note_sources s
      LEFT JOIN source_renditions r
        ON r.raw_content_hash = s.raw_content_hash AND r.canonical_media_type = s.canonical_media_type
       AND r.extractor_version = s.extractor_version AND r.normalizer_version = s.normalizer_version
      WHERE s.extractor_version IS NOT NULL AND r.raw_content_hash IS NULL;`,
  },
  {
    name: "one-current-evidence-head-per-lineage",
    tables: ["claim_evidence"],
    sql: `SELECT lineage_id, SUM(current) AS current_heads
      FROM claim_evidence
      GROUP BY lineage_id
      HAVING SUM(current) <> 1;`,
  },
  {
    name: "active-rendition-consistency",
    tables: ["content_blobs", "source_renditions"],
    sql: `SELECT b.raw_content_hash FROM content_blobs b
      LEFT JOIN source_renditions r
        ON r.raw_content_hash = b.raw_content_hash AND r.canonical_media_type = b.canonical_media_type
       AND r.extractor_version = b.active_extractor_version AND r.normalizer_version = b.active_normalizer_version
      WHERE b.active_extractor_version IS NOT NULL AND r.raw_content_hash IS NULL;`,
  },
  {
    name: "effective-staleness",
    tables: ["claim_evidence", "content_blobs"],
    sql: `SELECT e.evidence_id FROM claim_evidence e
      JOIN content_blobs b
        ON b.raw_content_hash = e.raw_content_hash AND b.canonical_media_type = e.canonical_media_type
      WHERE e.current = 1
        AND (e.extractor_version <> b.active_extractor_version OR e.normalizer_version <> b.active_normalizer_version)
        AND e.verification = 'valid';`,
  },
  {
    // The closed set of terminal audit-event types (plan §2.5 audit SSOT): the
    // workflow terminals PLUS the read-class terminals `run.readonly` (an executed
    // Tier-0 read — `inspect`/`status`/`query`, Task 1.9/3.4) and `run.projection`
    // (an executed projection rebuild, Task 1.9/3.5). Cardinality is "each terminal
    // event type exactly once per run". A `finalized` agent_run is therefore covered
    // by ANY terminal event — including `run.readonly` (the audited-read shape
    // `brain query` uses: a `finalized` retrieve run whose sole terminal is one
    // `run.readonly`, no workflow install event). Real workflow runs still carry
    // their own install/reject terminal, so recognizing the read-class kinds never
    // weakens them.
    name: "audit-terminal-event-cardinality",
    tables: ["audit_events", "agent_runs"],
    sql: `SELECT run_id, 'duplicate:' || event_type AS issue
      FROM audit_events
      WHERE event_type IN ('run.integrated','run.rejected','run.rolled_back','run.failed','run.cancelled','run.readonly','run.projection')
      GROUP BY run_id, event_type HAVING COUNT(*) > 1
      UNION ALL
      SELECT r.run_id, 'missing-terminal-event' AS issue
      FROM agent_runs r
      WHERE r.status IN ('finalized','rejected','rolled-back','failed','cancelled')
        AND NOT EXISTS (
          SELECT 1 FROM audit_events e
          WHERE e.run_id = r.run_id
            AND e.event_type IN ('run.integrated','run.rejected','run.rolled_back','run.failed','run.cancelled','run.readonly','run.projection'));`,
  },
];

interface QueryPlanSpec {
  readonly pattern: string;
  readonly table: string;
  /** The index that MUST appear in the plan; `null` = the table's PK (autoindex). */
  readonly index: string | null;
  readonly sql: string;
  readonly params: readonly unknown[];
}

/** The §6 index-contract EQP assertions (each must be a SEARCH, never a SCAN). */
const QUERY_PLANS: readonly QueryPlanSpec[] = [
  {
    pattern: "jobs-eligibility",
    table: "jobs",
    index: "idx_jobs_eligibility",
    sql: `SELECT job_id FROM jobs WHERE state = ? AND (next_run_at IS NULL OR next_run_at <= ?) ORDER BY next_run_at`,
    params: ["pending", "2026-01-01T00:00:00Z"],
  },
  {
    pattern: "note-links-forward",
    table: "note_links",
    index: null,
    sql: `SELECT target_note_id FROM note_links WHERE source_note_id = ?`,
    params: ["n1"],
  },
  {
    pattern: "note-links-reverse",
    table: "note_links",
    index: "idx_note_links_reverse",
    sql: `SELECT source_note_id FROM note_links WHERE target_note_id = ?`,
    params: ["n1"],
  },
  {
    pattern: "agent-runs-by-status",
    table: "agent_runs",
    index: "idx_agent_runs_status",
    sql: `SELECT run_id FROM agent_runs WHERE status = ?`,
    params: ["planned"],
  },
  {
    pattern: "identity-resolution",
    table: "note_identity_keys",
    index: null,
    sql: `SELECT note_id FROM note_identity_keys WHERE normalized_key = ?`,
    params: ["k"],
  },
  {
    pattern: "notes-needs-index",
    table: "notes",
    index: "idx_notes_needs_index",
    sql: `SELECT note_id FROM notes WHERE active_generation < ?`,
    params: [1],
  },
  {
    pattern: "audit-by-run",
    table: "audit_events",
    index: "idx_audit_events_run",
    sql: `SELECT seq FROM audit_events WHERE run_id = ?`,
    params: ["r1"],
  },
];

interface EqpRow {
  readonly detail: string;
}

/** Run the query-plan assertions for the tables that exist. */
export function checkQueryPlans(db: SqliteDatabase): {
  violations: QueryPlanViolation[];
  skipped: string[];
} {
  const violations: QueryPlanViolation[] = [];
  const skipped: string[] = [];
  for (const spec of QUERY_PLANS) {
    if (!tableExists(db, spec.table)) {
      skipped.push(`query-plan:${spec.pattern}`);
      continue;
    }
    const rows = db.prepare(`EXPLAIN QUERY PLAN ${spec.sql}`).all(...spec.params) as EqpRow[];
    const plan = rows.map((r) => r.detail).join(" | ");
    const usesSearch = /\bSEARCH\b/.test(plan);
    const scansTarget = new RegExp(`\\bSCAN ${spec.table}\\b`).test(plan);
    const usesIndex = spec.index === null ? true : plan.includes(spec.index);
    if (!usesSearch || scansTarget || !usesIndex) {
      violations.push({ pattern: spec.pattern, plan });
    }
  }
  return { violations, skipped };
}

/** Run every applicable invariant query + query-plan assertion. */
export function verify(db: SqliteDatabase): VerifyReport {
  const invariantViolations: InvariantViolation[] = [];
  const skipped: string[] = [];

  for (const inv of INVARIANTS) {
    if (!inv.tables.every((t) => tableExists(db, t))) {
      skipped.push(`invariant:${inv.name}`);
      continue;
    }
    const rows = db.prepare(inv.sql).all() as Record<string, unknown>[];
    for (const row of rows) {
      invariantViolations.push({ invariant: inv.name, detail: JSON.stringify(row) });
    }
  }

  const { violations: queryPlanViolations, skipped: planSkipped } = checkQueryPlans(db);
  skipped.push(...planSkipped);

  return {
    ok: invariantViolations.length === 0 && queryPlanViolations.length === 0,
    invariantViolations,
    queryPlanViolations,
    skipped,
  };
}

/**
 * `db.rebuild` RETENTION CONTRACT (Phase-4 task 4-5, #341).
 *
 * The defining v2 invariant of `db rebuild`: a rebuild REGENERATES the whole
 * vault-derived projection (notes / note_identity_keys / note_links AND the v2
 * vault-derived `evidence` rows, which fold from note frontmatter — #337) while
 * leaving EVERY operational table byte-unchanged. Operational tables are primary
 * state that is NOT re-derivable from canonical Markdown:
 *
 *   - `jobs` / `job_attempts`   — the durable queue (owned by @atlas/jobs' 0002)
 *   - `source`                  — the v2 operational source registry (0015, #339)
 *   - `model_calls`             — provider-call accounting (0001_core)
 *   - `agent_runs`              — the workflow run state machine (0001_core)
 *
 * A derived-only parity test (fold-vs-rebuild) can NEVER catch a rebuild that
 * wrongly truncates one of these — this suite seeds a row in each, runs the
 * rebuild, and asserts the operational rows survive byte-for-byte. That is the
 * mandatory catch this file exists for.
 *
 * (The AC's index-eval retrieval gate — recall@10 ≥ 0.85 / MRR ≥ 0.70 — is the
 * EXISTING `index eval` gate exercised elsewhere; nothing here touches the
 * generation fence or the LanceDB index, so that gate is undisturbed.)
 */
import { describe, expect, it } from "vitest";
import { openStore, EvidenceRepo } from "../src/index.js";
import { SourceRepo } from "../src/repos/source.js";
import { makeNote, snapshot } from "./helpers.js";
import type { ParsedNote } from "@atlas/contracts";

/**
 * The verbatim @atlas/jobs `0002_jobs` DDL. `jobs`/`job_attempts` are owned by
 * @atlas/jobs, which depends on this package — so this package cannot import it
 * (a devDependency would invert the build order and cycle). The DDL is created
 * directly here to seed real operational rows; the rebuild must not touch them
 * regardless of which module owns the migration.
 */
const JOBS_DDL = `CREATE TABLE jobs (
  job_id           TEXT    NOT NULL PRIMARY KEY,
  workflow         TEXT    NOT NULL,
  idempotency_key  TEXT    NOT NULL,
  state            TEXT    NOT NULL DEFAULT 'pending'
                     CHECK (state IN ('pending', 'running', 'succeeded', 'failed', 'cancelled')),
  attempts         INTEGER NOT NULL DEFAULT 0,
  max_attempts     INTEGER NOT NULL DEFAULT 1,
  lease_epoch      INTEGER NOT NULL DEFAULT 0 CHECK (lease_epoch >= 0),
  next_run_at      TEXT,
  payload          TEXT    NOT NULL,
  payload_hash     TEXT    NOT NULL,
  created_at       TEXT    NOT NULL,
  updated_at       TEXT    NOT NULL,
  UNIQUE (workflow, idempotency_key)
) STRICT;

CREATE INDEX idx_jobs_eligibility ON jobs(state, next_run_at);

CREATE TABLE job_attempts (
  job_id          TEXT    NOT NULL,
  attempt_no      INTEGER NOT NULL,
  outcome         TEXT    NOT NULL CHECK (outcome IN ('running', 'succeeded', 'failed', 'cancelled')),
  error_code      TEXT,
  side_effect_id  TEXT,
  started_at      TEXT    NOT NULL,
  finished_at     TEXT,
  PRIMARY KEY (job_id, attempt_no),
  FOREIGN KEY (job_id) REFERENCES jobs(job_id) ON DELETE CASCADE
) STRICT;`;

function migrated() {
  const store = openStore({ path: ":memory:" });
  store.migrate();
  store.db.exec(JOBS_DDL); // seed the @atlas/jobs queue tables (see note above)
  return store;
}

/** A note whose raw frontmatter carries an `evidence:` block (so evidence folds). */
function noteWithEvidence(id: string, evidenceYaml: string, over: Partial<ParsedNote> = {}): ParsedNote {
  const raw = `---\nid: ${id}\ntitle: ${id}\n${evidenceYaml}\n---\n\n# ${id}\n\nbody\n`;
  return makeNote({ id, path: `${id}.md`, raw, contentHash: `${id.slice(0, 1)}`.repeat(64).slice(0, 64), ...over });
}

/** Deterministically dump a table (ordered by an explicit stable key). */
function dump(store: ReturnType<typeof openStore>, table: string, order: string): unknown[] {
  return store.db.prepare(`SELECT * FROM ${table} ORDER BY ${order}`).all();
}

describe("db.rebuild retention contract (#341)", () => {
  it("regenerates the vault-derived projection AND retains every operational row byte-unchanged", () => {
    const store = migrated();
    try {
      // --- seed OPERATIONAL rows (NOT vault-derived) -------------------------
      // agent_runs (0001) — a run row; also the FK parent for model_calls.
      store.ledger.upsertAgentRun({
        run_id: "run-1",
        operation: "enrich",
        status: "integrated",
        started_at: "2026-07-13T00:00:00Z",
        updated_at: "2026-07-13T00:05:00Z",
      });
      // model_calls (0001) — provider-call accounting (FK → agent_runs.run_id).
      store.db
        .prepare(
          `INSERT INTO model_calls
             (call_id, run_id, provider, model, operation, input_tokens, output_tokens, cost_micros, created_at)
           VALUES
             (@call_id, @run_id, @provider, @model, @operation, @in, @out, @cost, @at)`,
        )
        .run({
          call_id: "call-1",
          run_id: "run-1",
          provider: "gemini",
          model: "gemini-3.5-flash",
          operation: "generate",
          in: 1200,
          out: 340,
          cost: 987,
          at: "2026-07-13T00:01:00Z",
        });
      // source (0015) — the v2 operational source registry.
      const sourceRepo = new SourceRepo(store.db);
      sourceRepo.insert({
        id: "src-1",
        kind: "url",
        locator: "https://example.com/meridian",
        title: "Meridian launch",
        addedAt: "2026-07-12T00:00:00Z",
      });
      store.db.prepare(`UPDATE source SET lastIngestedAt = ? WHERE id = ?`).run("2026-07-12T09:00:00Z", "src-1");
      // jobs + job_attempts (@atlas/jobs' 0002) — the durable queue.
      store.db
        .prepare(
          `INSERT INTO jobs
             (job_id, workflow, idempotency_key, state, attempts, max_attempts, lease_epoch,
              next_run_at, payload, payload_hash, created_at, updated_at)
           VALUES
             ('job-1','index:reconcile','ik-1','succeeded',1,5,0,NULL,'{"k":1}','deadbeef',
              '2026-07-13T00:00:00Z','2026-07-13T00:02:00Z')`,
        )
        .run();
      store.db
        .prepare(
          `INSERT INTO job_attempts
             (job_id, attempt_no, outcome, error_code, side_effect_id, started_at, finished_at)
           VALUES
             ('job-1',1,'succeeded',NULL,'sfx-1','2026-07-13T00:00:30Z','2026-07-13T00:02:00Z')`,
        )
        .run();
      // retrieval_runs + retrieval_results (0001) — query history (written by query.ts).
      store.db
        .prepare(
          `INSERT INTO retrieval_runs
             (retrieval_id, run_id, query_text, mode, index_generation, recall_at_10, mrr, created_at)
           VALUES
             ('ret-1','run-1','meridian launch','hybrid',7,0.91,0.83,'2026-07-13T00:03:00Z')`,
        )
        .run();
      store.db
        .prepare(
          `INSERT INTO retrieval_results
             (retrieval_id, rank, note_id, score, channel)
           VALUES
             ('ret-1',1,'note-alpha',0.987,'vector')`,
        )
        .run();
      // change_plans + patches + git_operations (0001) — the synthesis workflow ledger (checkpoints.ts).
      store.db
        .prepare(
          `INSERT INTO change_plans
             (plan_id, run_id, tier, confidence, summary, plan_hash, created_at)
           VALUES
             ('plan-1','run-1',1,0.9,'append a log line','feed1234','2026-07-13T00:01:30Z')`,
        )
        .run();
      store.db
        .prepare(
          `INSERT INTO patches
             (patch_id, plan_id, note_id, changed_lines, changed_sections, patch_hash, created_at)
           VALUES
             ('patch-1','plan-1','note-alpha',3,1,'cafe5678','2026-07-13T00:01:40Z')`,
        )
        .run();
      store.db
        .prepare(
          `INSERT INTO git_operations
             (git_op_id, run_id, op_type, ref_name, commit_sha, created_at)
           VALUES
             ('git-1','run-1','commit','refs/heads/main','0123abcd','2026-07-13T00:01:50Z')`,
        )
        .run();

      // Snapshot the operational tables BEFORE the rebuild (byte-for-byte baseline). ALL live
      // v2 operational tables (dictionary "Two classes of state") — the derived-only parity
      // test cannot catch a rebuild that truncates ANY of these.
      const dumpOperational = (s: ReturnType<typeof openStore>) => ({
        agent_runs: dump(s, "agent_runs", "run_id"),
        model_calls: dump(s, "model_calls", "call_id"),
        source: dump(s, "source", "id"),
        jobs: dump(s, "jobs", "job_id"),
        job_attempts: dump(s, "job_attempts", "job_id, attempt_no"),
        retrieval_runs: dump(s, "retrieval_runs", "retrieval_id"),
        retrieval_results: dump(s, "retrieval_results", "retrieval_id, rank"),
        change_plans: dump(s, "change_plans", "plan_id"),
        patches: dump(s, "patches", "patch_id"),
        git_operations: dump(s, "git_operations", "git_op_id"),
      });
      const before = dumpOperational(store);
      // Each seeded exactly one row — guards against a silently-empty baseline
      // making the retention assertion vacuous.
      for (const [table, rows] of Object.entries(before)) {
        expect(rows, `${table} baseline`).toHaveLength(1);
      }

      // A STALE evidence row for a note that is ABSENT from the rebuild snapshot. The
      // rebuild must DROP it — evidence is REGENERATED from frontmatter, never accumulated.
      // Against a fresh :memory: DB a positive-only "ev-1 exists" assertion cannot tell
      // clear-then-fold from fold-into-empty; this orphan proves the pre-clear/fold clears.
      new EvidenceRepo(store.db).replaceForNote("note-ghost", "ghosthash", [
        { id: "ev-ghost", claim: "orphan from a prior fold", status: "resolved" },
      ]);
      expect(new EvidenceRepo(store.db).forNote("note-ghost")).toHaveLength(1);

      // --- run the rebuild from a fresh vault snapshot -----------------------
      // Two notes: alpha links to beta (proves note_links regeneration) and carries
      // an `evidence:` block (proves the vault-derived evidence fold, #337).
      const alpha = noteWithEvidence(
        "note-alpha",
        [
          "evidence:",
          "  - id: ev-1",
          "    claim: Meridian launched in 2025.",
          "    citation: sources/meridian.md",
          "    status: pending",
          "    sectionPath: Overview",
        ].join("\n"),
        { path: "concepts/alpha.md", aliases: ["Alpha Prime"], links: [{ target: "beta", raw: "[[beta]]" }] },
      );
      const beta = makeNote({ id: "note-beta", path: "concepts/beta.md" });
      const report = store.rebuildProjections(snapshot([alpha, beta]));

      // (a) the vault-derived projection is REGENERATED.
      expect(report.notes).toBe(2);
      expect(store.projections.countNotes()).toBe(2);
      expect(store.projections.getNote("note-alpha")!.slug).toBe("alpha");
      // identity keys: 2 slugs + 1 alias.
      expect(report.identityKeys).toBe(3);
      // note_links: the resolved `[[beta]]` edge.
      expect(report.links).toBe(1);
      const link = store.db
        .prepare(`SELECT target_note_id FROM note_links WHERE source_note_id = 'note-alpha'`)
        .get() as { target_note_id: string };
      expect(link.target_note_id).toBe("note-beta");
      // evidence rows folded from alpha's frontmatter (vault-derived, #337).
      const evidence = new EvidenceRepo(store.db).forNote("note-alpha");
      expect(evidence.map((r) => r.id)).toEqual(["ev-1"]);
      expect(evidence[0]).toMatchObject({
        noteId: "note-alpha",
        claim: "Meridian launched in 2025.",
        citation: "sources/meridian.md",
        status: "pending",
        sectionPath: "Overview",
        sourceNoteHash: alpha.contentHash, // stamped at fold time
      });
      // the stale ghost row is GONE (regenerated-not-accumulated: the whole-vault fold cleared it)
      // and the table holds ONLY the folded ev-1 — no orphan accretion across rebuilds.
      expect(new EvidenceRepo(store.db).forNote("note-ghost")).toEqual([]);
      expect(new EvidenceRepo(store.db).all().map((r) => r.id)).toEqual(["ev-1"]);

      // (b) EVERY operational row survives BYTE-UNCHANGED. This is the mandatory
      // catch a derived-only parity test misses.
      const after = dumpOperational(store);
      expect(after).toEqual(before);
    } finally {
      store.close();
    }
  });

  it("retains operational rows across a SECOND rebuild too (converges, never re-clears operational state)", () => {
    const store = migrated();
    try {
      store.ledger.upsertAgentRun({
        run_id: "run-x",
        operation: "ingest",
        status: "finalized",
        started_at: "2026-07-13T00:00:00Z",
        updated_at: "2026-07-13T00:00:00Z",
      });
      new SourceRepo(store.db).insert({
        id: "src-x",
        kind: "file",
        locator: "notes/x.md",
        addedAt: "2026-07-12T00:00:00Z",
      });

      const snap = snapshot([makeNote({ id: "n", path: "n.md" })]);
      store.rebuildProjections(snap);
      const afterFirst = {
        agent_runs: dump(store, "agent_runs", "run_id"),
        source: dump(store, "source", "id"),
      };
      store.rebuildProjections(snap);
      const afterSecond = {
        agent_runs: dump(store, "agent_runs", "run_id"),
        source: dump(store, "source", "id"),
      };
      expect(afterSecond).toEqual(afterFirst);
      expect(afterSecond.agent_runs).toHaveLength(1);
      expect(afterSecond.source).toHaveLength(1);
    } finally {
      store.close();
    }
  });
});

/**
 * `retention-jobs` (Task 4.10) — retention registration enqueues one job per retention-matrix
 * class (LanceDB compaction, log rotation, backup prune, quarantine expiry), idempotent per period.
 */
import { describe, expect, it } from "vitest";
import { openStore, type Store } from "@atlas/sqlite-store";
import { bindEnqueueContext, productionEnqueueContext, registerJobsMigration, jobIdsInStates, readSnapshot } from "@atlas/jobs";
import { registerRetentionJobs, RETENTION_WORKFLOWS } from "../src/retention/jobs.js";

function store(): Store {
  const s = openStore({ path: ":memory:" });
  registerJobsMigration(s);
  s.migrate();
  let n = 0;
  bindEnqueueContext(s.db, productionEnqueueContext({ nextJobId: () => `ret-${n++}`, now: () => "2026-07-16T00:00:00.000Z" }));
  return s;
}

describe("retention job registration (Task 4.10)", () => {
  it("enqueues one job per retention-matrix class", () => {
    const s = store();
    try {
      const ids = registerRetentionJobs(s.db, { backupKeep: 10, period: "2026-07-16" });
      expect(ids).toHaveLength(RETENTION_WORKFLOWS.length);
      expect(jobIdsInStates(s.db, ["pending"])).toHaveLength(RETENTION_WORKFLOWS.length);
      // The backup-prune job carries the keep bound; others carry the period.
      const prune = ids.find((_, i) => RETENTION_WORKFLOWS[i] === "retention:backup-prune")!;
      expect(readSnapshot(s, prune)!.payload).toMatchObject({ period: "2026-07-16", keep: 10 });
    } finally { s.close(); }
  });

  it("is idempotent per period: a repeat registration returns the same ids, no duplicates", () => {
    const s = store();
    try {
      const first = registerRetentionJobs(s.db, { backupKeep: 10, period: "2026-07-16" });
      const second = registerRetentionJobs(s.db, { backupKeep: 10, period: "2026-07-16" });
      expect(second).toEqual(first);
      expect(jobIdsInStates(s.db, ["pending"])).toHaveLength(RETENTION_WORKFLOWS.length);
      // A new period enqueues a fresh set.
      const next = registerRetentionJobs(s.db, { backupKeep: 10, period: "2026-07-17" });
      expect(next.every((id) => !first.includes(id))).toBe(true);
    } finally { s.close(); }
  });
});

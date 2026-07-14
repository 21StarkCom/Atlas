/**
 * `jobs.backup-schema-head` — a backup taken at a JOBS-owned schema head must be
 * verifiable by the SAME binary (ledger-backup-contract §8.3 compatibility).
 *
 * Regression: `@atlas/jobs` owns `0002_jobs` + `0007_job_cancellations`, but
 * `@atlas/sqlite-store` cannot import their ids (it does not depend on `@atlas/jobs` —
 * that would be a dependency cycle), so its static `KNOWN_SCHEMA_HEADS` did not contain
 * them. Once the jobs migrations were applied one of them became the schema HEAD, every
 * subsequent backup was stamped with it, and `verifyBackup` rejected the binary's OWN
 * backups as a "future/unknown schema" — making the ledger unrestorable. The owning
 * package now declares its heads via `registerKnownSchemaHead` alongside its migrations
 * (the same composition-root seam as `registerMigration`).
 */
import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { takeBackup, verifyBackup, readBundleHeader, type LedgerBackupConfig } from "@atlas/sqlite-store";
import { openJobsStore } from "../src/index.js";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "atlas-jobs-backup-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("a backup stamped at a jobs-owned schema head verifies with the same binary", () => {
  it("migrate (jobs head) → backup → verify round-trips (schema head is KNOWN, not future/unknown)", async () => {
    const dbPath = join(dir, "atlas.db");
    // openJobsStore registers 0002_jobs + 0007_job_cancellations and migrates, so one of
    // them is now the schema HEAD and the backup below is stamped with it.
    const store = openJobsStore({ path: dbPath });
    try {
      const cfg: LedgerBackupConfig = { dir: join(dir, "backups"), key: randomBytes(32) };
      const result = await takeBackup(store, cfg);

      // The bundle is stamped at a jobs-owned head …
      const header = readBundleHeader(cfg, result.backupRef);
      expect(header.schemaHead).toMatch(/^000[27]_/);

      // … and THIS binary must understand it. Before the fix this threw
      // BackupIntegrityError("…which this binary does not understand … incompatible").
      expect(() => verifyBackup(cfg, result.backupRef)).not.toThrow();
    } finally {
      store.close();
    }
  });
});

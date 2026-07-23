/**
 * `jobs.backup-schema-head` — a backup taken from a fully-migrated jobs store must be
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
 *
 * Since task 4-2 the core `0014_evidence_v2` (in `openStore`'s default set) is the
 * lexicographically-highest applied migration, so IT — not a jobs head — is the schema
 * HEAD of a freshly-migrated store, and every new backup stamps `0014_evidence_v2`. The
 * jobs-head `registerKnownSchemaHead` calls still matter for backward-compatibility with
 * backups taken BEFORE the core v2 migrations existed (stamped `0007_job_cancellations`) —
 * that seam is still exercised on every `openJobsStore`. This test asserts the core §8.3
 * guarantee: the binary VERIFIES its own freshly-taken backup (head recognized, not
 * future/unknown).
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
  it("current head: migrate → backup → verify round-trips (schema head 0014_evidence_v2 is KNOWN)", async () => {
    const dbPath = join(dir, "atlas.db");
    // openJobsStore registers 0002_jobs + 0007_job_cancellations (+ their known-schema-heads)
    // and migrates the full store. The core 0014_evidence_v2 (openStore's default set) is the
    // lexicographically-highest applied migration, so the backup below is stamped with it.
    const store = openJobsStore({ path: dbPath });
    try {
      const cfg: LedgerBackupConfig = { dir: join(dir, "backups"), key: randomBytes(32) };
      const result = await takeBackup(store, cfg);

      // The bundle is stamped at the current schema head …
      const header = readBundleHeader(cfg, result.backupRef);
      expect(header.schemaHead).toBe("0014_evidence_v2");

      // … and THIS binary must understand it. Before the fix this threw
      // BackupIntegrityError("…which this binary does not understand … incompatible").
      expect(() => verifyBackup(cfg, result.backupRef)).not.toThrow();
    } finally {
      store.close();
    }
  });

  it("historical head: a pre-0013 backup stamped 0007_job_cancellations still verifies (registerKnownSchemaHead)", async () => {
    // The core §8.3 regression: `0007_job_cancellations` is a DOWNSTREAM (jobs-owned)
    // migration `@atlas/sqlite-store` cannot import, so it is NOT in the static
    // `KNOWN_SCHEMA_HEADS`. It is recognized ONLY because `registerJobsMigration`
    // (via `openJobsStore`) calls `registerKnownSchemaHead`. A backup taken BEFORE
    // 0013 existed was stamped 0007 — that historical bundle MUST still verify, so
    // this case must survive even though the current head is now 0013.
    //
    // We simulate a pre-v2-core store by dropping the core `0013_links_v2` +
    // `0014_evidence_v2` rows from the runner's `db_schema_migrations` table AFTER the
    // full migrate, so `schemaHead` (the lexicographically-highest applied id) resolves
    // to `0007_job_cancellations` (openJobsStore applies no 0008–0012 feature migration).
    const dbPath = join(dir, "atlas.db");
    const store = openJobsStore({ path: dbPath });
    try {
      store.db
        .prepare(`DELETE FROM db_schema_migrations WHERE id IN ('0013_links_v2', '0014_evidence_v2')`)
        .run();
      const cfg: LedgerBackupConfig = { dir: join(dir, "backups-hist"), key: randomBytes(32) };
      const result = await takeBackup(store, cfg);

      // Stamped at the jobs-owned head …
      const header = readBundleHeader(cfg, result.backupRef);
      expect(header.schemaHead).toBe("0007_job_cancellations");

      // … and verifiable only because the jobs package registered the head. Without
      // `registerKnownSchemaHead("0007_job_cancellations")` this throws
      // BackupIntegrityError("…future/unknown schema … incompatible").
      expect(() => verifyBackup(cfg, result.backupRef)).not.toThrow();
    } finally {
      store.close();
    }
  });
});

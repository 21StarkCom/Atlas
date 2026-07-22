/**
 * `ledger.dr-roundtrip` (contract §12). `db backup` → wipe/corrupt the ledger DB
 * → authorized `db restore` → every ledger row recovered byte-equal; the
 * post-restore rebuild hook fires. Wrong/revoked key + truncated/corrupt bundle
 * are rejected.
 */
import { afterEach, describe, expect, it } from "vitest";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import type { PrivilegedOpDescriptor } from "@atlas/broker";
import {
  BackupIntegrityError,
  _resetPostRestoreRebuild,
  finalizeLedgerWrite,
  migration0001Core,
  migration0003Provenance,
  migration0004Claims,
  migration0005LedgerFinalize,
  openConnection,
  openStore,
  readBundleHeader,
  rebuildProjections,
  registerPostRestoreRebuild,
  restoreBackup,
  runMigrations,
  takeBackup,
  verifyBackup,
} from "../../src/index.js";
import type { ParsedNote, VaultSnapshot } from "@atlas/contracts";
import { createLedgerHarness, runId, type LedgerHarness } from "./harness.js";

let h: LedgerHarness;
afterEach(() => {
  _resetPostRestoreRebuild();
  h?.cleanup();
});

/** A minimal `ParsedNote` with the given links (for the pre-0013 restore rebuild). */
function makeNoteWithLinks(id: string, path: string, links: ParsedNote["links"]): ParsedNote {
  return {
    id,
    path,
    type: "concept",
    schemaVersion: 1,
    title: id,
    status: "active",
    created: "2026-07-22",
    updated: "2026-07-22",
    aliases: [],
    sources: [],
    declaredSensitivity: "internal",
    links,
    sections: { heading: "", level: 0, path: "", children: [] },
    contentHash: "0".repeat(64),
    raw: "",
  };
}

/** The serializable step-3 business write for a `refresh` run. */
function writeRun(rid: string) {
  return [
    {
      sql: `INSERT INTO agent_runs (run_id, operation, status, started_at, updated_at)
            VALUES (?, 'refresh', 'integrated', '2026-07-12T00:00:00Z', '2026-07-12T00:00:00Z')`,
      params: [rid],
    },
  ];
}

/**
 * The COMPLETE required ledger-table state (finding #16): the audit stream
 * EXCLUDING the restore-added `db.restore` row, the durable intents, the business
 * `agent_runs`, and the watermark coverage — everything the backup is the system
 * of record for, so it must recover byte-equal.
 */
function ledgerDump(store: ReturnType<LedgerHarness["openStore"]>): {
  audit: unknown[];
  intents: unknown[];
  runs: unknown[];
  coveredSeq: number;
  healthy: number;
} {
  const wm = store.db.prepare(`SELECT seq, healthy FROM backup_watermark WHERE id = 1`).get() as
    | { seq: number; healthy: number }
    | undefined;
  return {
    // Exclude `db.restore` (restore adds it) but KEEP `db.backup` rows + run.* rows.
    audit: store.db
      .prepare(`SELECT * FROM audit_events WHERE event_type != 'db.restore' ORDER BY seq`)
      .all(),
    intents: store.db.prepare(`SELECT * FROM audit_intents ORDER BY seq`).all(),
    runs: store.db.prepare(`SELECT * FROM agent_runs ORDER BY run_id`).all(),
    coveredSeq: wm?.seq ?? -1,
    healthy: wm?.healthy ?? -1,
  };
}

/** The `db.restore` op descriptor the CLI/broker bind authorization to (§10.1). */
function restoreDescriptor(backupRef: string, contentHash: string): PrivilegedOpDescriptor {
  return {
    op: "db restore",
    canonicalBaseCommit: "0".repeat(40),
    intendedEffect: { kind: "restore", backupRef, backupContentHash: `sha256:${contentHash}` },
  };
}

describe("ledger.dr-roundtrip (§12)", () => {
  it("backup → wipe → authorized restore recovers the complete ledger state byte-equal", async () => {
    h = await createLedgerHarness();
    let store = h.openStore();

    // Commit three ledger-writing runs (each anchors an audit event + agent_runs row).
    const rids = [runId(), runId(), runId()];
    for (const rid of rids) {
      await finalizeLedgerWrite(store, h.service, {
        runId: rid,
        event: h.draft(rid),
        backup: h.backup,
        ledgerWrite: writeRun(rid),
      });
    }
    // Capture the complete required state BEFORE the explicit final backup snapshots it.
    const before = ledgerDump(store);
    expect((before.audit as unknown[]).filter((r) => (r as { event_type: string }).event_type.startsWith("run.")).length).toBe(3);
    expect(before.runs.length).toBe(3);
    expect(before.intents.length).toBe(3);

    // Take an explicit final backup (snapshots `before`) and capture its ref + hash.
    const { backupRef } = await takeBackup(store, h.backup);

    // A post-restore hook must fire (projection/index rebuild seam).
    let hookFired = false;
    registerPostRestoreRebuild(async (ctx) => {
      expect(ctx.db).toBeDefined();
      hookFired = true;
    });

    // Exercise the REAL challenge/authorization path (test-signer), binding the
    // authorization to the bundle's authenticated content hash (finding #16).
    const contentHash = readBundleHeader(h.backup, backupRef).contentHash;
    const desc = restoreDescriptor(backupRef, contentHash);
    const auth = h.authorize(desc);
    h.service.execAuthorized(desc, auth); // throws if the authorization does not verify

    // Corrupt the live DB (simulate disaster), then restore under the authorized hash.
    writeFileSync(h.dbPath, "totally corrupt not-a-sqlite-file", "utf8");
    const result = await restoreBackup(store, backupRef, h.backup, { expectedContentHash: contentHash });
    expect(result.restoredCutSeq).toBe(2); // highest run seq

    // Re-open and compare: the complete required state is byte-equal.
    store = h.openStore();
    const after = ledgerDump(store);
    expect(after.audit).toEqual(before.audit); // run.* + db.backup rows, intents-free
    expect(after.intents).toEqual(before.intents); // durable intents recovered
    expect(after.runs).toEqual(before.runs); // business rows recovered
    expect(after.coveredSeq).toBe(before.coveredSeq); // watermark re-established at the cut
    expect(after.healthy).toBe(1);
    expect(hookFired).toBe(true);

    // A `db.restore` audit row was recorded (D6).
    const restoreRows = store.db
      .prepare(`SELECT COUNT(*) AS c FROM audit_events WHERE event_type = 'db.restore'`)
      .get() as { c: number };
    expect(restoreRows.c).toBe(1);
    store.close();
  });

  it("restore refuses a bundle whose content hash differs from the authorized hash (TOCTOU)", async () => {
    h = await createLedgerHarness();
    const store = h.openStore();
    const rid = runId();
    await finalizeLedgerWrite(store, h.service, {
      runId: rid,
      event: h.draft(rid),
      backup: h.backup,
      ledgerWrite: writeRun(rid),
    });
    const { backupRef } = await takeBackup(store, h.backup);

    // Authorization was bound to a DIFFERENT content hash than the bundle carries.
    await expect(
      restoreBackup(store, backupRef, h.backup, { expectedContentHash: "0".repeat(64) }),
    ).rejects.toThrow(BackupIntegrityError);
    store.close();
  });

  it("a wrong/revoked key fails verify + restore (never selectable)", async () => {
    h = await createLedgerHarness();
    const store = h.openStore();
    const rid = runId();
    await finalizeLedgerWrite(store, h.service, { runId: rid, event: h.draft(rid), backup: h.backup, ledgerWrite: [] });
    const { backupRef } = await takeBackup(store, h.backup);

    const wrongKeyCfg = { ...h.backup, key: randomBytes(32) };
    expect(() => verifyBackup(wrongKeyCfg, backupRef)).toThrow(BackupIntegrityError);
    await expect(restoreBackup(store, backupRef, wrongKeyCfg)).rejects.toThrow(BackupIntegrityError);
    store.close();
  });

  it("restores a PRE-0013 backup: forward-migrates through 0013 BEFORE the rebuild, both succeed", async () => {
    h = await createLedgerHarness();

    // Build a genuine pre-`0013_links_v2` ledger DB at a separate path: only the
    // core PR-A migrations applied, so `note_links` is the v1 shape (3-col PK,
    // NOT NULL predicate, `ordinal`, NO `alias`). Seed a v1 link so the pre-0013
    // schema is realistic. `openStore` (used to snapshot it) does NOT auto-migrate,
    // so the file stays at the v1 frontier.
    const prePath = join(h.dir, "pre0013.db");
    {
      const raw = openConnection({ path: prePath });
      runMigrations(
        raw,
        [migration0001Core, migration0003Provenance, migration0004Claims, migration0005LedgerFinalize],
        () => "2026-07-22T00:00:00Z",
      );
      const insertNote = raw.prepare(
        `INSERT INTO notes
           (note_id, slug, title, type, schema_version, status, file_path, content_hash, created, updated)
         VALUES (?, ?, ?, 'concept', 1, 'active', ?, ?, '2026-07-22', '2026-07-22')`,
      );
      insertNote.run("n1", "n1", "n1", "n1.md", `sha256:${"a".repeat(64)}`);
      insertNote.run("n2", "n2", "n2", "n2.md", `sha256:${"b".repeat(64)}`);
      // A v1 row (predicate NOT NULL, ordinal present) — the shape 0013 rebuilds.
      raw.prepare(
        `INSERT INTO note_links (source_note_id, target_note_id, predicate, ordinal) VALUES ('n1', 'n2', 'references', 0)`,
      ).run();
      // Sanity: this really is the v1 table (no `alias` column, no forward index).
      const preCols = (raw.prepare(`PRAGMA table_info(note_links)`).all() as { name: string }[]).map((c) => c.name);
      expect(preCols).toContain("ordinal");
      expect(preCols).not.toContain("alias");
      raw.close();
    }

    // Snapshot the pre-0013 DB into an encrypted backup (schemaHead 0005 — a KNOWN,
    // compatible head). `openStore` does not migrate, so the bundle is genuinely v1.
    const preStore = openStore({ path: prePath });
    let backupRef: string;
    try {
      ({ backupRef } = await takeBackup(preStore, h.backup));
    } finally {
      preStore.close();
    }

    // The post-restore projection rebuild emits the v2 link shape (predicate NULL +
    // `alias`). Registered against the fresh restore connection — it would throw
    // `table note_links has no column named alias` if the restored DB were NOT
    // forward-migrated through 0013 first.
    const link = { target: "n2", raw: "[[n2]]", alias: "the second" } as ParsedNote["links"][number];
    const rebuildSnapshot: VaultSnapshot = {
      notes: [
        makeNoteWithLinks("n1", "n1.md", [link]),
        makeNoteWithLinks("n2", "n2.md", []),
      ],
      errors: [],
    };
    let rebuildThrew: unknown = null;
    registerPostRestoreRebuild(async (ctx) => {
      try {
        rebuildProjections(ctx.db, rebuildSnapshot);
      } catch (e) {
        rebuildThrew = e;
        throw e;
      }
    });

    // Restore the pre-0013 bundle over the (fully-migrated) live store.
    const store = h.openStore();
    const contentHash = readBundleHeader(h.backup, backupRef).contentHash;
    await restoreBackup(store, backupRef, h.backup, { expectedContentHash: contentHash });

    expect(rebuildThrew).toBeNull();

    // Re-open: the restored DB is now at the v2 frontier and carries v2 rows.
    const after = h.openStore();
    try {
      // 0013 was applied to the restored DB.
      expect(
        after.db.prepare(`SELECT 1 FROM db_schema_migrations WHERE id = '0013_links_v2'`).get(),
      ).toBeDefined();
      // note_links is the v2 shape.
      const cols = (after.db.prepare(`PRAGMA table_info(note_links)`).all() as { name: string }[]).map((c) => c.name);
      expect(cols).toContain("alias");
      expect(cols).not.toContain("ordinal");
      const idx = new Set(
        (after.db.prepare(`SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='note_links'`).all() as {
          name: string;
        }[]).map((r) => r.name),
      );
      for (const name of ["ux_note_links_plain", "ux_note_links_pred", "idx_note_links_forward"]) {
        expect(idx.has(name), `missing index ${name}`).toBe(true);
      }
      // The rebuild's v2 row: a plain wiki-link is predicate NULL + alias from display text.
      const row = after.db
        .prepare(`SELECT predicate, alias FROM note_links WHERE source_note_id='n1' AND target_note_id='n2'`)
        .get() as { predicate: string | null; alias: string | null };
      expect(row).toEqual({ predicate: null, alias: "the second" });
      // db verify is clean at the v2 frontier (forward index required BY NAME).
      expect(after.verify().queryPlanViolations).toEqual([]);
    } finally {
      after.close();
    }
  });

  it("a truncated/corrupt bundle fails verify (exit-1 class)", async () => {
    h = await createLedgerHarness();
    const store = h.openStore();
    const rid = runId();
    await finalizeLedgerWrite(store, h.service, { runId: rid, event: h.draft(rid), backup: h.backup, ledgerWrite: [] });
    const { backupRef } = await takeBackup(store, h.backup);

    // Truncate the ciphertext → auth tag / content-hash check fails.
    const bundle = JSON.parse(readFileSync(backupRef, "utf8")) as { ciphertext: string };
    bundle.ciphertext = bundle.ciphertext.slice(0, Math.floor(bundle.ciphertext.length / 2));
    writeFileSync(backupRef, JSON.stringify(bundle), "utf8");
    expect(() => verifyBackup(h.backup, backupRef)).toThrow(BackupIntegrityError);
    store.close();
  });
});

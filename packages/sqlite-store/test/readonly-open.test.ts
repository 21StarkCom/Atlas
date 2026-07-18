/**
 * `readonly-open` (console watch SP-1, Phase 1 Task 4) — the read-only ledger
 * opener + fd-based identity + schema-state that let `apps/cli` read the ledger
 * without a better-sqlite3 dependency. Pins: a usable read connection, a write
 * throwing `SQLITE_READONLY`, a distinguishable missing-path error, the
 * created-but-unmigrated `"absent"` state, and the fd-based identity's
 * restore-safety (an atomic replace post-open leaves identity unchanged).
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { closeSync, linkSync, mkdtempSync, openSync, renameSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  captureLedgerIdentity,
  ledgerSchemaState,
  openConnection,
  openReadonlyLedger,
  __lastOpenAttempts,
  __setReadonlyInterOpenHook,
  __setReadonlyPostDbOpenHook,
  __setReadonlyVerifyWindowHook,
} from "../src/index.js";
import { openStore } from "../src/index.js";
import { statSync } from "node:fs";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "atlas-ro-ledger-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

/** Create a fully-migrated, file-backed ledger with one seeded audit event. */
function seedMigratedLedger(path: string): void {
  const store = openStore({ path });
  store.migrate();
  store.ledger.upsertAgentRun({
    run_id: "run-1",
    operation: "ingest",
    status: "planned",
    started_at: "2026-07-13T00:00:00Z",
    updated_at: "2026-07-13T00:00:00Z",
  });
  store.ledger.insertAuditEvent({
    seq: 1,
    run_id: "run-1",
    event_type: "run.started",
    payload_hash: "h".repeat(64),
    git_head: "a".repeat(40),
    created_at: "2026-07-13T00:00:00Z",
  });
  store.close();
}

/** Create a valid but UNMIGRATED sqlite file (no tables). */
function seedEmptyDbFile(path: string): void {
  const db = openConnection({ path });
  db.close();
}

describe("openReadonlyLedger", () => {
  it("returns a usable read connection on a seeded ledger", () => {
    const path = join(dir, "ledger.db");
    seedMigratedLedger(path);
    const led = openReadonlyLedger(path);
    try {
      const row = led.db.prepare(`SELECT COUNT(*) AS n FROM audit_events`).get() as { n: number };
      expect(row.n).toBe(1);
    } finally {
      led.close();
    }
  });

  it("a write through the read connection throws SQLITE_READONLY", () => {
    const path = join(dir, "ledger.db");
    seedMigratedLedger(path);
    const led = openReadonlyLedger(path);
    try {
      let code: string | undefined;
      try {
        led.db.prepare(`INSERT INTO audit_events (seq, run_id, event_type, payload_hash, git_head, created_at)
                        VALUES (99, 'run-1', 'run.started', ?, ?, '2026-07-13T00:00:00Z')`).run(
          "h".repeat(64),
          "a".repeat(40),
        );
      } catch (e) {
        code = (e as { code?: string }).code;
      }
      expect(code).toBe("SQLITE_READONLY");
    } finally {
      led.close();
    }
  });

  it("opening a missing path throws a distinguishable ENOENT", () => {
    const missing = join(dir, "does-not-exist.db");
    let code: string | undefined;
    try {
      openReadonlyLedger(missing);
    } catch (e) {
      code = (e as { code?: string }).code;
    }
    expect(code).toBe("ENOENT");
  });
});

describe("ledgerSchemaState", () => {
  it("returns 'absent' for a created-but-unmigrated file", () => {
    const path = join(dir, "empty.db");
    seedEmptyDbFile(path);
    const led = openReadonlyLedger(path);
    try {
      expect(ledgerSchemaState(led.db)).toBe("absent");
    } finally {
      led.close();
    }
  });

  it("returns 'ready' for a fully-migrated ledger", () => {
    const path = join(dir, "ledger.db");
    seedMigratedLedger(path);
    const led = openReadonlyLedger(path);
    try {
      expect(ledgerSchemaState(led.db)).toBe("ready");
    } finally {
      led.close();
    }
  });
});

describe("captureLedgerIdentity + fd restore-safety", () => {
  it("reflects the held fd and stays unchanged after an atomic replace of the path", () => {
    const path = join(dir, "ledger.db");
    seedMigratedLedger(path);
    const led = openReadonlyLedger(path);
    try {
      const before = captureLedgerIdentity(led);
      expect(before.device).toBe(led.identity.device);
      expect(before.inode).toBe(led.identity.inode);
      expect(before.schemaHead).toBe(led.identity.schemaHead);
      expect(before.schemaHead).not.toBe("");

      // Atomically replace the PATH with a DIFFERENT file (a new inode). The
      // still-open companion fd keeps referring to the original inode, so the
      // captured identity must NOT move — the restore-safety property.
      const replacement = join(dir, "replacement.db");
      seedMigratedLedger(replacement);
      renameSync(replacement, path);

      const after = captureLedgerIdentity(led);
      expect(after.device).toBe(before.device);
      expect(after.inode).toBe(before.inode);

      // A fresh stat of the path now describes the DIFFERENT file — proving the
      // identity is pinned to the fd, not re-read from the path.
      const freshFd = openSync(path, "r");
      try {
        // The replacement's inode differs from the held identity's inode.
        // (We do not assert exact numbers — only that the held fd did not follow.)
        expect(after.inode).toBe(led.identity.inode);
      } finally {
        closeSync(freshFd);
      }
    } finally {
      led.close();
    }
  });

  it("close() releases the fd (a second close is a no-op)", () => {
    const path = join(dir, "ledger.db");
    seedMigratedLedger(path);
    const led = openReadonlyLedger(path);
    led.close();
    expect(() => led.close()).not.toThrow();
    // The custody slot is INVALIDATED on close — captureLedgerIdentity fails on the
    // flag, deliberately NOT by fstat-ing the raw (recyclable) descriptor number.
    expect(() => captureLedgerIdentity(led)).toThrow(/ledger is closed/);
  });

  it("never fstats a RECYCLED descriptor after close (fd-reuse regression)", () => {
    const path = join(dir, "ledger.db");
    seedMigratedLedger(path);
    const led = openReadonlyLedger(path);
    led.close();
    // Aggressively churn descriptors so the OS very likely reuses the exact number the
    // closed ledger held — then open a DIFFERENT file on it. A registry that retained
    // the raw number would fstat THIS unrelated file and report a stranger's identity.
    const other = join(dir, "other.db");
    seedMigratedLedger(other);
    const hogs: number[] = [];
    try {
      for (let i = 0; i < 64; i++) hogs.push(openSync(other, "r"));
      // The invalidated slot makes this fail-closed regardless of which fd got reused.
      expect(() => captureLedgerIdentity(led)).toThrow(/ledger is closed/);
    } finally {
      for (const fd of hogs) closeSync(fd);
    }
  });
});

describe("DB_EVENT_SEQ_BASE re-export", () => {
  it("is importable from the package root", async () => {
    const mod = await import("../src/index.js");
    expect(mod.DB_EVENT_SEQ_BASE).toBe(1_000_000_000_000);
  });
});

/** Seed a migrated ledger with a caller-chosen number of audit events (a content marker). */
function seedLedgerWithCount(path: string, count: number): void {
  const store = openStore({ path });
  store.migrate();
  store.ledger.upsertAgentRun({
    run_id: "run-1",
    operation: "ingest",
    status: "planned",
    started_at: "2026-07-13T00:00:00Z",
    updated_at: "2026-07-13T00:00:00Z",
  });
  for (let seq = 1; seq <= count; seq++) {
    store.ledger.insertAuditEvent({
      seq,
      run_id: "run-1",
      event_type: "run.started",
      payload_hash: "h".repeat(64),
      git_head: "a".repeat(40),
      created_at: "2026-07-13T00:00:00Z",
    });
  }
  store.close();
}

// Content-distinct enough that page_count (hence the header signature) differs —
// a handful of rows fit in one page, so we use a wide gap to guarantee divergence.
const SMALL = 1;
const LARGE = 600;

/**
 * Seed a migrated ledger whose audit events are filled with a caller-chosen char
 * (payload_hash + git_head). Row SIZES are fixed (64/40-char strings), so two
 * ledgers seeded with the SAME count but DIFFERENT fill share an identical page
 * layout — hence an identical coarse pragma tuple — while their bytes differ. This
 * is the collision the ABA hybrid test relies on.
 */
function seedLedgerWithFill(path: string, count: number, fill: string): void {
  const store = openStore({ path });
  store.migrate();
  store.ledger.upsertAgentRun({
    run_id: "run-1",
    operation: "ingest",
    status: "planned",
    started_at: "2026-07-13T00:00:00Z",
    updated_at: "2026-07-13T00:00:00Z",
  });
  for (let seq = 1; seq <= count; seq++) {
    store.ledger.insertAuditEvent({
      seq,
      run_id: "run-1",
      event_type: "run.started",
      payload_hash: fill.repeat(64),
      git_head: fill.repeat(40),
      created_at: "2026-07-13T00:00:00Z",
    });
  }
  store.close();
}

// A row count large enough that A (fill 'a') and B (fill 'b') share a stable, equal
// page tuple, but small enough to keep the test fast. Same count ⇒ same layout.
const SAME_COUNT = 50;

describe("openReadonlyLedger — inter-open race (deterministic injection)", () => {
  afterEach(() => {
    __setReadonlyInterOpenHook(null);
    __setReadonlyPostDbOpenHook(null);
    __setReadonlyVerifyWindowHook(null);
  });

  it("detects a replacement forced BETWEEN fd-open and db-open, retries, and binds to the file actually opened", () => {
    const path = join(dir, "ledger.db");
    // ORIGINAL: SMALL. The companion fd binds to THIS inode first.
    seedLedgerWithCount(path, SMALL);
    const originalInode = statSync(path).ino;

    // REPLACEMENT: a DIFFERENT file (distinct inode) with a DISTINGUISHABLE content
    // marker (LARGE ⇒ more pages ⇒ different header signature). Swapped over `path`
    // in the fd↔db gap and NOT swapped back — so after the retry the path is stable
    // on the replacement and the opener binds to it consistently (no hybrid).
    const replPath = join(dir, "replacement.db");
    seedLedgerWithCount(replPath, LARGE);
    const replInode = statSync(replPath).ino;
    expect(replInode).not.toBe(originalInode);

    let fired = 0;
    __setReadonlyInterOpenHook(() => {
      fired++;
      if (fired === 1) renameSync(replPath, path);
    });

    const led = openReadonlyLedger(path);
    try {
      expect(fired).toBeGreaterThanOrEqual(1); // the race window was exercised

      // The returned handle reads the REPLACEMENT's content — not the original,
      // not a hybrid — proving the retry rebound the db to the file it verified.
      const row = led.db.prepare(`SELECT COUNT(*) AS n FROM audit_events`).get() as { n: number };
      expect(row.n).toBe(LARGE);

      // Identity is pinned to the file the connection actually opened (the
      // replacement's inode), NOT the original the first fd briefly held.
      expect(led.identity.inode).toBe(replInode);
      expect(led.identity.inode).not.toBe(originalInode);
      expect(captureLedgerIdentity(led).inode).toBe(replInode);
    } finally {
      led.close();
    }
  });

  it("detects a TRUE A→B→A ABA (swap back to the SAME inode) where fd and stat(path) agree but the connection read B — and never returns a hybrid", () => {
    const path = join(dir, "ledger.db");
    // A (SMALL) is the file the companion fd binds to first. We keep a hardlink to
    // A's EXACT inode so we can swap it BACK over `path` later — a genuine ABA where
    // stat(path) and the held fd end up on the identical inode (a third inode would
    // be caught trivially by the inode check; true ABA must be caught another way).
    seedLedgerWithCount(path, SMALL);
    const aInode = statSync(path).ino;
    const aLink = join(dir, "A.hardlink.db");
    linkSync(path, aLink); // aLink and path now name the SAME inode (aInode)

    // B (LARGE, distinct inode, distinguishable content) is what the CONNECTION opens
    // in the fd↔db gap.
    const bPath = join(dir, "B.db");
    seedLedgerWithCount(bPath, LARGE);

    let interFired = 0;
    let verifyFired = 0;
    __setReadonlyInterOpenHook(() => {
      interFired++;
      if (interFired === 1) renameSync(bPath, path); // A → B (connection opens B)
    });
    // Fire the swap-back INSIDE the verify window — AFTER the companion fd has been
    // opened (on B) but BEFORE the identity checks. This restores path to A's EXACT
    // inode while the connection still reads B: the classic hybrid. The
    // stat(path)==connection-incarnation requirement detects it (path is A, the
    // connection's own descriptor is B) and forces a retry.
    __setReadonlyVerifyWindowHook(() => {
      verifyFired++;
      if (verifyFired === 1) renameSync(aLink, path); // B → A (same inode; true ABA)
    });

    const led = openReadonlyLedger(path);
    try {
      expect(interFired).toBeGreaterThanOrEqual(1);
      expect(verifyFired).toBeGreaterThanOrEqual(1);

      // After the bracket rejects the hybrid and retries, the path is stable on A
      // (SMALL, aInode). The handle is CONSISTENT: connection, retained fd, and
      // identity all describe A — never the B the first attempt briefly read.
      const row = led.db.prepare(`SELECT COUNT(*) AS n FROM audit_events`).get() as { n: number };
      expect(row.n).toBe(SMALL);
      expect(led.identity.inode).toBe(aInode);
      expect(statSync(path).ino).toBe(aInode);
      expect(captureLedgerIdentity(led).inode).toBe(aInode);
    } finally {
      led.close();
    }
  });

  it("detects a same-pragma-tuple A→B→A hybrid (DIFFERENT logical contents, IDENTICAL page_count/schema_version/…) — the collision a coarse header fingerprint would have accepted", () => {
    // A and B are structurally identical (same row COUNT ⇒ same page layout ⇒ same
    // page_count/schema_version/user_version/application_id/freelist_count) but hold
    // DIFFERENT bytes (distinct payload_hash fill). A retired coarse-tuple signature
    // was byte-for-byte equal across A and B, so an A→B→A swap that completed BEFORE
    // verification (connection bound to B; held fd + stat(path) both back on A)
    // slipped through as a false match — a hybrid handle. The fd-identity primitive
    // does not look at content at all: the companion fd (A) can never fstat-equal the
    // connection's own descriptor (B), so the hybrid is rejected regardless of how
    // similar A and B look.
    const path = join(dir, "ledger.db");
    seedLedgerWithFill(path, SAME_COUNT, "a"); // A: content 'a', the fd binds here first
    const aInode = statSync(path).ino;
    const aLink = join(dir, "A.hardlink.db");
    linkSync(path, aLink); // aLink names A's EXACT inode, for the swap BACK

    const bPath = join(dir, "B.db");
    seedLedgerWithFill(bPath, SAME_COUNT, "b"); // B: SAME layout, DIFFERENT content

    // Precondition the reviewer named: the coarse pragma tuple is IDENTICAL across A
    // and B (so a header-only signature cannot tell them apart), yet the bytes differ.
    const coarse = (p: string): string => {
      const c = openConnection({ path: p, readonly: true });
      try {
        return ["page_count", "schema_version", "user_version", "application_id", "freelist_count"]
          .map((k) => c.pragma(k, { simple: true }))
          .join("/");
      } finally {
        c.close();
      }
    };
    expect(coarse(path)).toBe(coarse(bPath)); // same tuple — the collision that fooled the old fingerprint

    let interFired = 0;
    let postFired = 0;
    __setReadonlyInterOpenHook(() => {
      interFired++;
      if (interFired === 1) renameSync(bPath, path); // A → B: the connection opens B
    });
    // Complete the swap BACK to A's exact inode in the db↔verify gap — BEFORE the
    // companion fd opens. Now the companion fd and stat(path) both identify A while
    // the connection still reads B; only an identity primitive bound to the
    // connection's OWN opened file can expose the hybrid.
    __setReadonlyPostDbOpenHook(() => {
      postFired++;
      if (postFired === 1) renameSync(aLink, path); // B → A (same inode; classic ABA)
    });

    const led = openReadonlyLedger(path);
    try {
      expect(interFired).toBeGreaterThanOrEqual(1);
      expect(postFired).toBeGreaterThanOrEqual(1);

      // The hybrid was rejected and the retry rebound to A: the connection reads A's
      // content ('a'-filled payloads), NOT the B the first attempt briefly opened.
      const row = led.db
        .prepare(`SELECT payload_hash FROM audit_events WHERE seq = 1`)
        .get() as { payload_hash: string };
      expect(row.payload_hash).toBe("a".repeat(64));
      expect(led.identity.inode).toBe(aInode);
      expect(captureLedgerIdentity(led).inode).toBe(aInode);
    } finally {
      led.close();
    }
  });

  it("detects TWO swaps entirely inside the verification bracket (A→B→A→B): stat(path) AGREES with the connection while the companion fd differs — the inverse hybrid", () => {
    // The wing-review scenario class: every path-observation endpoint can be made to
    // agree with SOME party while the parties disagree with each other. Here the
    // connection opens B, the companion fd lands on A (swap-back in the db↔companion
    // gap), then a second swap inside the verify window puts B back on the path — so
    // the closing stat(path) MATCHES the connection's incarnation (B) while the held
    // companion fd names A. If identity were derived from {stat brackets + connection
    // content} alone this would be accepted with a WRONG durable anchor (fd on A).
    // The companion-fd == connection-descriptor requirement rejects it.
    const path = join(dir, "ledger.db");
    seedLedgerWithFill(path, SAME_COUNT, "a"); // A
    const aInode = statSync(path).ino;
    const aLink = join(dir, "A.hardlink.db");
    linkSync(path, aLink); // preserve A's exact inode for the swap-back

    const bPath = join(dir, "B.db");
    seedLedgerWithFill(bPath, SAME_COUNT, "b"); // B: same layout, different content
    const bLink = join(dir, "B.hardlink.db");
    linkSync(bPath, bLink); // preserve B's exact inode for the re-swap

    let interFired = 0;
    let postFired = 0;
    let verifyFired = 0;
    __setReadonlyInterOpenHook(() => {
      interFired++;
      if (interFired === 1) renameSync(bPath, path); // swap 0 (setup): connection opens B
    });
    __setReadonlyPostDbOpenHook(() => {
      postFired++;
      if (postFired === 1) renameSync(aLink, path); // swap 1 (in bracket): companion opens A
    });
    __setReadonlyVerifyWindowHook(() => {
      verifyFired++;
      if (verifyFired === 1) renameSync(bLink, path); // swap 2 (in bracket): stat(path) sees B again
    });

    const led = openReadonlyLedger(path);
    try {
      expect(interFired).toBeGreaterThanOrEqual(1);
      expect(postFired).toBeGreaterThanOrEqual(1);
      expect(verifyFired).toBeGreaterThanOrEqual(1);

      // The first attempt (companion=A, connection=B, path=B) was rejected even
      // though stat(path) agreed with the connection. The retry bound consistently
      // to the file the path stabilized on (B): connection, fd, and identity agree.
      const row = led.db
        .prepare(`SELECT payload_hash FROM audit_events WHERE seq = 1`)
        .get() as { payload_hash: string };
      expect(row.payload_hash).toBe("b".repeat(64));
      const finalInode = statSync(path).ino;
      expect(led.identity.inode).toBe(finalInode);
      expect(led.identity.inode).not.toBe(aInode);
      expect(captureLedgerIdentity(led).inode).toBe(finalInode);
    } finally {
      led.close();
    }
  });

  it("detects fd-number REUSE + a foreign same-magic candidate (round-6 wing finding): the connection's descriptor reuses a pre-snapshot number while a foreign open of A is the only obvious candidate", () => {
    // Attack shape: (1) a pre-snapshot fd closes concurrently, (2) SQLite's open
    // REUSES that number — a number-only diff filters the true connection fd as
    // "pre-existing", (3) a foreign open of A (same inode the companion/path will
    // land on) becomes the SOLE detected candidate. A number-only implementation
    // false-accepts a hybrid (identity=A, connection=B). The (number, dev, ino)
    // snapshot recognizes the reused number as NEW (different inode), yielding TWO
    // magic candidates → ambiguous → fail-closed retry — never a mis-bind.
    const path = join(dir, "ledger.db");
    seedLedgerWithFill(path, SAME_COUNT, "a"); // A
    const aInode = statSync(path).ino;
    const aLink = join(dir, "A.hardlink.db");
    linkSync(path, aLink); // A's exact inode, for the foreign open + swap-back

    const bPath = join(dir, "B.db");
    seedLedgerWithFill(bPath, SAME_COUNT, "b"); // B: what the connection will read

    // Sacrificial pre-snapshot fd — closed inside the inter-open gap so SQLite's
    // main-db open reuses its number.
    const sacrificial = openSync(path, "r");
    let foreignFd = -1;
    let interFired = 0;
    let postFired = 0;
    __setReadonlyInterOpenHook(() => {
      interFired++;
      if (interFired === 1) {
        renameSync(bPath, path); // connection will open B…
        closeSync(sacrificial); // …likely on the sacrificial's reused number
      }
    });
    __setReadonlyPostDbOpenHook(() => {
      postFired++;
      if (postFired === 1) {
        foreignFd = openSync(aLink, "r"); // foreign same-magic candidate on A's inode
        renameSync(aLink, path); // companion + stat(path) will see A
      }
    });

    try {
      const led = openReadonlyLedger(path);
      try {
        expect(interFired).toBeGreaterThanOrEqual(1);
        expect(postFired).toBeGreaterThanOrEqual(1);
        // The fail-closed path MUST have fired: attempt 1 is ambiguous/inconsistent
        // whether or not SQLite actually reused the sacrificial number (reused ⇒ the
        // identity-pair check surfaces it as new alongside the foreign fd = two
        // candidates; not reused ⇒ the true fd and the foreign fd are BOTH new = two
        // candidates) — either way discovery returns null and the opener retries.
        expect(__lastOpenAttempts).toBeGreaterThanOrEqual(2);
        // NEVER a hybrid: whatever the retry converged on, the connection's content,
        // the pinned identity, and the current path file must all describe the SAME
        // incarnation (here: A, since the hooks stopped firing after attempt 1).
        const row = led.db
          .prepare(`SELECT payload_hash FROM audit_events WHERE seq = 1`)
          .get() as { payload_hash: string };
        expect(row.payload_hash).toBe("a".repeat(64));
        expect(led.identity.inode).toBe(aInode);
        expect(statSync(path).ino).toBe(aInode);
        expect(captureLedgerIdentity(led).inode).toBe(aInode);
      } finally {
        led.close();
      }
    } finally {
      if (foreignFd !== -1) closeSync(foreignFd);
    }
  });
});

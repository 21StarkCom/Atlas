/**
 * `source-repo` — the v2 operational `source` registry repository
 * (`0015_source_registry`, #339). Proves the dedup-noop-returns-existing-id
 * contract, `byId`/`byLocator`, deterministic `list`/`count` pagination, and
 * `stampIngested`.
 */
import { describe, expect, it } from "vitest";
import { openStore, SourceRepo, type Store } from "../src/index.js";

function migratedStore(): Store {
  const store = openStore({ path: ":memory:" });
  store.migrate();
  return store;
}

describe("SourceRepo", () => {
  it("isApplied reflects whether 0015 has run", () => {
    const store = openStore({ path: ":memory:" });
    try {
      expect(SourceRepo.isApplied(store.db)).toBe(false);
      store.migrate();
      expect(SourceRepo.isApplied(store.db)).toBe(true);
    } finally {
      store.close();
    }
  });

  it("insert of a fresh locator returns { inserted:true } and the row is readable by id + locator", () => {
    const store = migratedStore();
    try {
      const repo = new SourceRepo(store.db);
      const r = repo.insert({ id: "src-1", kind: "file", locator: "/inbox/a.md", title: "A", addedAt: "2026-07-23T00:00:00Z" });
      expect(r).toEqual({ id: "src-1", inserted: true });

      const byId = repo.byId("src-1");
      expect(byId).toMatchObject({ id: "src-1", kind: "file", locator: "/inbox/a.md", title: "A", addedAt: "2026-07-23T00:00:00Z", lastIngestedAt: null });
      expect(repo.byLocator("/inbox/a.md")?.id).toBe("src-1");
      expect(repo.byId("nope")).toBeUndefined();
      expect(repo.byLocator("nope")).toBeUndefined();
    } finally {
      store.close();
    }
  });

  it("a DUPLICATE locator is a NOOP SUCCESS returning the EXISTING id (inserted:false), even with a different id/title", () => {
    const store = migratedStore();
    try {
      const repo = new SourceRepo(store.db);
      const first = repo.insert({ id: "src-orig", kind: "file", locator: "/inbox/dup.md", title: "orig", addedAt: "2026-07-23T00:00:00Z" });
      expect(first).toEqual({ id: "src-orig", inserted: true });

      // Re-add the SAME locator with a DIFFERENT id + title — noop, returns the existing id.
      const again = repo.insert({ id: "src-different", kind: "url", locator: "/inbox/dup.md", title: "changed", addedAt: "2026-07-24T00:00:00Z" });
      expect(again).toEqual({ id: "src-orig", inserted: false });

      // Exactly ONE row, unchanged (the original id/kind/title/addedAt survive).
      expect(repo.count()).toBe(1);
      expect(repo.byLocator("/inbox/dup.md")).toMatchObject({ id: "src-orig", kind: "file", title: "orig", addedAt: "2026-07-23T00:00:00Z" });
    } finally {
      store.close();
    }
  });

  it("list is ordered (addedAt DESC, id ASC), deterministic across offset; count is the total", () => {
    const store = migratedStore();
    try {
      const repo = new SourceRepo(store.db);
      // Three at the same addedAt (tie → id ASC) + one newer.
      repo.insert({ id: "src-b", kind: "file", locator: "/b", addedAt: "2026-07-23T10:00:00Z" });
      repo.insert({ id: "src-a", kind: "file", locator: "/a", addedAt: "2026-07-23T10:00:00Z" });
      repo.insert({ id: "src-c", kind: "file", locator: "/c", addedAt: "2026-07-23T10:00:00Z" });
      repo.insert({ id: "src-new", kind: "url", locator: "https://x", addedAt: "2026-07-23T11:00:00Z" });

      expect(repo.count()).toBe(4);
      const full = repo.list({ limit: 50, offset: 0 }).map((r) => r.id);
      // newest first, then id ASC among the tie.
      expect(full).toEqual(["src-new", "src-a", "src-b", "src-c"]);

      // Page boundary is stable: page1 ++ page2 === full order, no dup/skip.
      const p1 = repo.list({ limit: 2, offset: 0 }).map((r) => r.id);
      const p2 = repo.list({ limit: 2, offset: 2 }).map((r) => r.id);
      expect([...p1, ...p2]).toEqual(full);
    } finally {
      store.close();
    }
  });

  it("stampIngested sets lastIngestedAt on a known id and is a no-op for an unknown id", () => {
    const store = migratedStore();
    try {
      const repo = new SourceRepo(store.db);
      repo.insert({ id: "src-1", kind: "file", locator: "/inbox/a.md", addedAt: "2026-07-23T00:00:00Z" });
      expect(repo.byId("src-1")?.lastIngestedAt).toBeNull();

      expect(repo.stampIngested("src-1", "2026-07-23T12:00:00Z")).toBe(true);
      expect(repo.byId("src-1")?.lastIngestedAt).toBe("2026-07-23T12:00:00Z");

      expect(repo.stampIngested("nope", "2026-07-23T12:00:00Z")).toBe(false);
    } finally {
      store.close();
    }
  });
});

/**
 * `db.post-restore-hook` — the post-restore rebuild hook registry (fixes R1-F1).
 * Steps run in registration order with the restore context; Task 1.7 registers
 * the projection rebuild and Phase 3 registers the index rebuild.
 */
import { afterEach, describe, expect, it } from "vitest";
import {
  _resetPostRestoreRebuild,
  openStore,
  postRestoreRebuildStepCount,
  registerPostRestoreRebuild,
  runPostRestoreRebuild,
} from "../src/index.js";

afterEach(() => _resetPostRestoreRebuild());

describe("db.post-restore-hook", () => {
  it("runs registered steps in order with the restore context", async () => {
    const store = openStore({ path: ":memory:" });
    store.migrate();
    try {
      const order: string[] = [];
      registerPostRestoreRebuild(async (ctx) => {
        expect(ctx.db).toBe(store.db);
        order.push("first");
      });
      registerPostRestoreRebuild(async () => {
        order.push("second");
      });
      expect(postRestoreRebuildStepCount()).toBe(2);

      await runPostRestoreRebuild({ db: store.db });
      expect(order).toEqual(["first", "second"]);
    } finally {
      store.close();
    }
  });

  it("a fresh registry has no steps", () => {
    expect(postRestoreRebuildStepCount()).toBe(0);
  });
});

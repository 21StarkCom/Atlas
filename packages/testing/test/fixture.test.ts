import { readFile, readdir, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  withFixtureVault,
  type FixtureName,
} from "../src/fixture.js";

const ALL_FIXTURES: FixtureName[] = [
  "empty",
  "small-valid",
  "broken-links",
  "duplicate-ids",
  "conflicting-claims",
  "source-heavy",
  "schema-v1",
];

const FIXTURES_ROOT = resolve(
  fileURLToPath(new URL(".", import.meta.url)),
  "../../../fixtures",
);

describe("withFixtureVault", () => {
  // 60_000: seven fixture copies + git inits routinely exceed vitest's 5 s
  // default on a loaded machine (same budget the apps/cli e2e suites use).
  it("loads all seven fixtures into an isolated temp copy", { timeout: 60_000 }, async () => {
    for (const name of ALL_FIXTURES) {
      let seen = "";
      await withFixtureVault(name, async ({ vaultDir, git }) => {
        seen = vaultDir;
        expect(existsSync(vaultDir)).toBe(true);
        expect(vaultDir).not.toBe(join(FIXTURES_ROOT, name));
        // Fresh git repo with the fixture committed → clean working tree.
        expect(git.isClean()).toBe(true);
        expect(git.head()).toMatch(/^[0-9a-f]{40}$/);
      });
      // Temp dir is torn down after the callback returns.
      expect(existsSync(seen)).toBe(false);
    }
  });

  it("copies small-valid into a clean git repo", async () => {
    await withFixtureVault("small-valid", async ({ vaultDir, git }) => {
      expect(existsSync(join(vaultDir, ".git"))).toBe(true);
      expect(git.isClean()).toBe(true);
      // Every committed note is tracked (nothing untracked, nothing missing).
      const tracked = git.run(["ls-files"]).split("\n").sort();
      expect(tracked).toContain("project-meridian.md");
      expect(tracked).toContain("concept-retrieval.md");
      expect(tracked).toContain("person-aryeh.md");
    });
  });

  it("does not leak mutations back into fixtures/", async () => {
    const notePath = join(FIXTURES_ROOT, "small-valid", "project-meridian.md");
    const before = await readFile(notePath, "utf8");
    const beforeEntries = (await readdir(join(FIXTURES_ROOT, "small-valid"))).sort();

    await withFixtureVault("small-valid", async ({ vaultDir }) => {
      // Mutate an existing file and add a new one inside the copy.
      await writeFile(
        join(vaultDir, "project-meridian.md"),
        "MUTATED — this must never reach fixtures/\n",
      );
      await writeFile(join(vaultDir, "injected.md"), "leak check\n");
    });

    // The committed fixture is byte-for-byte unchanged and gained no files.
    expect(await readFile(notePath, "utf8")).toBe(before);
    expect((await readdir(join(FIXTURES_ROOT, "small-valid"))).sort()).toEqual(
      beforeEntries,
    );
    expect(existsSync(join(FIXTURES_ROOT, "small-valid", "injected.md"))).toBe(
      false,
    );
  });

  it("removes the temp copy even when the callback throws", async () => {
    let captured = "";
    await expect(
      withFixtureVault("empty", async ({ vaultDir }) => {
        captured = vaultDir;
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
    expect(captured).not.toBe("");
    expect(existsSync(captured)).toBe(false);
  });

  it("duplicate-ids really contains a duplicate id pair", async () => {
    const dir = join(FIXTURES_ROOT, "duplicate-ids");
    const files = (await readdir(dir)).filter((f) => f.endsWith(".md"));
    const ids: string[] = [];
    for (const f of files) {
      const text = await readFile(join(dir, f), "utf8");
      const m = /^id:\s*(\S+)\s*$/m.exec(text);
      if (m?.[1]) ids.push(m[1]);
    }
    expect(ids.length).toBeGreaterThanOrEqual(2);
    // At least one id value is shared by two distinct notes.
    const counts = new Map<string, number>();
    for (const id of ids) counts.set(id, (counts.get(id) ?? 0) + 1);
    const dupes = [...counts.entries()].filter(([, n]) => n >= 2);
    expect(dupes.length).toBeGreaterThanOrEqual(1);
  });

  it("preserves the raw C1 CSI adversarial bytes in adversarial-ansi.md", async () => {
    const buf = await readFile(
      join(FIXTURES_ROOT, "inputs", "adversarial-ansi.md"),
    );
    // The C1 control introducer is a single raw 0x9b byte followed directly by
    // the SGR parameters — no stray bytes in between, or it is not a valid C1
    // CSI sequence. Assert the exact 0x9b 31m (set) and 0x9b 0m (reset) bytes.
    const setSeq = Buffer.from([0x9b, 0x33, 0x31, 0x6d]); // 0x9b "31m"
    const resetSeq = Buffer.from([0x9b, 0x30, 0x6d]); // 0x9b "0m"
    expect(buf.includes(setSeq)).toBe(true);
    expect(buf.includes(resetSeq)).toBe(true);
    // Guard against the earlier bug where literal 0x22 quotes followed 0x9b.
    expect(buf.includes(Buffer.from([0x9b, 0x22]))).toBe(false);
  });

  it("throws for an unknown fixture name", async () => {
    await expect(
      // @ts-expect-error — intentionally invalid name at the type level.
      withFixtureVault("does-not-exist", async () => {}),
    ).rejects.toThrow(/fixture vault not found/);
  });
});

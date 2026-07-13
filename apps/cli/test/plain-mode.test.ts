/**
 * plain-mode.announcements — append-only progress under degraded output.
 *
 * A long-running command in plain mode must emit discrete `started/progress/done`
 * lines with NO in-place redraw (no CR) and NO duplicated consecutive lines.
 */
import { describe, it, expect } from "vitest";
import { createProgress, isDegraded } from "../src/render/progress.js";
import { resolveOutputMode } from "../src/render/plain.js";

function capture(): NodeJS.WritableStream & { lines: () => string[] } {
  let text = "";
  return {
    write(chunk: string | Uint8Array): boolean {
      text += typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8");
      return true;
    },
    lines(): string[] {
      return text.split("\n").filter((l) => l.length > 0);
    },
  } as NodeJS.WritableStream & { lines: () => string[] };
}

describe("plain-mode.announcements", () => {
  it("emits append-only started / progress:N/M / done lines", () => {
    const out = capture();
    const p = createProgress({ mode: "human", quiet: false, stream: out });
    p.started("reindexing");
    p.progress(1, 3, "notes");
    p.progress(2, 3, "notes");
    p.progress(3, 3, "notes");
    p.done("reindexing");
    expect(out.lines()).toEqual([
      "started: reindexing",
      "progress: 1/3 notes",
      "progress: 2/3 notes",
      "progress: 3/3 notes",
      "done: reindexing",
    ]);
  });

  it("never emits a carriage return (no in-place redraw)", () => {
    const out = capture();
    const p = createProgress({ mode: "human", quiet: false, stream: out });
    p.started("x");
    p.progress(1, 2);
    p.done();
    expect(out.lines().join("\n")).not.toContain("\r");
  });

  it("suppresses a duplicated consecutive line (non-duplicated)", () => {
    const out = capture();
    const p = createProgress({ mode: "human", quiet: false, stream: out });
    p.progress(1, 10);
    p.progress(1, 10); // identical → suppressed
    p.progress(2, 10);
    expect(out.lines()).toEqual(["progress: 1/10", "progress: 2/10"]);
  });

  it("emits started and done at most once", () => {
    const out = capture();
    const p = createProgress({ mode: "human", quiet: false, stream: out });
    p.started("a");
    p.started("b"); // ignored
    p.done();
    p.done(); // ignored
    expect(out.lines()).toEqual(["started: a", "done"]);
  });

  it("emits nothing in json mode", () => {
    const out = capture();
    const p = createProgress({ mode: "json", quiet: false, stream: out });
    p.started("a");
    p.progress(1, 1);
    p.done();
    expect(out.lines()).toEqual([]);
  });

  it("emits nothing when quiet", () => {
    const out = capture();
    const p = createProgress({ mode: "human", quiet: true, stream: out });
    p.started("a");
    p.done();
    expect(out.lines()).toEqual([]);
  });

  describe("degradation detection", () => {
    const nonTty = { isTTY: false } as unknown as NodeJS.WritableStream;
    const tty = { isTTY: true } as unknown as NodeJS.WritableStream;

    it("treats a non-TTY stdout as degraded", () => {
      expect(isDegraded({}, nonTty)).toBe(true);
      expect(resolveOutputMode({}, {}, nonTty).plain).toBe(true);
    });

    it("honors NO_COLOR / TERM=dumb / --plain / --no-color on a TTY", () => {
      expect(isDegraded({ NO_COLOR: "1" }, tty)).toBe(true);
      expect(isDegraded({ TERM: "dumb" }, tty)).toBe(true);
      expect(resolveOutputMode({ plain: true }, {}, tty).plain).toBe(true);
      expect(resolveOutputMode({ noColor: true }, {}, tty).plain).toBe(true);
      expect(resolveOutputMode({}, {}, tty).plain).toBe(false);
    });

    it("resolves json/quiet/verbose flags", () => {
      const m = resolveOutputMode({ json: true, quiet: true, verbose: true }, {}, tty);
      expect(m).toMatchObject({ mode: "json", quiet: true, verbose: true });
    });
  });
});

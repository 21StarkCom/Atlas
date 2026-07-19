/**
 * `watch.flags` (SP-1 Phase 3 Task 1) — the §6a flag table subset: boundary
 * values + invalid neighbors for every watch flag, missing-`--json` (via a
 * non-json output mode), and the `--once ⊥ --since-seq` exclusion — each invalid
 * form a usage error (exit 5) raised BEFORE any ledger/broker access.
 */
import { describe, expect, it } from "vitest";
import { parseWatchFlags } from "../src/commands/watch.js";
import { CliError } from "../src/errors/envelope.js";

function usageOf(fn: () => unknown): CliError {
  try {
    fn();
  } catch (e) {
    expect(e).toBeInstanceOf(CliError);
    expect((e as CliError).exitCode).toBe(5);
    return e as CliError;
  }
  throw new Error("expected a usage error");
}

describe("parseWatchFlags", () => {
  it("rejects any non-json output mode (watch is machine-only)", () => {
    for (const mode of ["human", "plain", "quiet"]) {
      const e = usageOf(() => parseWatchFlags([], mode));
      expect(e.message).toContain("--json");
    }
  });

  it("defaults: --poll-ms 500, --heartbeat-seconds 30, no replay, not once", () => {
    expect(parseWatchFlags([], "json")).toEqual({ once: false, pollMs: 500, heartbeatSeconds: 30 });
  });

  it("--since-seq boundaries: -1 ok (replay from row 0), 0 ok; -2 and junk rejected", () => {
    expect(parseWatchFlags(["--since-seq", "-1"], "json").sinceSeq).toBe(-1);
    expect(parseWatchFlags(["--since-seq", "0"], "json").sinceSeq).toBe(0);
    expect(parseWatchFlags(["--since-seq=907"], "json").sinceSeq).toBe(907);
    for (const bad of ["-2", "1e2", "0x10", "", "abc", "1.5", "01"]) {
      usageOf(() => parseWatchFlags(["--since-seq", bad], "json"));
    }
    usageOf(() => parseWatchFlags(["--since-seq"], "json")); // missing value
  });

  it("--poll-ms boundaries: 100/10000 ok; 99/10001/junk rejected", () => {
    expect(parseWatchFlags(["--poll-ms", "100"], "json").pollMs).toBe(100);
    expect(parseWatchFlags(["--poll-ms", "10000"], "json").pollMs).toBe(10000);
    for (const bad of ["99", "10001", "-1", "1e3", ""]) {
      usageOf(() => parseWatchFlags(["--poll-ms", bad], "json"));
    }
  });

  it("--heartbeat-seconds boundaries: 5/300 ok; 4/301/junk rejected", () => {
    expect(parseWatchFlags(["--heartbeat-seconds", "5"], "json").heartbeatSeconds).toBe(5);
    expect(parseWatchFlags(["--heartbeat-seconds", "300"], "json").heartbeatSeconds).toBe(300);
    for (const bad of ["4", "301", "0", ""]) {
      usageOf(() => parseWatchFlags(["--heartbeat-seconds", bad], "json"));
    }
  });

  it("--once is a bare flag; --once --since-seq is mutually exclusive (either order)", () => {
    expect(parseWatchFlags(["--once"], "json").once).toBe(true);
    usageOf(() => parseWatchFlags(["--once=1"], "json"));
    usageOf(() => parseWatchFlags(["--once", "--since-seq", "3"], "json"));
    usageOf(() => parseWatchFlags(["--since-seq", "3", "--once"], "json"));
  });

  it("unknown flags/arguments are usage errors", () => {
    usageOf(() => parseWatchFlags(["--follow"], "json"));
    usageOf(() => parseWatchFlags(["extra"], "json"));
  });
});

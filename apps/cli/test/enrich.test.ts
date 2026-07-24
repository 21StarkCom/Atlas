/**
 * `enrich` (Task 4.11) — the argument parser + preview-output mapper for the model-authored
 * single-note enrichment command. The full apply pipeline (retrieval-first plan → tier → integrate)
 * is exercised by `enrich.e2e` against a real index + egress; these are the pure-logic guards.
 */
import { describe, expect, it } from "vitest";
import { parseArgs, enrichPreviewOutput } from "../src/commands/enrich.js";
import type { SynthesisPlan } from "../src/workflows/synthesis.js";

function plan(over: Partial<SynthesisPlan> = {}): SynthesisPlan {
  return {
    retrievalRunId: "ret-1",
    changePlan: { target: "note-a", operation: { op: "AppendSection", opVersion: 1, content: "x", createIfAbsent: true, selector: { path: "Log" } } } as never,
    report: { ok: true, findings: [], gates: {} } as never,
    patch: { ops: [{ kind: "insert" }, { kind: "insert" }] } as never,
    ...over,
  };
}

describe("enrich argument parsing (Task 4.11)", () => {
  it("parses <note> + defaults to preview (no --apply)", () => {
    expect(parseArgs(["note-a"])).toEqual({ note: "note-a", apply: false, dryRun: false });
  });
  it("accepts --apply and --dry-run (individually) and --idempotency-key", () => {
    expect(parseArgs(["note-a", "--apply"]).apply).toBe(true);
    expect(parseArgs(["note-a", "--dry-run"]).dryRun).toBe(true);
    expect(parseArgs(["note-a", "--idempotency-key", "k"])).toEqual({ note: "note-a", apply: false, dryRun: false });
  });
  it("rejects a missing <note>, an unknown flag, a second positional, and --dry-run+--apply", () => {
    expect(() => parseArgs([])).toThrow(/expected a <note>/);
    expect(() => parseArgs(["note-a", "--nope"])).toThrow(/unknown flag/);
    expect(() => parseArgs(["note-a", "note-b"])).toThrow(/unexpected argument/);
    expect(() => parseArgs(["note-a", "--apply", "--dry-run"])).toThrow(/mutually exclusive/);
  });
});

describe("enrich preview-output mapping (Task 4.11)", () => {
  it("maps a validated, patchable plan → preview envelope with changedLines + sections", () => {
    const out = enrichPreviewOutput("run-1", plan());
    expect(out).toMatchObject({ command: "enrich", mode: "preview", runId: "run-1", changedLines: 2, sections: 1 });
    expect((out.plan as { operation: string; ok: boolean }).operation).toBe("AppendSection");
    expect((out.plan as { ok: boolean }).ok).toBe(true);
  });
  it("an unpatchable plan omits changedLines/sections and reports the invalid plan", () => {
    const out = enrichPreviewOutput("run-2", plan({ patch: null, report: { ok: false, findings: [], gates: {} } as never }));
    expect(out).toMatchObject({ command: "enrich", mode: "preview" });
    expect(out).not.toHaveProperty("changedLines");
    expect(out).not.toHaveProperty("sections");
    expect((out.plan as { ok: boolean }).ok).toBe(false);
  });
});

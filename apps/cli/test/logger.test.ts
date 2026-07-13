/**
 * diag — structured JSONL logging: run/job correlation, redaction boundary,
 * rotation + retention.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, readFileSync, readdirSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createLoggerFactory, redact, sanitizeMessage } from "../src/diag/logger.js";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "atlas-logs-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

function lines(file = "atlas.log"): Record<string, unknown>[] {
  const p = join(dir, file);
  if (!existsSync(p)) return [];
  return readFileSync(p, "utf8")
    .split("\n")
    .filter((l) => l.length > 0)
    .map((l) => JSON.parse(l) as Record<string, unknown>);
}

describe("diag logger", () => {
  it("writes one JSONL object per call with ts/level/msg and runId correlation", () => {
    const f = createLoggerFactory({ dir, maxBytes: 1_000_000, maxFiles: 5, now: () => "T" });
    const log = f.diag("run-123");
    log.info("hello", { count: 3 });
    log.warn("careful");
    const rows = lines();
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({ ts: "T", level: "info", runId: "run-123", msg: "hello", count: 3 });
    expect(rows[1]).toMatchObject({ level: "warn", runId: "run-123", msg: "careful" });
  });

  it("child() binds context (e.g. jobId) onto every subsequent line", () => {
    const f = createLoggerFactory({ dir, maxBytes: 1_000_000, maxFiles: 5, now: () => "T" });
    const log = f.diag("r1").child({ jobId: "job-9" });
    log.info("x");
    expect(lines()[0]).toMatchObject({ runId: "r1", jobId: "job-9", msg: "x" });
  });

  it("omits runId when null", () => {
    const f = createLoggerFactory({ dir, maxBytes: 1_000_000, maxFiles: 5, now: () => "T" });
    f.diag(null).info("x");
    expect(lines()[0]).not.toHaveProperty("runId");
  });

  it("REDACTS raw prompts/quotes/secrets at the logging boundary", () => {
    const f = createLoggerFactory({ dir, maxBytes: 1_000_000, maxFiles: 5, now: () => "T" });
    const log = f.diag("r1");
    log.info("provider.call", {
      model: "gemini-3-5-flash",
      prompt: "SECRET PROMPT TEXT",
      quote: "verbatim source quote",
      apiKey: "sk-live-abc",
      nested: { secret: "x", token: "y", ok: "keep" },
    });
    const raw = readFileSync(join(dir, "atlas.log"), "utf8");
    expect(raw).not.toContain("SECRET PROMPT TEXT");
    expect(raw).not.toContain("verbatim source quote");
    expect(raw).not.toContain("sk-live-abc");
    const row = lines()[0]!;
    expect(row.model).toBe("gemini-3-5-flash"); // allowlisted metadata survives
    expect(row.prompt).toBe("[redacted]");
    expect(row.quote).toBe("[redacted]");
    expect(row.apiKey).toBe("[redacted]");
    expect(row.nested).toMatchObject({ secret: "[redacted]", token: "[redacted]", ok: "keep" });
  });

  it("REDACTS a free-form / sensitive msg string (only stable event ids survive)", () => {
    const f = createLoggerFactory({ dir, maxBytes: 1_000_000, maxFiles: 5, now: () => "T" });
    const log = f.diag("r1");
    // A raw prompt or exception message passed AS the msg must not reach the log.
    log.info("Summarize this: SECRET PROMPT TEXT with sk-live-abc");
    log.error("Error: connection to https://user:pw@host failed");
    // A stable event identifier is preserved verbatim.
    log.info("backup.unhealthy");
    const raw = readFileSync(join(dir, "atlas.log"), "utf8");
    expect(raw).not.toContain("SECRET PROMPT TEXT");
    expect(raw).not.toContain("sk-live-abc");
    expect(raw).not.toContain("user:pw");
    const rows = lines();
    expect(rows[0]!.msg).toBe("[redacted-message]");
    expect(rows[1]!.msg).toBe("[redacted-message]");
    expect(rows[2]!.msg).toBe("backup.unhealthy");
  });

  it("sanitizeMessage keeps stable event ids and redacts everything else", () => {
    expect(sanitizeMessage("command.start")).toBe("command.start");
    expect(sanitizeMessage("backup-unhealthy")).toBe("backup-unhealthy");
    expect(sanitizeMessage("locked:vault-maintenance")).toBe("locked:vault-maintenance");
    expect(sanitizeMessage("hello world")).toBe("[redacted-message]"); // whitespace
    expect(sanitizeMessage("SECRET sk-live-abc")).toBe("[redacted-message]");
    expect(sanitizeMessage("x".repeat(100))).toBe("[redacted-message]"); // too long
    expect(sanitizeMessage(undefined)).toBe("[redacted-message]");
  });

  it("respects minLevel (info suppresses debug)", () => {
    const f = createLoggerFactory({ dir, maxBytes: 1_000_000, maxFiles: 5, now: () => "T", minLevel: "info" });
    const log = f.diag("r1");
    log.debug("noise");
    log.info("signal");
    const rows = lines();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ msg: "signal" });
  });

  it("rotates when the active file would exceed maxBytes and retains maxFiles", () => {
    // Tiny cap so each line rotates; keep 3 files total (active + .1 + .2).
    const f = createLoggerFactory({ dir, maxBytes: 80, maxFiles: 3, now: () => "T" });
    const log = f.diag("r1");
    for (let i = 0; i < 10; i++) log.info(`line-${i}-padpadpadpadpadpadpadpadpad`);
    const files = readdirSync(dir).filter((n) => n.startsWith("atlas.log")).sort();
    // active + at most (maxFiles-1) rotated.
    expect(files).toContain("atlas.log");
    expect(files.length).toBeLessThanOrEqual(3);
    expect(files).not.toContain("atlas.log.3"); // retention drops beyond maxFiles
  });

  it("redact() is a pure recursive scrub", () => {
    expect(redact({ a: 1, password: "p", deep: [{ token: "t", keep: "k" }] })).toEqual({
      a: 1,
      password: "[redacted]",
      deep: [{ token: "[redacted]", keep: "k" }],
    });
  });

  it("caller ctx cannot spoof reserved fields (msg/runId/ts/level/jobId win)", () => {
    const f = createLoggerFactory({ dir, maxBytes: 1_000_000, maxFiles: 5, now: () => "TRUSTED" });
    const log = f.diag("real-run").child({ jobId: "real-job" });
    log.info("real-event", {
      msg: "SPOOFED",
      runId: "attacker",
      jobId: "attacker-job",
      ts: "FAKE",
      level: "error",
      extra: "kept",
    } as never);
    const rec = lines()[0];
    expect(rec).toMatchObject({
      ts: "TRUSTED",
      level: "info",
      runId: "real-run",
      jobId: "real-job",
      msg: "real-event",
      extra: "kept",
    });
  });
});

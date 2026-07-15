/**
 * `capture.scans-before-persist` (Task 2.6 / #32) — THE acceptance invariant (R4-F3).
 *
 * A secret-bearing source must yield NO persistence on ANY sink: no vault write, no SQLite
 * (not even an empty DB/WAL from opening+migrating), no agent worktree, no git object, no
 * temp remnant. It must be quarantined and refuse with exit 3.
 *
 * A prior implementation of this task VIOLATED exactly this: it opened + migrated the store
 * while assembling dependencies, BEFORE scanning, so a secret-bearing `source add` created
 * the DB/WAL/schema and only THEN exited 3. `CaptureDeps` therefore makes every mutating
 * dependency a LAZY factory (`openStore`, `connectIntegration`), and this test proves those
 * factories are NEVER INVOKED for a secret-bearing source — the strongest available form of
 * "nothing was persisted", since the sinks are never even constructed.
 */
import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, readdirSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PrePersistenceGuard, SecretDetectedError, type QuarantineSink, type SecretFinding } from "@atlas/scan";
import { captureSource, type CaptureDeps } from "../src/ingest/capture.js";

/** Records what was quarantined, so we can assert quarantine-before-throw. */
class RecordingSink implements QuarantineSink {
  readonly entries: { bytes: Uint8Array; origin: string; findings: readonly SecretFinding[] }[] = [];
  quarantine(input: { bytes: Uint8Array; origin: string; findings: readonly SecretFinding[] }): Promise<void> {
    this.entries.push({ bytes: Uint8Array.from(input.bytes), origin: input.origin, findings: input.findings });
    return Promise.resolve();
  }
}

let base: string;
beforeEach(() => {
  base = mkdtempSync(join(tmpdir(), "atlas-capture-sbp-"));
});
afterEach(() => rmSync(base, { recursive: true, force: true }));

describe("captureSource scans BEFORE it persists (R4-F3)", () => {
  it("a secret-bearing source: mutating deps are NEVER constructed, nothing persists, quarantined, exit 3", async () => {
    // A live-format AWS key assembled at runtime (never a committed literal — the repo is public).
    const secret = "AKIA" + "A".repeat(16);
    const srcPath = join(base, "leaky.md");
    writeFileSync(srcPath, `# Note\n\nembedded credential: ${secret}\n`, "utf8");

    const vaultDir = join(base, "vault");
    const dbPath = join(base, "atlas.db");
    const worktreesPath = join(base, "worktrees");

    // Every MUTATING dependency is a spy factory. If capture touches a sink before scanning,
    // it must call one of these — so "never called" IS the no-persistence proof.
    let openStoreCalls = 0;
    let connectIntegrationCalls = 0;

    const deps = {
      openStore: () => {
        openStoreCalls++;
        throw new Error("openStore must NOT be called for a secret-bearing source (scan-before-persist)");
      },
      connectIntegration: () => {
        connectIntegrationCalls++;
        throw new Error("connectIntegration must NOT be called for a secret-bearing source");
      },
      repo: {} as CaptureDeps["repo"],
      backup: {} as CaptureDeps["backup"],
      worktreesPath,
      vaultPath: vaultDir,
    } as unknown as CaptureDeps;

    const sink = new RecordingSink();
    const guard = new PrePersistenceGuard(sink);

    let thrown: unknown;
    let result: unknown;
    try {
      result = await captureSource({ path: srcPath, guard, deps });
    } catch (e) {
      thrown = e;
    }

    // 1. No rendition/result, and the exit-3 secret refusal.
    expect(result).toBeUndefined();
    expect(thrown).toBeInstanceOf(SecretDetectedError);
    expect((thrown as SecretDetectedError).exitCode).toBe(3);

    // 2. The offending bytes WERE quarantined (quarantine-before-throw).
    expect(sink.entries.length).toBeGreaterThanOrEqual(1);
    expect(sink.entries[0]!.origin).toBe(srcPath);
    expect(sink.entries[0]!.findings.length).toBeGreaterThanOrEqual(1);

    // 3. THE INVARIANT: no mutating dependency was ever even CONSTRUCTED.
    expect(openStoreCalls).toBe(0);
    expect(connectIntegrationCalls).toBe(0);

    // 4. …and nothing landed on any real sink: no DB (or -wal/-shm), no vault, no worktree.
    expect(existsSync(dbPath)).toBe(false);
    expect(existsSync(`${dbPath}-wal`)).toBe(false);
    expect(existsSync(`${dbPath}-shm`)).toBe(false);
    expect(existsSync(vaultDir)).toBe(false);
    const worktreeLeftovers = existsSync(worktreesPath) ? readdirSync(worktreesPath) : [];
    expect(worktreeLeftovers).toEqual([]);
  });
});

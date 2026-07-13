/**
 * `normalize.mandatory-quarantine.test` (Task 2.4, finding 7) — a worker scan-rejection
 * whose quarantine payload is ABSENT (or empty) must STILL quarantine a valid, non-empty
 * artifact and refuse exit-3, never throw a synthetic `SecretDetectedError` without
 * quarantining anything.
 *
 * The confined worker builds the offending-bytes payload with `buildQuarantineSample`,
 * which can (in principle) return `null` — leaving the control message with no
 * `quarantineB64`. The pre-fix `normalize` then threw the exit-3 error WITHOUT any
 * quarantine, so a secret-bearing source could merely reject. Now the trusted RAW snapshot
 * is quarantined unconditionally as the fallback artifact.
 *
 * The sandbox is MOCKED here (host-independent): we drive `normalize`'s scan-rejection
 * branch directly by making `runInSandbox` return a payload-less scan-rejection, and assert
 * the raw snapshot lands in quarantine before the throw.
 */
import { describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PrePersistenceGuard, SecretDetectedError, type QuarantineSink, type SecretFinding } from "@atlas/scan";

// Mock the sandbox launcher so `normalize` exercises its scan-rejection branch without a
// real confined worker. `normalize` imports `runInSandbox` from this module.
vi.mock("../src/sandbox/launcher.js", () => ({ runInSandbox: vi.fn() }));

import { runInSandbox } from "../src/sandbox/launcher.js";
import { normalize } from "../src/normalize/index.js";
import type { WorkerResult } from "../src/index.js";

/** Records exactly what was quarantined so the test can assert the fallback artifact. */
class RecordingSink implements QuarantineSink {
  readonly entries: { bytes: Uint8Array; origin: string; findings: readonly SecretFinding[] }[] = [];
  quarantine(input: { bytes: Uint8Array; origin: string; findings: readonly SecretFinding[] }): Promise<void> {
    this.entries.push({ bytes: input.bytes.slice(), origin: input.origin, findings: input.findings });
    return Promise.resolve();
  }
}

/** A payload-less / empty-payload scan-rejection the mocked worker returns. */
function scanRejection(quarantineBytes?: Uint8Array): WorkerResult {
  return {
    ok: false,
    kind: "scan-rejection",
    code: "secret-detected",
    exit: 3,
    scannerRulesetVersion: 1,
    ...(quarantineBytes !== undefined ? { quarantineBytes } : {}),
  };
}

describe("normalize mandates a non-empty quarantine artifact on every scan rejection (finding 7)", () => {
  for (const [label, payload] of [
    ["ABSENT", undefined],
    ["EMPTY", new Uint8Array(0)],
  ] as const) {
    it(`a scan-rejection with an ${label} payload quarantines the raw snapshot and refuses exit-3`, async () => {
      vi.mocked(runInSandbox).mockResolvedValue(scanRejection(payload));

      const dir = mkdtempSync(join(tmpdir(), "atlas-mandatory-q-"));
      try {
        // A CLEAN raw source (passes the pre-parse raw scan); the "secret" is only reported
        // by the (mocked) in-sandbox normalized-output scan, with no bytes attached.
        const body = "# Note\n\nordinary prose, no matchable secret in the raw bytes.\n";
        const path = join(dir, "source.md");
        writeFileSync(path, body, "utf8");

        const sink = new RecordingSink();
        const guard = new PrePersistenceGuard(sink);

        let thrown: unknown;
        let result: unknown;
        try {
          result = await normalize({ path, guard });
        } catch (e) {
          thrown = e;
        }

        // No rendition, exit-3 refusal …
        expect(result).toBeUndefined();
        expect(thrown).toBeInstanceOf(SecretDetectedError);
        expect((thrown as SecretDetectedError).exitCode).toBe(3);
        // … and a MANDATORY non-empty artifact landed in quarantine: the raw snapshot.
        expect(sink.entries.length).toBe(1);
        expect(sink.entries[0]!.origin).toBe(path);
        expect(sink.entries[0]!.bytes.length).toBeGreaterThan(0);
        expect(new TextDecoder().decode(sink.entries[0]!.bytes)).toBe(body);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });
  }

  it("an EMPTY raw source + absent payload still quarantines a non-empty sentinel (round-2 finding)", async () => {
    // The degenerate case the round-2 finding names: with BOTH an empty raw source AND an
    // absent worker payload, quarantining the raw snapshot would create an EMPTY artifact,
    // violating the mandatory non-empty invariant. `quarantineRejection` must substitute a
    // deterministic non-empty sentinel instead — never an empty artifact.
    vi.mocked(runInSandbox).mockResolvedValue(scanRejection(undefined));

    const dir = mkdtempSync(join(tmpdir(), "atlas-empty-q-"));
    try {
      const path = join(dir, "source.md");
      writeFileSync(path, new Uint8Array(0)); // EMPTY raw source

      const sink = new RecordingSink();
      const guard = new PrePersistenceGuard(sink);

      let thrown: unknown;
      try {
        await normalize({ path, guard });
      } catch (e) {
        thrown = e;
      }

      expect(thrown).toBeInstanceOf(SecretDetectedError);
      expect((thrown as SecretDetectedError).exitCode).toBe(3);
      expect(sink.entries.length).toBe(1);
      // The mandatory artifact is non-empty even though the raw snapshot was empty.
      expect(sink.entries[0]!.bytes.length).toBeGreaterThan(0);
      expect(new TextDecoder().decode(sink.entries[0]!.bytes)).toContain("empty source quarantined");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

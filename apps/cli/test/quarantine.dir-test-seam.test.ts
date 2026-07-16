/**
 * `quarantine.dir-test-seam` (#144) — under the gated test seam
 * (`ATLAS_TEST_MODE=1` + `ATLAS_CUSTODY_TEST_DIR`), an UNSET `quarantine.dir`
 * defaults to a dedicated subdir of the test custody root, NOT the shared OS
 * state dir. Without this, e2e fixtures that quarantine wrote into
 * `~/Library/Application Support/atlas/quarantine` and a host carrying real
 * bundles failed `doctor`. An explicit config value still wins, and the seam is
 * ignored outside test mode (production keeps the OS state dir).
 */
import { describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { quarantineDir } from "../src/quarantine/config.js";
import type { RunContext } from "../src/main.js";

function ctx(opts: { env: NodeJS.ProcessEnv; configuredDir?: string; root: string }): RunContext {
  return {
    cwd: join(opts.root, "work"),
    env: opts.env,
    config: {
      config: {
        vault: { path: join(opts.root, "vault") },
        quarantine: { dir: opts.configuredDir, keep: 200, retention_days: 30, key_id: "cli-custody-v1", revoked_key_ids: [] },
      },
    },
  } as unknown as RunContext;
}

describe("quarantine dir — test-mode custody seam (#144)", () => {
  it("defaults into the test custody root under ATLAS_TEST_MODE + ATLAS_CUSTODY_TEST_DIR", () => {
    const root = mkdtempSync(join(tmpdir(), "atlas-qseam-"));
    try {
      const custody = join(root, "custody");
      const dir = quarantineDir(ctx({ root, env: { ATLAS_TEST_MODE: "1", ATLAS_CUSTODY_TEST_DIR: custody } }));
      expect(dir).toBe(join(custody, "quarantine-store"));
      expect(dir).not.toContain("Application Support"); // never the shared OS state dir
      expect(dir).not.toContain(".local/state");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("an explicit quarantine.dir still wins over the seam", () => {
    const root = mkdtempSync(join(tmpdir(), "atlas-qseam-"));
    try {
      const custody = join(root, "custody");
      const explicit = join(root, "explicit-q");
      const dir = quarantineDir(ctx({ root, configuredDir: explicit, env: { ATLAS_TEST_MODE: "1", ATLAS_CUSTODY_TEST_DIR: custody } }));
      expect(dir).toBe(explicit);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("the seam is ignored outside test mode (production keeps the OS state dir)", () => {
    const root = mkdtempSync(join(tmpdir(), "atlas-qseam-"));
    try {
      // Custody dir set but ATLAS_TEST_MODE unset → seam ignored; XDG pins a
      // deterministic non-custody default so the assertion is host-independent.
      const dir = quarantineDir(ctx({ root, env: { ATLAS_CUSTODY_TEST_DIR: join(root, "custody"), XDG_STATE_HOME: join(root, "xdg") } }));
      expect(dir).toBe(join(root, "xdg", "atlas", "quarantine"));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

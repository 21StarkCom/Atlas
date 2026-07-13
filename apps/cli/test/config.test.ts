import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, writeFileSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "../src/config/load.js";
import { ConfigError } from "../src/config/schema.js";

const REPO_ROOT = join(import.meta.dirname, "..", "..", "..");
const EXAMPLE = readFileSync(join(REPO_ROOT, "brain.config.example.yaml"), "utf8");

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "atlas-config-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function writeConfig(text: string): void {
  writeFileSync(join(dir, "brain.config.yaml"), text, "utf8");
}

describe("loadConfig", () => {
  it("loads and validates the shipped example config", () => {
    writeConfig(EXAMPLE);
    const { config } = loadConfig(dir, {});
    expect(config.indexing.dimensions).toBe(768); // D7
    expect(config.indexing.chunker_version).toBe(1); // D4
    expect(config.sqlite.ledger_backup.keep).toBe(10);
    expect(config.git.auto_commit_risk_levels).toEqual([1, 2]);
    expect(config.policies.tier2_min_confidence).toBe(0.8);
  });

  it("produces a stable canonical hash for identical config", () => {
    writeConfig(EXAMPLE);
    const a = loadConfig(dir, {}).hash;
    const b = loadConfig(dir, {}).hash;
    expect(a).toBe(b);
    expect(a).toMatch(/^sha256:[0-9a-f]{64}$/);
  });

  it("throws ConfigError (exit 2) naming the offending key on an invalid value", () => {
    writeConfig(EXAMPLE.replace("dimensions: 768", "dimensions: not-a-number"));
    try {
      loadConfig(dir, {});
      throw new Error("expected ConfigError");
    } catch (e) {
      expect(e).toBeInstanceOf(ConfigError);
      const ce = e as ConfigError;
      expect(ce.exitCode).toBe(2);
      expect(ce.location.key).toContain("indexing.dimensions");
    }
  });

  it("throws ConfigError when the file is missing", () => {
    const e = (() => {
      try {
        loadConfig(dir, {});
      } catch (err) {
        return err;
      }
    })();
    expect(e).toBeInstanceOf(ConfigError);
    expect((e as ConfigError).location.file).toContain("brain.config.yaml");
  });

  it("rejects an unknown key via strict schema", () => {
    writeConfig(EXAMPLE + "\nbogus_section:\n  x: 1\n");
    expect(() => loadConfig(dir, {})).toThrow(ConfigError);
  });

  it("applies a top-level-of-section env override (ATLAS_INDEXING_DIMENSIONS)", () => {
    writeConfig(EXAMPLE);
    const { config } = loadConfig(dir, { ATLAS_INDEXING_DIMENSIONS: "512" });
    expect(config.indexing.dimensions).toBe(512);
  });

  it("applies a nested env override (ATLAS_SQLITE_LEDGER_BACKUP_KEEP)", () => {
    writeConfig(EXAMPLE);
    const { config } = loadConfig(dir, { ATLAS_SQLITE_LEDGER_BACKUP_KEEP: "25" });
    expect(config.sqlite.ledger_backup.keep).toBe(25);
  });

  it("env override wins over the file value and validates", () => {
    writeConfig(EXAMPLE);
    const { config } = loadConfig(dir, { ATLAS_SQLITE_RAW_PAYLOAD_STORE: "true" });
    expect(config.sqlite.raw_payload_store).toBe(true);
  });

  it("honors an absolute --config override path", () => {
    const alt = join(dir, "custom.yaml");
    writeFileSync(alt, EXAMPLE, "utf8");
    const { path } = loadConfig(dir, {}, alt);
    expect(path).toBe(alt);
  });
});

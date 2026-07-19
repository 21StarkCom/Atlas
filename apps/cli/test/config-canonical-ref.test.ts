/**
 * `git.canonical_ref` + `vault.note_globs` config contract (60-A task 1.1).
 *
 * canonical_ref defaults to the single shared DEFAULT_CANONICAL_REF and rejects
 * empty / non-`refs/` / audit-or-trust-colliding values; note_globs defaults to
 * `['**\/*.md']` and needs ≥ 1 entry.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, writeFileSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_CANONICAL_REF } from "@atlas/broker";
import { loadConfig } from "../src/config/load.js";
import { AtlasConfigSchema, type AtlasConfig } from "../src/config/schema.js";

const REPO_ROOT = join(import.meta.dirname, "..", "..", "..");
const EXAMPLE = readFileSync(join(REPO_ROOT, "brain.config.example.yaml"), "utf8");

let dir: string;
let base: AtlasConfig;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "atlas-canonref-"));
  writeFileSync(join(dir, "brain.config.yaml"), EXAMPLE, "utf8");
  base = loadConfig(dir, {}).config;
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const withCanonical = (ref: unknown): AtlasConfig =>
  AtlasConfigSchema.parse({ ...base, git: { ...base.git, canonical_ref: ref } });
const withGlobs = (globs: unknown): AtlasConfig =>
  AtlasConfigSchema.parse({ ...base, vault: { ...base.vault, note_globs: globs } });

describe("git.canonical_ref", () => {
  it("defaults to DEFAULT_CANONICAL_REF (the single shared fallback)", () => {
    expect(base.git.canonical_ref).toBe(DEFAULT_CANONICAL_REF);
    expect(DEFAULT_CANONICAL_REF).toBe("refs/heads/main");
  });

  it("accepts an adoption ref under refs/", () => {
    expect(withCanonical("refs/atlas/main").git.canonical_ref).toBe("refs/atlas/main");
  });

  it("rejects an empty value", () => {
    expect(() => withCanonical("")).toThrow();
  });

  it("rejects a non-refs/ value", () => {
    expect(() => withCanonical("heads/main")).toThrow();
    expect(() => withCanonical("main")).toThrow();
  });

  it("rejects the audit and trust refs (and their namespaces)", () => {
    expect(() => withCanonical("refs/audit/runs")).toThrow();
    expect(() => withCanonical("refs/trust/ledger")).toThrow();
    expect(() => withCanonical("refs/audit/other")).toThrow();
    expect(() => withCanonical("refs/trust/other")).toThrow();
  });
});

describe("vault.note_globs", () => {
  it("defaults to ['**/*.md']", () => {
    expect(base.vault.note_globs).toEqual(["**/*.md"]);
  });

  it("accepts a narrowing subtree glob", () => {
    expect(withGlobs(["notes/**/*.md"]).vault.note_globs).toEqual(["notes/**/*.md"]);
  });

  it("rejects an empty glob list", () => {
    expect(() => withGlobs([])).toThrow();
  });
});

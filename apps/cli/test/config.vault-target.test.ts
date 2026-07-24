/**
 * `config.vault-target` (Phase-5 task 5-1, #343) — the vault-path DEFAULT + the
 * stale-target guard. Two behaviours:
 *
 *   1. A `brain.config.yaml` that omits `vault.path` resolves to `DEFAULT_VAULT_PATH`
 *      (the real working tree `~/Code/Vaults/main-vault`) — config points at the real
 *      vault by default, not a stale v1 target.
 *   2. When the operator PINS the intended vault via `ATLAS_EXPECT_VAULT`, a config whose
 *      `vault.path` canonicalizes ELSEWHERE is fail-closed-rejected (ConfigError, exit 2)
 *      — so the live drive can never silently run against the wrong repository. The guard
 *      is INERT when the env is unset (proven), which is why the whole fixture suite is
 *      unaffected.
 *
 * All verified against FIXTURE vaults (real temp dirs, so `realpath` resolves) — the real
 * `~/Code/Vaults/main-vault` is exercised only in the human-led live drive (task 5-3).
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig, EXPECT_VAULT_ENV } from "../src/config/load.js";
import { ConfigError, DEFAULT_VAULT_PATH } from "../src/config/schema.js";

const REPO_ROOT = join(import.meta.dirname, "..", "..", "..");
const EXAMPLE = readFileSync(join(REPO_ROOT, "brain.config.example.yaml"), "utf8");

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "atlas-vault-target-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

/** Write `brain.config.yaml` into `dir` and load it under `env`. */
function load(text: string, env: NodeJS.ProcessEnv = {}) {
  writeFileSync(join(dir, "brain.config.yaml"), text, "utf8");
  return loadConfig(dir, env);
}

/** EXAMPLE with its `vault.path` set to `abs` (an absolute fixture path). */
function withVaultPath(abs: string): string {
  return EXAMPLE.replace("path: ./vault", `path: ${abs}`);
}

describe("vault-path default + stale-target guard (#343)", () => {
  it("a config omitting vault.path resolves to DEFAULT_VAULT_PATH (the real working tree)", () => {
    // Keep the `vault` section but drop its `path` — the schema default fills it in.
    const text = EXAMPLE.replace("vault:\n  path: ./vault", 'vault:\n  note_globs: ["**/*.md"]');
    const { config } = load(text);
    expect(config.vault.path).toBe(DEFAULT_VAULT_PATH);
    expect(DEFAULT_VAULT_PATH).toMatch(/[/\\]Code[/\\]Vaults[/\\]main-vault$/);
  });

  it("loads cleanly when ATLAS_EXPECT_VAULT matches the configured vault.path (fixture)", () => {
    const vault = join(dir, "the-vault");
    mkdirSync(vault);
    const { config } = load(withVaultPath(vault), { [EXPECT_VAULT_ENV]: vault });
    expect(config.vault.path).toBe(vault);
  });

  it("REJECTS a stale override — ATLAS_EXPECT_VAULT ≠ vault.path ⇒ ConfigError exit 2 at vault.path", () => {
    const configured = join(dir, "stale-v1-target");
    const expected = join(dir, "main-vault");
    mkdirSync(configured);
    mkdirSync(expected);
    try {
      load(withVaultPath(configured), { [EXPECT_VAULT_ENV]: expected });
      throw new Error("expected ConfigError");
    } catch (e) {
      expect(e).toBeInstanceOf(ConfigError);
      const ce = e as ConfigError;
      expect(ce.exitCode).toBe(2);
      expect(ce.location.key).toBe("vault.path");
      expect(ce.message).toContain("refusing to run against a stale target");
    }
  });

  it("the guard is INERT when ATLAS_EXPECT_VAULT is unset (arbitrary vault.path loads)", () => {
    const vault = join(dir, "whatever-vault");
    mkdirSync(vault);
    const { config } = load(withVaultPath(vault)); // no env pin
    expect(config.vault.path).toBe(vault);
  });

  it("canonicalizes ~ and symlinks: a ~/-relative vault.path matches an absolute pin at the same dir", () => {
    const home = join(dir, "home");
    const vault = join(home, "main-vault");
    mkdirSync(vault, { recursive: true });
    // vault.path is `~/main-vault`; HOME points into the fixture; the pin is the abs path.
    const { config } = load(withVaultPath("~/main-vault"), { HOME: home, [EXPECT_VAULT_ENV]: vault });
    // The stored value is the literal (the guard canonicalizes only for comparison).
    expect(config.vault.path).toBe("~/main-vault");
  });
});

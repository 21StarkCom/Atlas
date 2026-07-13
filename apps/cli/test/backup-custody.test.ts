/**
 * Regression tests for two custody findings on the backup key path (D9).
 *
 *  1. **`keyId` path traversal.** On `db restore` / `db verify --backup` the key
 *     id is read from the BACKUP BUNDLE HEADER — untrusted, attacker-suppliable
 *     input — and is interpolated into the custody path
 *     (`/etc/atlas/keys/<identity>/<keyId>.key`, or a Keychain account). An
 *     unvalidated `../../..` would escape the custody dir and read an arbitrary
 *     file as the AEAD key. It must be rejected as a bad key id.
 *
 *  2. **`ATLAS_IDENTITY` custody redirection.** The identity selects the custody
 *     SOURCE, so an ambient env var must not be able to redirect it in production
 *     (the module's contract explicitly promises config/env cannot). The override
 *     is honoured only under `ATLAS_TEST_MODE=1`.
 */
import { describe, it, expect } from "vitest";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { backupConfigForKeyId } from "../src/commands/backup-config.js";
import type { RunContext } from "../src/handlers.js";

/** A minimal RunContext carrying just what backup-config reads. */
function ctxWith(env: NodeJS.ProcessEnv, cwd: string): RunContext {
  return {
    cwd,
    env,
    config: {
      config: {
        sqlite: {
          path: join(cwd, "ledger.db"),
          ledger_backup: { dir: join(cwd, "backups"), key_id: "primary", keep: 3 },
        },
      },
    },
  } as unknown as RunContext;
}

const TRAVERSALS = [
  "../../../etc/passwd",
  "..",
  "../primary",
  "a/b",
  "sub/../../escape",
  "with space",
  "semi;colon",
];

describe("backup key id is validated before it reaches a custody path", () => {
  it("rejects traversal / non-path-component key ids from the (untrusted) bundle header", () => {
    const dir = mkdtempSync(join(tmpdir(), "atlas-custody-"));
    try {
      const ctx = ctxWith({ ATLAS_TEST_MODE: "1", ATLAS_CUSTODY_TEST_DIR: dir }, dir);
      for (const bad of TRAVERSALS) {
        let threw = false;
        try {
          backupConfigForKeyId(ctx, bad);
        } catch (err) {
          threw = true;
          expect(String((err as Error).message), `key id ${JSON.stringify(bad)}`).toMatch(
            /unsafe backup key id/i,
          );
        }
        expect(threw, `key id ${JSON.stringify(bad)} must be refused`).toBe(true);
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("still accepts a well-formed key id", () => {
    const dir = mkdtempSync(join(tmpdir(), "atlas-custody-"));
    try {
      writeFileSync(join(dir, "primary.key"), Buffer.alloc(32).toString("base64"));
      const ctx = ctxWith({ ATLAS_TEST_MODE: "1", ATLAS_CUSTODY_TEST_DIR: dir }, dir);
      const cfg = backupConfigForKeyId(ctx, "primary");
      expect(cfg.keyId).toBe("primary");
      expect(cfg.key.length).toBe(32);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("ATLAS_IDENTITY cannot redirect custody outside test mode", () => {
  it("ignores ATLAS_IDENTITY when ATLAS_TEST_MODE is not set", () => {
    const dir = mkdtempSync(join(tmpdir(), "atlas-custody-"));
    try {
      // No ATLAS_TEST_MODE ⇒ the test-dir seam is ignored AND ATLAS_IDENTITY is
      // ignored, so this must NOT read the attacker-planted key: it falls through
      // to real platform custody, which has no such item ⇒ key-unavailable.
      writeFileSync(join(dir, "primary.key"), Buffer.alloc(32, 7).toString("base64"));
      const ctx = ctxWith({ ATLAS_IDENTITY: "../../attacker", ATLAS_CUSTODY_TEST_DIR: dir }, dir);
      expect(() => backupConfigForKeyId(ctx, "primary")).toThrowError(
        /not readable by the trusted-cli identity/i,
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

/**
 * Shared wiring for the `db backup` / `db restore` / `db verify --backup` handlers
 * (Task 1.7): resolve the SQLite path + backup dir from config, and read the
 * trusted-CLI-readable AEAD backup key from **platform key custody** (D9).
 *
 * ## Custody (D9, round-3 finding 8)
 * The AEAD key is fetched through a required PLATFORM custody accessor keyed by the
 * CLI identity + the requested key id, so caller-controlled config/environment
 * values can NOT redirect custody to attacker-supplied key material:
 *   - **macOS:** the login **Keychain** — a generic-password item
 *     `service = atlas-ledger-backup:<identity>`, `account = <keyId>` (base64 of 32
 *     bytes). Read via `security find-generic-password -w`. Never a plaintext file.
 *   - **Linux:** a root-provisioned key file `/etc/atlas/keys/<identity>/<keyId>.key`
 *     (dir `0700` owned by that identity; base64 of 32 bytes). The path is FIXED —
 *     neither config nor the environment can move it.
 *
 * The ONLY override is an explicitly gated **test seam**: `ATLAS_CUSTODY_TEST_DIR`
 * is honoured solely when `ATLAS_TEST_MODE=1`, and points at a plaintext key
 * directory the tests provision. In any non-test invocation the seam is ignored, so
 * a hostile `brain.config.yaml` / env can never substitute the custody source.
 */
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import { platform } from "node:os";
import { AEAD_KEY_BYTES, type LedgerBackupConfig } from "@atlas/sqlite-store";
import { CliError, EXIT } from "../errors/envelope.js";
import type { RunContext } from "../main.js";

/** Absolute path for a config-relative path (resolved against the invocation cwd). */
export function resolvePath(ctx: RunContext, p: string): string {
  return isAbsolute(p) ? p : resolve(ctx.cwd, p);
}

/** Absolute path to the ledger SQLite DB. */
export function ledgerDbPath(ctx: RunContext): string {
  return resolvePath(ctx, ctx.config.config.sqlite.path);
}

/**
 * The trusted-CLI identity whose custody holds the backup key (D9).
 *
 * SECURITY: the identity selects the custody SOURCE (the Keychain service name on
 * macOS, the `/etc/atlas/keys/<identity>` dir on Linux), so letting the ambient
 * environment set it would let a hostile env redirect custody at attacker-supplied
 * key material — exactly what this module's contract promises it cannot do. The
 * `ATLAS_IDENTITY` override is therefore honoured ONLY under `ATLAS_TEST_MODE=1`
 * (the same gate as the `ATLAS_CUSTODY_TEST_DIR` seam); production always derives
 * the fixed `trusted-cli` identity.
 */
function identity(ctx: RunContext): string {
  if (ctx.env.ATLAS_TEST_MODE === "1" && ctx.env.ATLAS_IDENTITY) return ctx.env.ATLAS_IDENTITY;
  return "trusted-cli";
}

/**
 * A key id safe to interpolate into a custody path. `keyId` is NOT trusted input:
 * on `db restore` / `db verify --backup` it is read from the BACKUP BUNDLE HEADER,
 * i.e. from a file an attacker may supply. Interpolating it unvalidated into
 * `/etc/atlas/keys/<identity>/<keyId>.key` (or a Keychain account) would allow
 * `../../..` traversal out of the custody dir and read arbitrary files as the key.
 * Restrict it to a single safe path component.
 */
const SAFE_KEY_ID = /^[A-Za-z0-9._-]{1,64}$/;

function assertSafeKeyId(keyId: string): string {
  if (!SAFE_KEY_ID.test(keyId) || keyId === "." || keyId === "..") {
    throw new CliError({
      code: "key-unavailable",
      message: `refusing an unsafe backup key id ${JSON.stringify(keyId)}`,
      hint: "A key id must be a single path component matching [A-Za-z0-9._-]{1,64} (it is interpolated into the custody path, and on restore/verify it comes from the untrusted backup header).",
      exitCode: EXIT.CONFIG,
    });
  }
  return keyId;
}

/** The macOS Keychain generic-password service name for this identity's backup keys. */
function keychainService(id: string): string {
  return `atlas-ledger-backup:${id}`;
}

function keyUnavailable(keyId: string, detail: string, hint: string): CliError {
  return new CliError({
    code: "key-unavailable",
    message: `the backup AEAD key "${keyId}" is not readable by the trusted-CLI identity (${detail})`,
    hint,
    exitCode: EXIT.CONFIG,
  });
}

/** Validate + decode a base64 custody value to a 32-byte key, or throw `key-unavailable`. */
function decodeKey(keyId: string, b64: string, source: string): Uint8Array {
  const key = Buffer.from(b64.trim(), "base64");
  if (key.length !== AEAD_KEY_BYTES) {
    throw keyUnavailable(
      keyId,
      `must decode to ${AEAD_KEY_BYTES} bytes (got ${key.length})`,
      `${source} must hold base64 for exactly ${AEAD_KEY_BYTES} bytes.`,
    );
  }
  return key;
}

/**
 * Read the AEAD key for `keyId` from platform custody (D9). The custody SOURCE is
 * chosen by the platform + the gated test seam — never by a caller-supplied path —
 * so config/env cannot redirect it to attacker key material (round-3 finding 8).
 */
function readCustodyKey(ctx: RunContext, rawKeyId: string): Uint8Array {
  // Validate BEFORE the key id reaches any path/Keychain interpolation below.
  const keyId = assertSafeKeyId(rawKeyId);
  const id = identity(ctx);

  // Gated test seam: honoured ONLY under ATLAS_TEST_MODE=1 (never in production).
  if (ctx.env.ATLAS_TEST_MODE === "1" && ctx.env.ATLAS_CUSTODY_TEST_DIR) {
    const path = join(resolvePath(ctx, ctx.env.ATLAS_CUSTODY_TEST_DIR), `${keyId}.key`);
    if (!existsSync(path)) {
      throw keyUnavailable(keyId, `test custody file absent at ${path}`, `Provision ${path} (base64 32 bytes).`);
    }
    return decodeKey(keyId, readFileSync(path, "utf8"), path);
  }

  if (platform() === "darwin") {
    // macOS Keychain (never a plaintext file in production).
    let out: string;
    try {
      out = execFileSync(
        "security",
        ["find-generic-password", "-s", keychainService(id), "-a", keyId, "-w"],
        { encoding: "utf8" },
      );
    } catch {
      throw keyUnavailable(
        keyId,
        `Keychain item ${keychainService(id)}/${keyId} not found`,
        `Add it: security add-generic-password -s ${keychainService(id)} -a ${keyId} -w <base64-32-bytes>.`,
      );
    }
    return decodeKey(keyId, out, `Keychain item ${keychainService(id)}/${keyId}`);
  }

  // Linux: FIXED root-provisioned custody dir (config/env cannot move it).
  const path = join("/etc/atlas/keys", id, `${keyId}.key`);
  if (!existsSync(path)) {
    throw keyUnavailable(keyId, `custody file absent at ${path}`, `Provision ${path} (0700 dir, base64 32 bytes).`);
  }
  return decodeKey(keyId, readFileSync(path, "utf8"), path);
}

/**
 * Build the {@link LedgerBackupConfig} for this invocation, reading the CURRENT
 * AEAD key from platform custody. A missing/malformed key is `key-unavailable`
 * (exit 2). Prior key ids stay in the same custody source (readable via
 * {@link backupConfigForKeyId}) so rotated-out backups still decrypt (§7).
 */
export function backupConfig(ctx: RunContext): LedgerBackupConfig {
  const sqlite = ctx.config.config.sqlite;
  const keyId = sqlite.ledger_backup.key_id;
  return {
    dir: resolvePath(ctx, sqlite.ledger_backup.dir),
    key: readCustodyKey(ctx, keyId),
    keyId,
    keep: sqlite.ledger_backup.keep,
  };
}

/**
 * Build a config bound to a SPECIFIC (possibly rotated-out) key id — custody
 * retains every key id, so a backup stamped with an older `keyId` can still be
 * verified/restored after rotation (§7, round-3 finding 7).
 */
export function backupConfigForKeyId(ctx: RunContext, keyId: string): LedgerBackupConfig {
  const sqlite = ctx.config.config.sqlite;
  return {
    dir: resolvePath(ctx, sqlite.ledger_backup.dir),
    key: readCustodyKey(ctx, keyId),
    keyId,
    keep: sqlite.ledger_backup.keep,
  };
}

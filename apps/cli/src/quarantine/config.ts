/**
 * `quarantine/config` (Task 2.2 / #28) — resolve a {@link QuarantineStore} for the
 * current invocation: the dir (an OS state directory OUTSIDE the repo + vault) and
 * the AEAD key from PLATFORM key custody (D9), matching EXACTLY what the
 * provisioning scripts create.
 *
 * ## Custody (aligned with provisioning + the ACL matrix)
 * `provisioning/dev/setup.sh` generates the quarantine key as a raw 32-byte file at
 * `<keysDir>/agent/quarantine-aead.key`, owned by the agent identity, mode 0600
 * (ACL matrix row `quarantine-aead`: `readableBy: ["trusted-cli"]`,
 * `parserModelDenied: true`). `keysDir` is `/usr/local/etc/atlas/keys` on macOS and
 * `/etc/atlas/keys` on Linux — a root-provisioned FILE on BOTH platforms (the ACL
 * matrix's V1 note: the non-login service/agent accounts cannot unlock a macOS login
 * keychain, so custody is file-based everywhere). The custody SOURCE is chosen by the
 * platform, never by a caller-supplied config/env value, so a hostile
 * `brain.config.yaml`/env cannot redirect it to attacker key material.
 *
 * ## Rotation (§7)
 * The CURRENT key id (`quarantine.key_id`, default `cli-custody-v1`) is stamped into
 * every new bundle and resolves to `<keysDir>/agent/quarantine-aead.key`. A retained
 * rotated-out key id `X` resolves to `<keysDir>/agent/quarantine-aead.X.key`, so an
 * item sealed under an older key still decrypts after rotation. Ids listed in
 * `quarantine.revoked_key_ids` fail closed inside the store.
 *
 * The retained `quarantine-aead.<X>.key` file is CREATED by {@link rotateQuarantineCustody}:
 * an atomic procedure that renames the outgoing `quarantine-aead.key` to
 * `quarantine-aead.<previousKeyId>.key` (rename preserves owner + mode) and installs
 * the new current key via temp-then-rename + fsync. Rotation is therefore a real,
 * crash-safe custody operation — not an in-memory test seam.
 *
 * The ONLY override is the test seam `ATLAS_CUSTODY_TEST_DIR`, honoured solely under
 * `ATLAS_TEST_MODE=1`: it substitutes the `keysDir` root, and the SAME
 * `agent/quarantine-aead[.<keyId>].key` layout is exercised beneath it — so a test
 * runs the real provisioned custody path, not a bespoke one.
 */
import { randomBytes } from "node:crypto";
import {
  chmodSync,
  closeSync,
  constants as fsConstants,
  existsSync,
  fstatSync,
  fsyncSync,
  lstatSync,
  openSync,
  readSync,
  realpathSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { homedir, platform } from "node:os";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { CliError, EXIT } from "../errors/envelope.js";
import type { RunContext } from "../main.js";
import { QUARANTINE_KEY_BYTES, QuarantineStore } from "./store.js";

/** The uid of the trusted-CLI process, or `undefined` on platforms without POSIX uids. */
function currentUid(): number | undefined {
  return typeof process.getuid === "function" ? process.getuid() : undefined;
}

/** Absolute path for a config-relative path (resolved against the invocation cwd). */
function resolvePath(ctx: RunContext, p: string): string {
  return isAbsolute(p) ? p : resolve(ctx.cwd, p);
}

/**
 * The per-OS root custody directory (mirrors `provisioning/keys.acl.json` `paths.keysDir`
 * + `provisioning/lib.sh`). Under the gated test seam, `ATLAS_CUSTODY_TEST_DIR` replaces it.
 */
function keysDir(ctx: RunContext): string {
  if (ctx.env.ATLAS_TEST_MODE === "1" && ctx.env.ATLAS_CUSTODY_TEST_DIR) {
    return resolvePath(ctx, ctx.env.ATLAS_CUSTODY_TEST_DIR);
  }
  return platform() === "darwin" ? "/usr/local/etc/atlas/keys" : "/etc/atlas/keys";
}

/** The agent-owned custody subdir that holds the quarantine key (ACL row `identity: "agent"`). */
const CUSTODY_IDENTITY = "agent";
/** The provisioned quarantine key filename (ACL row `file`). */
const CUSTODY_KEY_FILE = "quarantine-aead";

/** A key id safe to interpolate into a custody path (single path component). */
const SAFE_KEY_ID = /^[A-Za-z0-9._-]{1,64}$/;

function keyUnavailable(keyId: string, detail: string, hint: string): CliError {
  return new CliError({
    code: "quarantine-key-unavailable",
    message: `the quarantine AEAD key "${keyId}" is not readable by the trusted-CLI identity (${detail})`,
    hint,
    exitCode: EXIT.CONFIG,
  });
}

function assertSafeKeyId(keyId: string): void {
  if (!SAFE_KEY_ID.test(keyId) || keyId === "." || keyId === "..") {
    throw new CliError({
      code: "quarantine-key-unavailable",
      message: `refusing an unsafe quarantine key id ${JSON.stringify(keyId)}`,
      hint: "A key id must be a single path component matching [A-Za-z0-9._-]{1,64}.",
      exitCode: EXIT.CONFIG,
    });
  }
}

/**
 * The custody file for a key id: the CURRENT key id uses the provisioned base name
 * `quarantine-aead.key`; a retained (rotated-out) id `X` uses `quarantine-aead.X.key`.
 */
function custodyFile(ctx: RunContext, keyId: string, currentKeyId: string): string {
  const dir = join(keysDir(ctx), CUSTODY_IDENTITY);
  return keyId === currentKeyId
    ? join(dir, `${CUSTODY_KEY_FILE}.key`)
    : join(dir, `${CUSTODY_KEY_FILE}.${keyId}.key`);
}

/**
 * Enforce the protected custody PARENT directory posture (finding: the parent's
 * ownership/mode was never checked). It must be a real directory (never a symlink),
 * mode 0700 (no group/other access), and owned by the trusted-CLI identity — so a
 * world-writable or symlinked parent cannot smuggle in attacker key material.
 */
function assertProtectedParent(dir: string, keyId: string): void {
  let st;
  try {
    st = lstatSync(dir);
  } catch {
    throw keyUnavailable(keyId, `custody parent dir ${dir} is not accessible`, `Provision ${dir} (0700, owned by the trusted-CLI identity).`);
  }
  if (st.isSymbolicLink()) {
    throw keyUnavailable(keyId, `custody parent dir ${dir} is a symlink (must be a real directory)`, `Replace ${dir} with a real 0700 directory.`);
  }
  if (!st.isDirectory()) {
    throw keyUnavailable(keyId, `custody parent ${dir} is not a directory`, `Provision ${dir} as a 0700 directory.`);
  }
  if ((st.mode & 0o077) !== 0) {
    throw keyUnavailable(
      keyId,
      `custody parent dir ${dir} is group/other-accessible (mode ${(st.mode & 0o777).toString(8)}; must be 0700)`,
      `Run \`chmod 700 ${dir}\`.`,
    );
  }
  const uid = currentUid();
  if (uid !== undefined && st.uid !== uid) {
    throw keyUnavailable(keyId, `custody parent dir ${dir} is not owned by the trusted-CLI identity`, `Run \`chown\` so ${dir} is owned by the CLI identity.`);
  }
}

/**
 * Read + validate a raw 32-byte AEAD key file under trusted-CLI-only custody
 * (provisioning writes `openssl rand … 32`, i.e. raw bytes). Hardened per the
 * reviewer finding: the file is opened WITHOUT following symlinks (`O_NOFOLLOW`),
 * `fstat`'d to confirm a REGULAR file, and rejected unless it is mode 0600 (no group/
 * other access) and owned by the trusted-CLI identity within a protected 0700 parent
 * — so a symlinked or world-readable key can never satisfy trusted-CLI-only custody.
 */
function readCustodyKey(ctx: RunContext, keyId: string, currentKeyId: string): Uint8Array {
  assertSafeKeyId(keyId);
  const path = custodyFile(ctx, keyId, currentKeyId);
  assertProtectedParent(dirname(path), keyId);

  let fd: number;
  try {
    fd = openSync(path, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    if (code === "ELOOP") {
      throw keyUnavailable(keyId, `custody file ${path} is a symlink (must be a real file)`, `Replace ${path} with a real 0600 key file.`);
    }
    if (code === "ENOENT") {
      throw keyUnavailable(keyId, `custody file absent at ${path}`, `Provision ${path} (0700 dir, raw 32 bytes — e.g. \`openssl rand -out ${path} 32\`).`);
    }
    throw keyUnavailable(keyId, `custody file ${path} is not readable (${code ?? "unknown error"})`, `Ensure ${path} exists as a 0600 regular file owned by the CLI identity.`);
  }
  try {
    const st = fstatSync(fd);
    if (!st.isFile()) {
      throw keyUnavailable(keyId, `custody path ${path} is not a regular file`, `Replace ${path} with a real 0600 key file.`);
    }
    if ((st.mode & 0o077) !== 0) {
      throw keyUnavailable(
        keyId,
        `custody file ${path} is group/other-accessible (mode ${(st.mode & 0o777).toString(8)}; must be 0600)`,
        `Run \`chmod 600 ${path}\`.`,
      );
    }
    const uid = currentUid();
    if (uid !== undefined && st.uid !== uid) {
      throw keyUnavailable(keyId, `custody file ${path} is not owned by the trusted-CLI identity`, `Run \`chown\` so ${path} is owned by the CLI identity.`);
    }
    if (st.size !== QUARANTINE_KEY_BYTES) {
      throw keyUnavailable(
        keyId,
        `must be exactly ${QUARANTINE_KEY_BYTES} raw bytes (got ${st.size})`,
        `${path} must hold exactly ${QUARANTINE_KEY_BYTES} raw bytes.`,
      );
    }
    const buf = Buffer.allocUnsafe(QUARANTINE_KEY_BYTES);
    const n = readSync(fd, buf, 0, QUARANTINE_KEY_BYTES, 0);
    if (n !== QUARANTINE_KEY_BYTES) {
      throw keyUnavailable(keyId, `short read from custody file ${path} (${n} of ${QUARANTINE_KEY_BYTES} bytes)`, `Re-provision ${path}.`);
    }
    return new Uint8Array(buf);
  } finally {
    closeSync(fd);
  }
}

/** True when `child` is at or beneath `parent` (containment check; both absolute). */
function isWithin(child: string, parent: string): boolean {
  const rel = relative(parent, child);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

/**
 * The effective REAL path of `p`: realpath the deepest existing ancestor (following
 * any symlinks) and re-append the not-yet-created suffix. This is what containment is
 * checked against, so a symlinked ancestor cannot smuggle the store into the repo/
 * vault (a `.gitignore`-style path check on the logical path would miss that).
 */
function effectiveRealPath(p: string): string {
  let existing = p;
  const suffix: string[] = [];
  for (;;) {
    if (existsSync(existing)) {
      try {
        return suffix.length === 0 ? realpathSync(existing) : join(realpathSync(existing), ...suffix.reverse());
      } catch {
        return p; // realpath failed — fall back to the logical path
      }
    }
    const parent = dirname(existing);
    if (parent === existing) return p; // reached the root without an existing ancestor
    suffix.push(existing.slice(parent.length + 1));
    existing = parent;
  }
}

/**
 * The default quarantine dir: an OS state directory OUTSIDE the repo + vault (the
 * plan requires the store live outside the repository — `.gitignore` is not an
 * isolation boundary). Honours `XDG_STATE_HOME`; else the per-OS convention.
 *
 * Under the gated test seam (`ATLAS_TEST_MODE=1` + `ATLAS_CUSTODY_TEST_DIR`, the
 * SAME gate the AEAD-custody source uses) the default lands in a dedicated subdir
 * of the test custody root instead of the shared OS state dir. Without this, every
 * e2e fixture that quarantines writes into `~/Library/Application Support/atlas/
 * quarantine`, and a host carrying real bundles (e.g. after a real `graduation
 * scan`) fails `doctor` — the quarantine-security check sees foreign bundles it
 * cannot verify with the fixture custody key (#144). The seam is ignored in any
 * non-test invocation, so production always uses the real OS state dir.
 */
function defaultStateDir(ctx: RunContext): string {
  if (ctx.env.ATLAS_TEST_MODE === "1" && ctx.env.ATLAS_CUSTODY_TEST_DIR) {
    return join(resolvePath(ctx, ctx.env.ATLAS_CUSTODY_TEST_DIR), "quarantine-store");
  }
  const xdg = ctx.env.XDG_STATE_HOME;
  if (xdg && isAbsolute(xdg)) return join(xdg, "atlas", "quarantine");
  const home = ctx.env.HOME ?? homedir();
  if (platform() === "darwin") return join(home, "Library", "Application Support", "atlas", "quarantine");
  return join(home, ".local", "state", "atlas", "quarantine");
}

/**
 * The ACTUAL repository root for this invocation (finding: `ctx.cwd` was treated as
 * the root, so invoking from a subdirectory let the quarantine dir land elsewhere
 * inside the repo). Walks up from the real cwd to the nearest `.git`; falls back to
 * the real cwd when none is found (a repo-less invocation).
 */
function repositoryRoot(ctx: RunContext): string {
  const start = effectiveRealPath(ctx.cwd);
  let dir = start;
  for (;;) {
    if (existsSync(join(dir, ".git"))) return dir;
    const parent = dirname(dir);
    if (parent === dir) return start;
    dir = parent;
  }
}

function dirInvalid(message: string): CliError {
  return new CliError({
    code: "quarantine-dir-invalid",
    message,
    hint: "Set quarantine.dir to a DEDICATED path OUTSIDE the repo + vault (and not the home dir/an ancestor of it) — an OS state dir — or leave it unset to use the OS default. .gitignore is not an isolation boundary.",
    exitCode: EXIT.CONFIG,
  });
}

/**
 * The resolved quarantine dir for this invocation (absolute; validated). Hardened per
 * the reviewer finding: containment is checked in BOTH directions against the real
 * repository root AND the vault (so the dir can neither sit inside them nor be an
 * ancestor whose `ensureDir()` would chmod them to 0700), and the dir must be a
 * DEDICATED location — never the home directory (or an ancestor of it) nor a
 * filesystem root, both of which `ensureDir()` would otherwise clamp to 0700.
 */
export function quarantineDir(ctx: RunContext): string {
  const configured = ctx.config.config.quarantine.dir;
  const dir = configured ? resolvePath(ctx, configured) : defaultStateDir(ctx);

  // Containment is checked against the REAL paths so a symlinked ancestor cannot
  // redirect the store into the repo/vault (symlink-component defence + containment).
  const dirReal = effectiveRealPath(dir);
  const repoRoot = repositoryRoot(ctx);
  const vault = effectiveRealPath(resolvePath(ctx, ctx.config.config.vault.path));
  const home = effectiveRealPath(ctx.env.HOME ?? homedir());

  if (isWithin(dirReal, repoRoot)) {
    throw dirInvalid(`the quarantine dir ${dir} is inside the repository ${repoRoot}`);
  }
  if (isWithin(repoRoot, dirReal)) {
    throw dirInvalid(`the quarantine dir ${dir} is an ancestor of the repository ${repoRoot} (ensureDir would chmod it 0700)`);
  }
  if (isWithin(dirReal, vault)) {
    throw dirInvalid(`the quarantine dir ${dir} is inside the vault ${vault}`);
  }
  if (isWithin(vault, dirReal)) {
    throw dirInvalid(`the quarantine dir ${dir} is an ancestor of the vault ${vault} (ensureDir would chmod it 0700)`);
  }
  if (isWithin(home, dirReal)) {
    // dirReal is the home directory itself or an ancestor of it — not a dedicated dir.
    throw dirInvalid(`the quarantine dir ${dir} is the home directory (or an ancestor of it); a dedicated quarantine dir is required`);
  }
  if (dirname(dirReal) === dirReal) {
    throw dirInvalid(`the quarantine dir ${dir} is a filesystem root; a dedicated quarantine dir is required`);
  }
  return dir;
}

/** Build a {@link QuarantineStore} for the current invocation (custody key + rotation resolver resolved). */
export function quarantineStoreFromContext(ctx: RunContext): QuarantineStore {
  const q = ctx.config.config.quarantine;
  const currentKeyId = q.key_id;
  return new QuarantineStore({
    dir: quarantineDir(ctx),
    key: readCustodyKey(ctx, currentKeyId, currentKeyId),
    keyId: currentKeyId,
    // Per-item resolution for rotated-out ids (§7): reads the retained key file.
    resolveKey: (keyId: string) => readCustodyKey(ctx, keyId, currentKeyId),
    revokedKeyIds: q.revoked_key_ids,
    keep: q.keep,
    retentionDays: q.retention_days,
  });
}

/** The outcome of a custody rotation (paths of the retained old key + the new current key). */
export interface CustodyRotationResult {
  readonly previousKeyId: string;
  readonly newKeyId: string;
  /** Where the previous current key now lives (`quarantine-aead.<previousKeyId>.key`). */
  readonly retainedPath: string;
  /** The base custody file now holding the new current key (`quarantine-aead.key`). */
  readonly currentPath: string;
}

/**
 * Atomic custody rotation (§7) — the procedure the ACL contract's rotation layout
 * relies on (finding: provisioning + reads expected a retained
 * `quarantine-aead.<keyId>.key`, but nothing ever CREATED one, so real rotation could
 * not recover old items). It:
 *   1. verifies the current key is present + well-formed under trusted-CLI custody;
 *   2. RETAINS it by renaming `quarantine-aead.key` → `quarantine-aead.<previousKeyId>.key`
 *      (an atomic rename preserves owner + mode, so items sealed under it still decrypt);
 *   3. installs `newKey` (freshly generated when omitted) at the base
 *      `quarantine-aead.key` via a temp-then-rename + fsync (the file is fsync'd, the
 *      dir is fsync'd), so a crash never leaves a half-written current key.
 * After this returns, the NEXT invocation configured with `key_id = newKeyId` reads
 * the new key as current and resolves the retained old key per stamped item id.
 *
 * The caller updates `quarantine.key_id` to `newKeyId` in `brain.config.yaml`.
 */
export function rotateQuarantineCustody(
  ctx: RunContext,
  opts: { readonly newKeyId: string; readonly newKey?: Uint8Array },
): CustodyRotationResult {
  const previousKeyId = ctx.config.config.quarantine.key_id;
  assertSafeKeyId(opts.newKeyId);
  if (opts.newKeyId === previousKeyId) {
    throw new CliError({
      code: "quarantine-rotation-invalid",
      message: `the new quarantine key id must differ from the current one (${JSON.stringify(previousKeyId)})`,
      hint: "Choose a fresh key id (e.g. bump the version suffix).",
      exitCode: EXIT.CONFIG,
    });
  }
  const newKey = opts.newKey ?? new Uint8Array(randomBytes(QUARANTINE_KEY_BYTES));
  if (newKey.length !== QUARANTINE_KEY_BYTES) {
    throw new CliError({
      code: "quarantine-rotation-invalid",
      message: `the new quarantine key must be ${QUARANTINE_KEY_BYTES} bytes (got ${newKey.length})`,
      hint: `Provide exactly ${QUARANTINE_KEY_BYTES} raw bytes, or omit to auto-generate.`,
      exitCode: EXIT.CONFIG,
    });
  }

  const dir = join(keysDir(ctx), CUSTODY_IDENTITY);
  assertProtectedParent(dir, opts.newKeyId);

  // Fail closed unless the current key is present + valid under trusted-CLI custody.
  readCustodyKey(ctx, previousKeyId, previousKeyId);

  const currentPath = custodyFile(ctx, previousKeyId, previousKeyId); // base `quarantine-aead.key`
  const retainedPath = custodyFile(ctx, previousKeyId, opts.newKeyId); // `quarantine-aead.<previousKeyId>.key`
  if (existsSync(retainedPath)) {
    throw new CliError({
      code: "quarantine-rotation-invalid",
      message: `a retained key already exists at ${retainedPath} — refusing to overwrite it`,
      hint: "Rotation would clobber a previously retained key; remove/rename it first if this is intentional.",
      exitCode: EXIT.CONFIG,
    });
  }

  // 1) retain the outgoing key under its id (atomic; preserves owner + mode).
  renameSync(currentPath, retainedPath);
  // 2) install the new current key atomically: temp → fsync → rename → fsync dir.
  const tmp = join(dir, `.qkey-tmp-${randomBytes(8).toString("hex")}`);
  writeFileSync(tmp, Buffer.from(newKey), { mode: 0o600 });
  const tfd = openSync(tmp, "r");
  try {
    fsyncSync(tfd);
  } finally {
    closeSync(tfd);
  }
  renameSync(tmp, currentPath);
  chmodSync(currentPath, 0o600);
  fsyncDirBestEffort(dir);

  return { previousKeyId, newKeyId: opts.newKeyId, retainedPath, currentPath };
}

/** fsync a directory to durably record a rename; tolerate only the well-known unsupported errnos. */
function fsyncDirBestEffort(dir: string): void {
  let fd: number | undefined;
  try {
    fd = openSync(dir, "r");
    fsyncSync(fd);
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    if (code !== "EINVAL" && code !== "ENOTSUP" && code !== "EISDIR" && code !== "EPERM" && code !== "EACCES") {
      throw e;
    }
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

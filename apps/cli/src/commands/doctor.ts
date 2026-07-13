/**
 * `brain doctor [--reclaim-locks]` (Task 1.9 / #25) — a read-only host/vault
 * health surface. It is NOT a run: doctor emits NO `run.*` audit event (per the
 * spec's closed Tier-0 enumeration — a health check is not a run).
 *
 * Runs the Phase-1 check inventory from the committed `doctor.schema.json`:
 *   - `modes-permissions`     — the Atlas-owned dirs (SQLite/backups/worktrees/
 *                               logs/temp) are not group/other-writable;
 *   - `lock-liveness`         — every named lock scope with a dead-pid holder is
 *                               reported action-required and reclaimable;
 *   - `backup-watermark`      — the watermark seq vs the latest ledger seq;
 *   - `audit-anchor`          — the live audit count reconciles with the WORM anchor;
 *   - `provisioning-presence` — the two runtime identities / keys / broker are
 *                               present (gated on `ATLAS_PROVISIONED`);
 *   - `encrypted-volume`      — best-effort encrypted-at-rest marker (never fatal).
 *
 * The single narrow mutation is `--reclaim-locks`, which removes lock records held
 * by a provably-dead pid. Aggregate exit is 0 when every check passes (or only
 * warns/degrades), and 6 (action-required) when any check reports an operator
 * action is required — NAMING the failing check in its `detail`.
 */
import { existsSync, readFileSync, statSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { platform } from "node:os";
import { openStore } from "@atlas/sqlite-store";
import { watermarkHealth } from "@atlas/sqlite-store";
import { BrokerClient } from "@atlas/broker";
import { CliError, EXIT, emitJson } from "../errors/envelope.js";
import { registerCommand, type RunContext } from "../handlers.js";
import { lockManager, LOCK_SCOPES } from "../locks/manager.js";
import { ledgerDbPath, backupConfig } from "./backup-config.js";
import { verifyAuditAnchor, type AuditChainProbe } from "../audit/anchor-check.js";

type CheckStatus = "ok" | "warning" | "degraded" | "action-required";

interface Check {
  id: string;
  title: string;
  status: CheckStatus;
  detail?: string;
}

interface DoctorOutput {
  command: "doctor";
  status: "healthy" | "degraded" | "action-required";
  checks: Check[];
  reclaimedLocks?: { scope: string; holderPid: number }[];
}

function parseArgs(argv: string[]): { reclaimLocks: boolean } {
  let reclaimLocks = false;
  for (const a of argv) {
    if (a === "--reclaim-locks") reclaimLocks = true;
    else throw CliError.usage(`unknown flag/argument for \`doctor\`: ${a}`);
  }
  return { reclaimLocks };
}

function abs(ctx: RunContext, p: string): string {
  return isAbsolute(p) ? p : resolve(ctx.cwd, p);
}

/**
 * Filesystem modes & permissions across the FULL Phase-1 inventory (round-2
 * finding F7): the Atlas-owned dirs (vault, SQLite dir, backups, worktrees, logs,
 * temp/index) must not be group/other-writable, and the PROTECTED files that carry
 * a strict contract mode — the WORM audit anchor (`0600`) and the AEAD custody key
 * files (`0600`) — must not be group/other readable OR writable. Ownership is only
 * asserted on a real provisioned host (skipped under `ATLAS_TEST_MODE`, which runs
 * without the `atlas-broker`/`atlas-git` accounts). Skipped on non-POSIX hosts
 * (Atlas ships macOS/Linux only, §2.5).
 */
function checkModesPermissions(ctx: RunContext): Check {
  const id = "modes-permissions";
  const title = "Filesystem modes & permissions";
  if (platform() !== "darwin" && platform() !== "linux") {
    return { id, title, status: "ok", detail: "mode checks not applicable on this platform" };
  }
  const cfg = ctx.config.config;
  const sqlite = cfg.sqlite;
  const drift: string[] = [];

  // Dirs: not group/other-WRITABLE (the relaxed form that never false-positives on
  // a normally-created 0700/0750 tree, yet still catches world-writable drift).
  const dirs = [
    abs(ctx, cfg.vault.path),
    resolve(abs(ctx, sqlite.path), ".."),
    abs(ctx, sqlite.ledger_backup.dir),
    abs(ctx, cfg.git.worktrees_path),
    abs(ctx, cfg.logs.dir),
    abs(ctx, cfg.lancedb.dir), // local index/temp working area
    dirname(abs(ctx, cfg.git.audit_anchor_path)), // WORM anchor parent (broker-owned 0700)
  ];
  for (const dir of dirs) {
    if (!existsSync(dir)) continue; // not yet created — nothing to verify
    const mode = statSync(dir).mode & 0o777;
    if ((mode & 0o022) !== 0) drift.push(`${dir} is group/other-writable (mode ${mode.toString(8)})`);
  }

  // Protected files: strict 0600 (no group/other access at all) where they exist.
  const protectedFiles = [abs(ctx, cfg.git.audit_anchor_path)];
  for (const file of protectedFiles) {
    if (!existsSync(file)) continue;
    const mode = statSync(file).mode & 0o777;
    if ((mode & 0o077) !== 0) drift.push(`${file} is group/other-accessible (mode ${mode.toString(8)}; must be 0600)`);
  }

  // On a REAL provisioned host (not the relaxed test seam) additionally enforce the
  // EXACT security-contract layout + custody ACLs (round-3 finding 4): the WORM
  // anchor is exactly 0600 with a 0700 parent, and every custody key file matches
  // its `provisioning/keys.acl.json` mode + owner + not-more-readable row. A
  // missing protected path is action-required (not skipped). These probes require
  // the real `atlas-broker`/`atlas-git` accounts + fixed custody paths, which the
  // test seam does not create, so they run only outside ATLAS_TEST_MODE.
  if (ctx.env.ATLAS_TEST_MODE !== "1" && ctx.env.ATLAS_PROVISIONED === "1") {
    drift.push(...strictProtectedLayoutDrift(ctx));
  }

  if (drift.length > 0) {
    return { id, title, status: "action-required", detail: `insecure permissions: ${drift.join("; ")}` };
  }
  return { id, title, status: "ok" };
}

/** Resolve a username to its numeric uid via `id -u <name>`, or `null` if unknown. */
function uidOf(name: string): number | null {
  try {
    return Number.parseInt(execFileSync("id", ["-u", name], { encoding: "utf8" }).trim(), 10);
  } catch {
    return null;
  }
}

/** Resolve a group name to its numeric gid via `getent`/`dscl`, or `null` if unknown. */
function gidOf(name: string): number | null {
  try {
    if (platform() === "darwin") {
      const out = execFileSync("dscl", [".", "-read", `/Groups/${name}`, "PrimaryGroupID"], { encoding: "utf8" });
      const m = out.match(/PrimaryGroupID:\s*(\d+)/);
      return m ? Number.parseInt(m[1]!, 10) : null;
    }
    const out = execFileSync("getent", ["group", name], { encoding: "utf8" }).trim();
    const parts = out.split(":");
    return parts.length >= 3 ? Number.parseInt(parts[2]!, 10) : null;
  } catch {
    return null;
  }
}

/** The machine-readable ACL matrix shape (subset consumed here). */
interface AclMatrix {
  keys: { key: string; mode: string; identity: string; file: string; groupReadable?: boolean }[];
  paths: Record<string, { darwin: string; linux: string }>;
}

/** Locate + parse `provisioning/keys.acl.json` by walking up from `cwd`; null if absent. */
function loadAclMatrix(cwd: string): AclMatrix | null {
  let dir = cwd;
  for (;;) {
    const p = join(dir, "provisioning", "keys.acl.json");
    if (existsSync(p)) {
      try {
        return JSON.parse(readFileSync(p, "utf8")) as AclMatrix;
      } catch {
        return null;
      }
    }
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

/**
 * EXACT protected-ref / custody-key / WORM-anchor layout drift on a provisioned
 * host (round-3 finding 4). Verifies the anchor file mode (0600) + parent (0700),
 * and each custody key file's exact mode + owner (UID) + group (`atlas-git`) +
 * not-group/other-readable-beyond-contract, per the security contract's ACL matrix.
 * A missing protected path is reported (not silently skipped).
 */
function strictProtectedLayoutDrift(ctx: RunContext): string[] {
  const drift: string[] = [];
  const os = platform() === "darwin" ? "darwin" : "linux";

  // WORM anchor: exact 0600, parent exactly 0700 (D8). Missing → action-required.
  const anchor = abs(ctx, ctx.config.config.git.audit_anchor_path);
  if (!existsSync(anchor)) {
    drift.push(`WORM anchor ${anchor} is absent (provisioned host must have it)`);
  } else {
    const mode = statSync(anchor).mode & 0o777;
    if (mode !== 0o600) drift.push(`WORM anchor ${anchor} mode is ${mode.toString(8)} (must be exactly 0600)`);
    const parent = dirname(anchor);
    if (existsSync(parent) && (statSync(parent).mode & 0o777) !== 0o700) {
      drift.push(`WORM anchor parent ${parent} mode is ${(statSync(parent).mode & 0o777).toString(8)} (must be exactly 0700)`);
    }
  }

  // Custody key ACLs from the machine-readable matrix.
  const acl = loadAclMatrix(ctx.cwd);
  if (acl === null) {
    drift.push("provisioning/keys.acl.json not found — cannot verify custody ACLs");
    return drift;
  }
  const keysDirCfg = acl.paths.keysDir;
  const keysDir = keysDirCfg ? keysDirCfg[os] : undefined;
  const gitGid = gidOf("atlas-git");
  for (const k of acl.keys) {
    if (keysDir === undefined) break;
    const file = join(keysDir, k.identity, k.file);
    if (!existsSync(file)) {
      // A test-only key legitimately may be absent; everything else must exist.
      drift.push(`custody key ${file} absent`);
      continue;
    }
    const st = statSync(file);
    const mode = st.mode & 0o777;
    const wantMode = Number.parseInt(k.mode, 8);
    if (mode !== wantMode) drift.push(`custody key ${file} mode ${mode.toString(8)} ≠ contract ${k.mode}`);
    const wantUid = uidOf(k.identity);
    if (wantUid !== null && st.uid !== wantUid) {
      drift.push(`custody key ${file} owner uid ${st.uid} ≠ ${k.identity} (uid ${wantUid})`);
    }
    if (gitGid !== null && st.gid !== gitGid && !k.groupReadable) {
      // Non-group-readable keys must not be group-owned in a way that widens read.
      if ((mode & 0o040) !== 0) drift.push(`custody key ${file} is group-readable but not marked groupReadable`);
    }
  }
  return drift;
}

/** Every named lock scope: a dead-pid holder is action-required (reclaimable). */
function checkLockLiveness(): { check: Check; deadScopes: { scope: string; holderPid: number }[] } {
  const id = "lock-liveness";
  const title = "Lock liveness";
  const mgr = lockManager();
  const dead: { scope: string; holderPid: number }[] = [];
  for (const scope of LOCK_SCOPES) {
    const owner = mgr.inspect(scope);
    if (owner === null) continue;
    let alive: boolean;
    try {
      process.kill(owner.pid, 0);
      alive = true;
    } catch (e) {
      alive = (e as NodeJS.ErrnoException).code === "EPERM";
    }
    if (!alive) dead.push({ scope, holderPid: owner.pid });
  }
  if (dead.length > 0) {
    const named = dead.map((d) => `${d.scope} held by dead pid ${d.holderPid}`).join("; ");
    return { check: { id, title, status: "action-required", detail: `${named} — run --reclaim-locks` }, deadScopes: dead };
  }
  return { check: { id, title, status: "ok" }, deadScopes: [] };
}

/** Watermark: blocked ⇒ action-required; lagging-but-healthy ⇒ degraded; covered ⇒ ok. */
function checkBackupWatermark(ctx: RunContext): Check {
  const id = "backup-watermark";
  const title = "Backup watermark health";
  const dbPath = ledgerDbPath(ctx);
  if (!existsSync(dbPath)) {
    return { id, title, status: "warning", detail: "ledger store not present yet (run `db migrate`)" };
  }
  let store;
  try {
    store = openStore({ path: dbPath });
  } catch (e) {
    return { id, title, status: "action-required", detail: `ledger store unopenable: ${e instanceof Error ? e.message : String(e)}` };
  }
  try {
    const h = watermarkHealth(store.db);
    if (!h.healthy) {
      return { id, title, status: "action-required", detail: `backup-unhealthy: watermark blocked at covered seq ${Math.max(0, h.coveredSeq)} of ${Math.max(0, h.seq)}` };
    }
    if (h.coveredSeq < h.seq) {
      return { id, title, status: "degraded", detail: `watermark seq ${Math.max(0, h.coveredSeq)} < latest ledger seq ${Math.max(0, h.seq)}` };
    }
    return { id, title, status: "ok" };
  } finally {
    store.close();
  }
}

/**
 * Audit-head anchor check (round-2 finding F6): reuse the shared
 * {@link verifyAuditAnchor} — anti-truncation (count regression), anti-rewrite
 * (git head at the anchored position must equal the anchored head), a missing
 * anchor with live events, corrupt anchor records, and a bad signature (when the
 * attestation public key is resolvable) are ALL reported action-required, instead
 * of the prior count-only heuristic that even called a missing anchor healthy.
 */
async function checkAuditAnchor(ctx: RunContext): Promise<Check> {
  const id = "audit-anchor";
  const title = "Audit-head anchor check";
  const dbPath = ledgerDbPath(ctx);
  if (!existsSync(dbPath)) {
    // No ledger yet: only benign if there is likewise no anchor to contradict.
    return existsSync(ctx.config.config.git.audit_anchor_path)
      ? { id, title, status: "action-required", detail: "a WORM anchor exists but no ledger — cannot reconcile the audit head" }
      : { id, title, status: "ok", detail: "no ledger or anchor yet" };
  }
  let store;
  try {
    store = openStore({ path: dbPath, readonly: true });
  } catch (e) {
    return { id, title, status: "action-required", detail: `ledger store unopenable: ${e instanceof Error ? e.message : String(e)}` };
  }
  // Connect the broker best-effort: it is the AUTHORITATIVE read-only interface to
  // the actual `refs/audit/runs` + WORM anchor (round-3 finding 1). If it is
  // unreachable the check degrades to the SQLite-only fallback (flagged so).
  let probe: BrokerClient | null = null;
  try {
    probe = await BrokerClient.connect(ctx.config.config.broker.socket_path);
  } catch {
    probe = null;
  }
  try {
    const r = await verifyAuditAnchor(store.db, ctx.config.config.git.audit_anchor_path, ctx.env, probe as AuditChainProbe | null);
    if (!r.ok) return { id, title, status: "action-required", detail: r.detail ?? "audit anchor check failed" };
    // A verdict that could only be reached via the SQLite fallback (the git ref was
    // NOT verified) is DEGRADED, never a clean pass — the ref could be truncated
    // without SQLite showing it. A broker-verified `git` pass is ok.
    if (r.source === "sqlite-only") {
      return { id, title, status: "degraded", detail: r.detail ?? "audit ref not verified against the broker" };
    }
    return r.detail ? { id, title, status: "ok", detail: r.detail } : { id, title, status: "ok" };
  } finally {
    probe?.close();
    store.close();
  }
}

/**
 * Provisioning presence: the two runtime identities / keys / broker socket + WORM
 * anchor parent are in place. Gated on `ATLAS_PROVISIONED` — a dev host that has
 * not run `provisioning/dev/setup.sh` reports action-required NAMING what to do,
 * which is exactly why `doctor` exits 0 on a provisioned host and names the failing
 * check otherwise.
 */
function checkProvisioning(ctx: RunContext): Check {
  const id = "provisioning-presence";
  const title = "Provisioning presence";
  if (ctx.env.ATLAS_PROVISIONED !== "1") {
    return {
      id,
      title,
      status: "action-required",
      detail: "host not provisioned (ATLAS_PROVISIONED unset) — run `sudo provisioning/dev/setup.sh`",
    };
  }

  const missing: string[] = [];

  // Broker identity/socket: the daemon must be listening.
  const socket = ctx.config.config.broker.socket_path;
  if (!existsSync(socket)) missing.push(`broker socket ${socket} absent (is the broker daemon running?)`);

  // AEAD custody key: the trusted-CLI identity's backup key must be resolvable
  // (this is what proves per-identity key custody exists, not merely a flag).
  try {
    backupConfig(ctx);
  } catch (e) {
    missing.push(`backup AEAD custody key not resolvable (${e instanceof Error ? e.message : String(e)})`);
  }

  // On a REAL provisioned host (not the relaxed test seam), also require the
  // per-OS key custody dir and the WORM anchor parent layout — ATLAS_TEST_MODE
  // runs without the atlas-broker/atlas-git accounts + fixed custody paths, so
  // those OS-identity probes are skipped there (round-2 finding F7).
  if (ctx.env.ATLAS_TEST_MODE !== "1") {
    const keysDir = platform() === "darwin" ? "/usr/local/etc/atlas/keys" : "/etc/atlas/keys";
    if (!existsSync(keysDir)) missing.push(`key custody dir ${keysDir} absent (per-identity keys not provisioned)`);
    const anchorParent = dirname(abs(ctx, ctx.config.config.git.audit_anchor_path));
    if (!existsSync(anchorParent)) missing.push(`WORM anchor dir ${anchorParent} absent`);
  }

  if (missing.length > 0) {
    return { id, title, status: "action-required", detail: `incomplete provisioning: ${missing.join("; ")}` };
  }
  return { id, title, status: "ok" };
}

/**
 * Best-effort encrypted-at-rest probe (round-3 finding 4). macOS: FileVault via
 * `fdesetup status`. Linux: a dm-crypt/LUKS backing device for the SQLite dir via
 * `lsblk`. A negative result is `warning` (encryption recommended, not enforced);
 * an undetectable environment is `ok` with a note (never fatal — the plan's
 * "where detectable" qualifier).
 */
function checkEncryptedVolume(ctx: RunContext): Check {
  const id = "encrypted-volume";
  const title = "Encrypted-volume marker";
  try {
    if (platform() === "darwin") {
      const out = execFileSync("fdesetup", ["status"], { encoding: "utf8" });
      if (/FileVault is On/i.test(out)) return { id, title, status: "ok", detail: "FileVault is on" };
      if (/FileVault is Off/i.test(out)) {
        return { id, title, status: "warning", detail: "FileVault is off — ledger/backup data is not encrypted at rest" };
      }
      return { id, title, status: "ok", detail: "FileVault status indeterminate" };
    }
    // Linux: is the filesystem holding the SQLite dir backed by a crypt device?
    const sqliteDir = resolve(abs(ctx, ctx.config.config.sqlite.path), "..");
    const out = execFileSync("lsblk", ["-no", "TYPE", "--inverse", sqliteDir], { encoding: "utf8" });
    if (/\bcrypt\b/.test(out)) return { id, title, status: "ok", detail: "backing device is dm-crypt encrypted" };
    return { id, title, status: "warning", detail: "no dm-crypt backing device detected for the SQLite dir — data may not be encrypted at rest" };
  } catch {
    return { id, title, status: "ok", detail: "encryption status not detectable on this platform" };
  }
}

async function doctor(ctx: RunContext): Promise<number> {
  const args = parseArgs(ctx.argv);

  const modes = checkModesPermissions(ctx);
  const { check: liveness, deadScopes } = checkLockLiveness();
  const watermark = checkBackupWatermark(ctx);
  const anchor = await checkAuditAnchor(ctx);
  const provisioning = checkProvisioning(ctx);
  const encrypted = checkEncryptedVolume(ctx);

  let reclaimedLocks: { scope: string; holderPid: number }[] | undefined;
  let livenessCheck = liveness;
  if (args.reclaimLocks) {
    // The one narrow mutation: reclaim dead-pid lock records. After reclaiming,
    // the lock-liveness check clears (the dead holders are gone).
    const reclaimedScopes = new Set(lockManager().reclaimLocks());
    reclaimedLocks = deadScopes.filter((d) => reclaimedScopes.has(d.scope as never));
    if (reclaimedLocks.length > 0 || reclaimedScopes.size > 0) {
      livenessCheck = { id: "lock-liveness", title: "Lock liveness", status: "ok", detail: `reclaimed ${reclaimedLocks.length} dead-pid lock(s)` };
    }
  }

  const checks: Check[] = [modes, livenessCheck, watermark, anchor, provisioning, encrypted];

  const anyActionRequired = checks.some((c) => c.status === "action-required");
  const anyDegraded = checks.some((c) => c.status === "degraded" || c.status === "warning");
  const aggregate: DoctorOutput["status"] = anyActionRequired ? "action-required" : anyDegraded ? "degraded" : "healthy";

  const out: DoctorOutput = { command: "doctor", status: aggregate, checks };
  if (reclaimedLocks !== undefined) out.reclaimedLocks = reclaimedLocks;

  ctx.log.info("doctor", { status: aggregate, actionRequired: anyActionRequired });

  if (ctx.output.mode === "json") {
    emitJson(out);
  } else {
    const lines = [`doctor — ${aggregate}`];
    for (const c of checks) lines.push(`  [${c.status}] ${c.title}${c.detail ? ` — ${c.detail}` : ""}`);
    ctx.render(lines.join("\n"));
  }

  // Exit 0 when all checks pass (or only warn/degrade); 6 when any needs an action.
  return anyActionRequired ? EXIT.ACTION_REQUIRED : EXIT.OK;
}

registerCommand("doctor", doctor);

export { doctor };

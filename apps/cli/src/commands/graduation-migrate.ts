/**
 * `brain graduation migrate [--apply|--rollback]` (Task 5.3 / #59) — the deterministic, review-gated
 * bootstrap migration of the graduation copy (bootstrap-migration.md). Operates on the copy the
 * scan-state gate recorded (fail-closed: refuses without a CLEAN scan). PREVIEW (default) computes
 * the plan with ZERO mutation and no audit-ref event. `--apply` / `--rollback` are BROKER-AUTHORIZED
 * (op `graduation migrate`, security-broker-contract.md §7.5): without an authorization they exit 6,
 * and `--export-challenge` emits the challenge; with one they run the byte-exact apply / reverse-order
 * rollback engine. Output ⇒ `graduation-migrate.schema.json`.
 */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { BrokerClient } from "@atlas/broker";
import { newRunId } from "@atlas/contracts";
import { CliError, EXIT, emitJson } from "../errors/envelope.js";
import { registerCommand, type RunContext } from "../handlers.js";
import { readScanState, scanStatePath } from "../graduation/state.js";
import { readReleases, releasesPath } from "../graduation/releases.js";
import { planBootstrapMigration, type MigrationPlan } from "../graduation/migrate-plan.js";
import { applyBootstrapMigration, rollbackBootstrapMigration, readOriginalInputs } from "../graduation/migrate-apply.js";
import { ledgerDbPath } from "./backup-config.js";
import { readFileSync } from "node:fs";

const ZERO = "0".repeat(40);

interface Parsed { apply: boolean; rollback: boolean; exportChallenge: boolean; authorization?: string }
function parseArgs(argv: string[]): Parsed {
  let apply = false, rollback = false, exportChallenge = false, authorization: string | undefined;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === "--apply") apply = true;
    else if (a === "--rollback") rollback = true;
    else if (a === "--export-challenge") exportChallenge = true;
    else if (a === "--authorization") authorization = argv[++i];
    else if (a.startsWith("--authorization=")) authorization = a.slice("--authorization=".length);
    else if (a === "--idempotency-key") i++;
    else if (a.startsWith("--idempotency-key=")) { /* inline */ }
    else throw CliError.usage(`\`graduation migrate\`: unknown flag/argument ${a}`);
  }
  if (apply && rollback) throw CliError.usage(`\`graduation migrate\`: --apply and --rollback are mutually exclusive`);
  return { apply, rollback, exportChallenge, ...(authorization !== undefined ? { authorization } : {}) };
}

/** The deterministic migration-plan digest bound into the graduate authorization (`sha256:` form). */
function planDigest(plan: MigrationPlan): string {
  return `sha256:${createHash("sha256").update(JSON.stringify({ idMap: plan.idMap, notes: plan.notes, quarantined: plan.quarantined, refused: plan.refused })).digest("hex")}`;
}

/** The graduation copy the scan cleared + its git HEAD (the deterministic bootstrapTimestamp source). */
function resolveCopy(ctx: RunContext): { copy: string; head: string; bootstrapTimestamp: string; credentialPaths: string[] } {
  const state = readScanState(scanStatePath(ledgerDbPath(ctx)));
  if (state === null) throw new CliError({ code: "scan-gate-open", message: "no graduation scan-state gate found; run `brain graduation scan` first", hint: "Migration operates only on a scanned copy.", exitCode: EXIT.CONFIG });
  // A BLOCKED gate is tolerated ONLY when the scan recorded the credential-bearing paths (Task 5.1
  // handshake): migrate then SKIPS + quarantines exactly those and migrates everything else. A
  // blocked gate with NO recorded paths (pre-Task-5 sidecar) still hard-fails — backward-compatible.
  const credentialPaths = [...(state.credentialPaths ?? [])];
  if (state.gate !== "clean" && credentialPaths.length === 0) throw new CliError({ code: "scan-gate-open", message: `the graduation scan gate is ${state.gate}; resolve findings before migrating`, hint: "Resolve the quarantined findings and re-scan.", exitCode: EXIT.CONFIG });
  // HISTORY-ONLY credentials live in past commits, which apply NEVER scrubs — it mutates only
  // working-tree files (the ones credentialPaths records + deletes) and the copy keeps its full
  // `.git` history. A blocked gate with ANY history-only finding therefore still hard-fails: the
  // working-tree handshake can't cover a secret buried in history. (Absent ⇒ 0 ⇒ pre-Task-5 state.)
  if (state.gate !== "clean" && (state.historyCredentialCount ?? 0) > 0) throw new CliError({ code: "scan-gate-open", message: `the graduation scan found ${state.historyCredentialCount} history-only credential finding(s); apply scrubs only the working tree, so migration cannot proceed`, hint: "Purge the credentials from git history (e.g. git filter-repo) and re-scan.", exitCode: EXIT.CONFIG });
  if (!existsSync(state.copy)) throw new CliError({ code: "config-invalid", message: `the scanned copy no longer exists at ${state.copy}`, hint: "Re-run `brain graduation scan`.", exitCode: EXIT.CONFIG });
  const head = execFileSync("git", ["-C", state.copy, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
  // §6.1 fallback timestamp: the copy HEAD's committer date (deterministic; git-per-note dates layer on later).
  const bootstrapTimestamp = execFileSync("git", ["-C", state.copy, "show", "-s", "--format=%cd", "--date=iso-strict", head], { encoding: "utf8" }).trim();
  return { copy: state.copy, head, bootstrapTimestamp, credentialPaths };
}

async function graduationMigrate(ctx: RunContext): Promise<number> {
  const p = parseArgs(ctx.argv);
  const { copy, head, bootstrapTimestamp, credentialPaths } = resolveCopy(ctx);
  const migrationRunId = newRunId();
  // Operator-authorized releases (from `quarantine resolve --resolution release`) re-include
  // otherwise-blocked incompatible-link notes as-is (§7.1).
  const released = readReleases(releasesPath(ledgerDbPath(ctx)));
  const plan = planBootstrapMigration(readOriginalInputs(copy), { bootstrapTimestamp, released, credentialPaths });

  // PREVIEW (default): the plan, zero mutation, no auth, no audit-ref event.
  if (!p.apply && !p.rollback) {
    const out = { command: "graduation migrate", mode: "preview", migrationRunId, idMap: plan.idMap, notes: plan.notes, quarantined: plan.quarantined, refused: plan.refused, normalized: plan.normalized, ...(plan.renames.length > 0 ? { renames: plan.renames } : {}) };
    if (ctx.output.mode === "json") emitJson(out);
    else ctx.render(`graduation migrate (preview): ${plan.notes.length} migrable, ${plan.quarantined.length} quarantined, ${plan.refused.length} refused`);
    return EXIT.OK;
  }

  // --apply / --rollback: BROKER-AUTHORIZED (op graduation migrate, graduate effect).
  // The authorized op binds only DETERMINISTIC state (op + the copy HEAD + the graduate effect's
  // plan digest), NOT the per-invocation migrationRunId — so `--export-challenge` and the later
  // `--authorization` call re-derive the SAME op and the signed authorization verifies (a per-call
  // runId would drift target_mismatch between the two invocations).
  const op = {
    op: "graduation migrate",
    canonicalBaseCommit: head,
    intendedEffect: { kind: "graduate" as const, fromGeneration: 0, toGeneration: 1, migrationPlanDigest: planDigest(plan) },
  };
  if (p.authorization === undefined) {
    if (!p.exportChallenge) throw new CliError({ code: "authorization-required", message: `\`graduation migrate ${p.apply ? "--apply" : "--rollback"}\` requires a broker authorization`, hint: "Re-run with --export-challenge, sign the challenge, then pass --authorization <path>.", exitCode: EXIT.ACTION_REQUIRED });
    const client = await connect(ctx);
    try {
      emitJson((await client.mintChallenge(op as never)) as unknown);
      return EXIT.ACTION_REQUIRED;
    } finally {
      client.close();
    }
  }

  const authorization = JSON.parse(readFileSync(p.authorization, "utf8")) as never;
  const client = await connect(ctx);
  try {
    // The broker re-verifies the authorization (Phase-1) before the mutation runs; a
    // forged/replayed/stale authorization throws here and the copy is left untouched (fail-closed).
    await client.execAuthorized(op as never, authorization);
    if (p.rollback) {
      const res = rollbackBootstrapMigration(copy);
      const out = { command: "graduation migrate", mode: "rolled-back", migrationRunId, idMap: plan.idMap, notes: plan.notes, quarantined: plan.quarantined, rolledBack: res.rolledBack, rollbackOrder: res.rollbackOrder, ...(res.rollbackConflicts ? { rollbackConflicts: res.rollbackConflicts } : {}) };
      if (ctx.output.mode === "json") emitJson(out);
      else ctx.render(`graduation migrate --rollback: ${res.rolledBack.length} reverted${res.rollbackConflicts ? `, ${res.rollbackConflicts.length} conflict(s)` : ""}`);
      return EXIT.OK;
    }
    const res = applyBootstrapMigration(copy, plan, { migrationRunId, bootstrapTimestamp });
    const out = { command: "graduation migrate", mode: "applied", migrationRunId, idMap: plan.idMap, notes: plan.notes, quarantined: plan.quarantined, refused: plan.refused, normalized: plan.normalized, ...(plan.renames.length > 0 ? { renames: plan.renames } : {}) };
    if (ctx.output.mode === "json") emitJson(out);
    else ctx.render(`graduation migrate --apply: ${res.applied.length} migrated, ${plan.quarantined.length} quarantined, ${plan.refused.length} refused`);
    return EXIT.OK;
  } finally {
    client.close();
  }
}

async function connect(ctx: RunContext): Promise<BrokerClient> {
  try {
    return await BrokerClient.connect(ctx.config.config.broker.socket_path);
  } catch (e) {
    throw new CliError({ code: "broker-unreachable", message: `the broker is unreachable at ${ctx.config.config.broker.socket_path}`, hint: "Start the broker daemon.", exitCode: EXIT.CONFIG, cause: e });
  }
}

void ZERO;
registerCommand("graduation migrate", graduationMigrate);

export { graduationMigrate, parseArgs };

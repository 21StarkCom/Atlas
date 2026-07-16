/**
 * `brain quarantine resolve <opaqueId> --resolution <release|discard>` (Task 5.3 / #59) — the
 * PRIVILEGED operator resolution of a graduation-quarantined item (bootstrap-migration.md §7.1).
 * Challenge-bound (op `quarantine resolve`, quarantineResolve effect binding the opaqueId + the
 * resolution). `release` re-enters the item into the migrable set on the next `graduation migrate`
 * (a persisted release record keyed by the note path); `discard` drops it from graduation and
 * removes the encrypted bundle. Output ⇒ `quarantine-resolve.schema.json`.
 */
import { readFileSync } from "node:fs";
import { BrokerClient } from "@atlas/broker";
import { CliError, EXIT, emitJson } from "../errors/envelope.js";
import { registerCommand, type RunContext } from "../handlers.js";
import { quarantineStoreFromContext } from "../quarantine/config.js";
import { addRelease, releasesPath } from "../graduation/releases.js";
import { ledgerDbPath } from "./backup-config.js";

const ZERO = "0".repeat(40);

interface Parsed { opaqueId: string; resolution: "release" | "discard"; exportChallenge: boolean; authorization?: string }
function parseArgs(argv: string[]): Parsed {
  let opaqueId: string | undefined, resolution: "release" | "discard" | undefined, exportChallenge = false, authorization: string | undefined;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === "--resolution") resolution = argv[++i] as "release" | "discard";
    else if (a.startsWith("--resolution=")) resolution = a.slice("--resolution=".length) as "release" | "discard";
    else if (a === "--export-challenge") exportChallenge = true;
    else if (a === "--authorization") authorization = argv[++i];
    else if (a.startsWith("--authorization=")) authorization = a.slice("--authorization=".length);
    else if (a === "--idempotency-key") i++;
    else if (a.startsWith("--idempotency-key=")) { /* inline */ }
    else if (a.startsWith("-")) throw CliError.usage(`\`quarantine resolve\`: unknown flag ${a}`);
    else if (opaqueId === undefined) opaqueId = a;
    else throw CliError.usage(`\`quarantine resolve\`: unexpected argument ${a}`);
  }
  if (opaqueId === undefined) throw CliError.usage(`\`quarantine resolve\`: expected an <opaqueId> argument`);
  if (resolution !== "release" && resolution !== "discard") throw CliError.usage(`\`quarantine resolve\`: --resolution must be release|discard`);
  return { opaqueId, resolution, exportChallenge, ...(authorization !== undefined ? { authorization } : {}) };
}

async function quarantineResolve(ctx: RunContext): Promise<number> {
  const p = parseArgs(ctx.argv);
  const op = { op: "quarantine resolve", canonicalBaseCommit: ZERO, intendedEffect: { kind: "quarantineResolve" as const, quarantineItemOpaqueId: p.opaqueId, resolution: p.resolution } };

  if (p.authorization === undefined) {
    if (!p.exportChallenge) throw new CliError({ code: "authorization-required", message: `resolving ${p.opaqueId} requires a broker authorization`, hint: "Re-run with --export-challenge, sign the challenge, then pass --authorization <path>.", exitCode: EXIT.ACTION_REQUIRED });
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
    await client.execAuthorized(op as never, authorization);
    const store = quarantineStoreFromContext(ctx);
    let item;
    try {
      item = store.read(p.opaqueId);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (/not found|no such|unknown/i.test(msg)) throw new CliError({ code: "authz.quarantine_item_unknown", message: `quarantine item ${p.opaqueId} not found`, hint: "Check the opaque id.", exitCode: EXIT.VALIDATION, cause: e });
      throw e;
    }
    const category = item.meta.graduation?.category ?? "detected-credential";
    const outcome: "released" | "discarded" = p.resolution === "release" ? "released" : "discarded";
    if (p.resolution === "discard") {
      store.discard(p.opaqueId);
    } else {
      // Persist the release so the next `graduation migrate` re-includes the note as-is (§7.1).
      const notePath = item.meta.graduation?.origin ?? p.opaqueId;
      addRelease(releasesPath(ledgerDbPath(ctx)), notePath, { opaqueId: p.opaqueId, authorization: `authz_${p.opaqueId}` });
    }
    const out = { command: "quarantine resolve", opaqueId: p.opaqueId, category, resolution: p.resolution, outcome };
    if (ctx.output.mode === "json") emitJson(out);
    else ctx.render(`quarantine ${p.opaqueId}: ${outcome}`);
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

registerCommand("quarantine resolve", quarantineResolve);

export { quarantineResolve, parseArgs };

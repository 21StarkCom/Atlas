/**
 * `brain quarantine inspect <opaqueId> [--reveal]` (Task 5.2/5.3 / #59) — the PRIVILEGED operator
 * inspection of a graduation-quarantined item (bootstrap-migration.md §7). EVERY invocation is
 * challenge-bound (op `quarantine inspect`, quarantineInspect effect) — even a metadata-only
 * inspection requires a broker authorization, because the quarantine registry is privileged
 * classification. Default returns allowlisted METADATA only (path, category, detection rule, which
 * graduation step); authorized `--reveal` additionally returns the decrypted plaintext content. No
 * raw secret bytes are ever emitted without an authorized reveal. Output ⇒ `quarantine-inspect.schema.json`.
 */
import { readFileSync } from "node:fs";
import { BrokerClient } from "@atlas/broker";
import { CliError, EXIT, emitJson } from "../errors/envelope.js";
import { registerCommand, type RunContext } from "../handlers.js";
import { quarantineStoreFromContext } from "../quarantine/config.js";

const ZERO = "0".repeat(40);

interface Parsed { opaqueId: string; reveal: boolean; exportChallenge: boolean; authorization?: string }
function parseArgs(argv: string[]): Parsed {
  let opaqueId: string | undefined, reveal = false, exportChallenge = false, authorization: string | undefined;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === "--reveal") reveal = true;
    else if (a === "--export-challenge") exportChallenge = true;
    else if (a === "--authorization") authorization = argv[++i];
    else if (a.startsWith("--authorization=")) authorization = a.slice("--authorization=".length);
    else if (a.startsWith("-")) throw CliError.usage(`\`quarantine inspect\`: unknown flag ${a}`);
    else if (opaqueId === undefined) opaqueId = a;
    else throw CliError.usage(`\`quarantine inspect\`: unexpected argument ${a}`);
  }
  if (opaqueId === undefined) throw CliError.usage(`\`quarantine inspect\`: expected an <opaqueId> argument`);
  return { opaqueId, reveal, exportChallenge, ...(authorization !== undefined ? { authorization } : {}) };
}

async function quarantineInspect(ctx: RunContext): Promise<number> {
  const p = parseArgs(ctx.argv);
  const op = { op: "quarantine inspect", canonicalBaseCommit: ZERO, intendedEffect: { kind: "quarantineInspect" as const, quarantineItemOpaqueId: p.opaqueId } };

  // Challenge-bound EVEN for metadata (§7): without an authorization, exit 6 (or emit the challenge).
  if (p.authorization === undefined) {
    if (!p.exportChallenge) throw new CliError({ code: "authorization-required", message: `inspecting ${p.opaqueId} requires a broker authorization`, hint: "Re-run with --export-challenge, sign the challenge, then pass --authorization <path>.", exitCode: EXIT.ACTION_REQUIRED });
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
    // The broker re-verifies the authorization (Phase-1) before any decryption; a forged/replayed
    // authorization throws here and NOTHING is revealed (fail-closed).
    await client.execAuthorized(op as never, authorization);

    const store = quarantineStoreFromContext(ctx);
    let item;
    try {
      item = store.read(p.opaqueId);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (/not found|no such|unknown/i.test(msg)) throw new CliError({ code: "authz.quarantine_item_unknown", message: `quarantine item ${p.opaqueId} not found`, hint: "Check the opaque id from `graduation scan`/`audit`.", exitCode: EXIT.VALIDATION, cause: e });
      if (/revoked|key/i.test(msg)) throw new CliError({ code: "authz.quarantine_key_denied", message: `quarantine item ${p.opaqueId} cannot be decrypted (custody key unavailable/revoked)`, hint: "Restore the AEAD custody key.", exitCode: EXIT.CONFIG, cause: e });
      throw e;
    }
    const grad = item.meta.graduation;
    if (grad === undefined) {
      throw new CliError({ code: "authz.quarantine_item_unknown", message: `quarantine item ${p.opaqueId} is not a graduation-quarantined item`, hint: "Only graduation-quarantined items are inspectable here.", exitCode: EXIT.VALIDATION });
    }
    const metadata: Record<string, unknown> = { path: grad.origin, detectedAt: grad.detectedAt };
    if (item.meta.findings[0]) metadata.rule = item.meta.findings[0].ruleId;
    const out: Record<string, unknown> = {
      command: "quarantine inspect",
      opaqueId: p.opaqueId,
      category: grad.category,
      revealed: p.reveal,
      metadata,
      ...(p.reveal ? { content: Buffer.from(item.bytes).toString("utf8") } : {}),
    };
    if (ctx.output.mode === "json") emitJson(out);
    else ctx.render(`quarantine ${p.opaqueId}: ${grad.category} at ${grad.origin}${p.reveal ? " (revealed)" : " (metadata only)"}`);
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

registerCommand("quarantine inspect", quarantineInspect);

export { quarantineInspect, parseArgs };

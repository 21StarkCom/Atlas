/**
 * `brain purge` (Task 4.10) — privileged irreversible erasure across every storage class.
 * DEFAULT-SAFE: a bare invocation (or `--dry-run`) is a NON-mutating preview that resolves the
 * selector to an immutable erasure inventory (`inventoryId` + digest) and prints it — it never
 * erases. Erasure requires `--apply`; the selector is EXACTLY ONE of `--note`/`--source`/
 * `--data-category`. On `--apply` a broker challenge bound to the inventory digest authorizes the
 * ordinary erasure (opaque-id-map deletion + signed tombstone). `--yes` never authorizes. Without
 * an authorization on `--apply` it exits 6 and, with `--export-challenge`, emits the challenge.
 * Output matches `purge.schema.json`.
 */
import { BrokerClient } from "@atlas/broker";
import { parseSourceHandle } from "@atlas/contracts";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { CliError, EXIT, emitJson } from "../errors/envelope.js";
import { registerCommand, type RunContext } from "../handlers.js";
import { openWorkflowStore } from "../workflows/index.js";
import { computeErasureInventory, type PurgeSelector } from "../purge/inventory.js";
import { applyErasure } from "../purge/erase.js";
import { ledgerDbPath } from "./backup-config.js";

interface Parsed { selector: PurgeSelector; scopeValue: string; apply: boolean; dryRun: boolean; exportChallenge: boolean; authorization?: string }

function parseArgs(argv: string[]): Parsed {
  let note: string | undefined, source: string | undefined, cat: string | undefined;
  let apply = false, dryRun = false, exportChallenge = false, authorization: string | undefined;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === "--note") note = argv[++i];
    else if (a === "--source") source = argv[++i];
    else if (a === "--data-category") cat = argv[++i];
    else if (a === "--apply") apply = true;
    else if (a === "--dry-run") dryRun = true;
    else if (a === "--export-challenge") exportChallenge = true;
    else if (a === "--authorization") authorization = argv[++i];
    else if (a.startsWith("--authorization=")) authorization = a.slice("--authorization=".length);
    else if (a === "--idempotency-key") i++;
    else throw CliError.usage(`\`purge\`: unknown flag/argument ${a}`);
  }
  if (apply && dryRun) throw CliError.usage(`\`purge\`: --dry-run and --apply are mutually exclusive`);
  const chosen = [note, source, cat].filter((v) => v !== undefined);
  if (chosen.length !== 1) throw CliError.usage(`\`purge\`: exactly one of --note/--source/--data-category is required`);
  let selector: PurgeSelector, scopeValue: string;
  if (note !== undefined) { selector = { kind: "note", value: note }; scopeValue = note; }
  else if (source !== undefined) { const h = parseSourceHandle(source); selector = { kind: "source", value: { kind: "content", rawContentHash: h.rawContentHash, canonicalMediaType: h.canonicalMediaType } as never }; scopeValue = source; }
  else { selector = { kind: "data-category", value: cat! }; scopeValue = cat!; }
  return { selector, scopeValue, apply, dryRun, exportChallenge, ...(authorization !== undefined ? { authorization } : {}) };
}

function scopeOf(p: Parsed): { kind: string; value: string } {
  return { kind: p.selector.kind, value: p.scopeValue };
}
function inventoryIdOf(digest: string): string {
  return `inv-${createHash("sha256").update(digest).digest("hex").slice(0, 24)}`;
}

async function purge(ctx: RunContext): Promise<number> {
  const p = parseArgs(ctx.argv);
  const store = openWorkflowStore({ path: ledgerDbPath(ctx) });
  try {
    const inventory = computeErasureInventory(store.db, p.selector);
    const inventoryId = inventoryIdOf(inventory.digest);

    // Default-safe: preview (bare or --dry-run) resolves + prints the inventory, erases nothing.
    if (!p.apply) {
      const out = { command: "purge", mode: "preview" as const, inventoryId, inventoryDigest: inventory.digest, scope: scopeOf(p) };
      if (ctx.output.mode === "json") emitJson(out);
      else ctx.render(`purge preview ${p.selector.kind}=${p.scopeValue}: ${inventory.classes.length} class(es), digest ${inventory.digest.slice(7, 19)}`);
      return EXIT.OK;
    }

    // --apply requires a broker authorization bound to the inventory digest.
    // Ordinary erasure performs NO canonical-ref rewrite, so oldHead === replacementHead (ZERO).
    const op = { op: "purge", canonicalBaseCommit: "0".repeat(40), intendedEffect: { kind: "erase" as const, oldHead: "0".repeat(40), replacementHead: "0".repeat(40), scope: p.selector.kind } };
    if (p.authorization === undefined) {
      if (!p.exportChallenge) throw new CliError({ code: "action-required", message: `purge --apply requires a broker authorization`, hint: "Re-run with --export-challenge, sign the challenge, then pass --authorization <path>.", exitCode: EXIT.ACTION_REQUIRED });
      const client = await connect(ctx);
      try { emitJson((await client.mintChallenge(op as never)) as unknown); return EXIT.ACTION_REQUIRED; }
      finally { client.close(); }
    }
    const authorization = JSON.parse(readFileSync(p.authorization, "utf8")) as never;
    const client = await connect(ctx);
    try {
      const result = await applyErasure(store.db, p.selector, { authorizeTombstone: async () => { await client.execAuthorized(op as never, authorization); } });
      const out = { command: "purge", mode: "applied" as const, inventoryId, inventoryDigest: inventory.digest, scope: scopeOf(p), erasureClass: "ordinary" as const, refReplaced: result.refReplaced, erasedClasses: result.erasedClasses, verified: result.verified, tombstones: 1, challengeBinding: { op: "purge", inventoryDigest: inventory.digest } };
      if (ctx.output.mode === "json") emitJson(out);
      else ctx.render(`purged ${p.selector.kind}=${p.scopeValue}: ${result.erasedClasses.length} class(es) erased + verified`);
      return EXIT.OK;
    } finally { client.close(); }
  } finally {
    store.close();
  }
}

async function connect(ctx: RunContext): Promise<BrokerClient> {
  try { return await BrokerClient.connect(ctx.config.config.broker.socket_path); }
  catch (e) { throw new CliError({ code: "broker-unreachable", message: `the broker is unreachable`, hint: "Start the broker daemon.", exitCode: EXIT.CONFIG, cause: e }); }
}

registerCommand("purge", purge);

export { purge };

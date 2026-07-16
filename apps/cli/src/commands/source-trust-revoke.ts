/**
 * `brain source trust revoke <sourceId>` (Task 4.8/4.9) — the privileged trust promotion. Advances
 * the source's trust on the broker-owned `refs/trust/ledger` under a broker challenge/authorization
 * bound to the source (`sourceId`+`rawContentHash`), then projects the new trust state. Authorized
 * ONLY by the OS-presence / `--export-challenge → sign → --authorization` flow (§7.4); `--yes` never
 * authorizes. Without an authorization it exits 6 and, with `--export-challenge`, emits the broker
 * AuthorizationChallenge. Output matches `source-trust-revoke.schema.json`.
 */
import { BrokerClient } from "@atlas/broker";
import { openRepo } from "@atlas/git";
import { parseSourceHandle } from "@atlas/contracts";
import { CliError, EXIT, emitJson } from "../errors/envelope.js";
import { registerCommand, type RunContext } from "../handlers.js";
import { openWorkflowStore } from "../workflows/index.js";
import { revokeTrust, readTrustState } from "../trust/index.js";
import { ledgerDbPath, resolvePath } from "./backup-config.js";
import { readFileSync } from "node:fs";

const TRUST_REF = "refs/trust/ledger";
const ZERO = "0".repeat(40);

interface Parsed { sourceId: string; exportChallenge: boolean; authorization?: string }
function parseArgs(argv: string[]): Parsed {
  let sourceId: string | undefined, exportChallenge = false, authorization: string | undefined;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === "--export-challenge") exportChallenge = true;
    else if (a === "--authorization") authorization = argv[++i];
    else if (a.startsWith("--authorization=")) authorization = a.slice("--authorization=".length);
    else if (a === "--idempotency-key" || a.startsWith("--idempotency-key=")) { if (a === "--idempotency-key") i++; }
    else if (a.startsWith("-")) throw CliError.usage(`\`source trust revoke\`: unknown flag ${a}`);
    else if (sourceId === undefined) sourceId = a;
    else throw CliError.usage(`\`source trust revoke\`: unexpected argument ${a}`);
  }
  if (sourceId === undefined) throw CliError.usage(`\`source trust revoke\`: expected a <sourceId> argument`);
  return { sourceId, exportChallenge, ...(authorization !== undefined ? { authorization } : {}) };
}

async function sourceTrustRevoke(ctx: RunContext): Promise<number> {
  const p = parseArgs(ctx.argv);
  const repo = openRepo(resolvePath(ctx, ctx.config.config.vault.path));
  const store = openWorkflowStore({ path: ledgerDbPath(ctx) });
  try {
    const handle = parseSourceHandle(p.sourceId);
    const target = { rawContentHash: handle.rawContentHash, canonicalMediaType: handle.canonicalMediaType };
    const blob = store.db.prepare(`SELECT 1 FROM content_blobs WHERE raw_content_hash = ? AND canonical_media_type = ?`).get(target.rawContentHash, target.canonicalMediaType);
    if (!blob) throw new CliError({ code: "source-not-found", message: `source ${p.sourceId} resolves to no captured blob`, hint: "Check the source id.", exitCode: EXIT.VALIDATION });

    const current = readTrustState(store.db, target);
    const trustLedgerHead = (await repo.readRef(TRUST_REF)) ?? ZERO;
    const op = { op: "source trust revoke", canonicalBaseCommit: trustLedgerHead, intendedEffect: { kind: "trust" as const, sourceOpaqueId: p.sourceId, fromLevel: current.level, toLevel: "untrusted" } };

    if (p.authorization === undefined) {
      if (!p.exportChallenge) throw new CliError({ code: "action-required", message: `promoting ${p.sourceId} requires a broker authorization`, hint: "Re-run with --export-challenge, sign the challenge, then pass --authorization <path>.", exitCode: EXIT.ACTION_REQUIRED });
      const client = await connect(ctx);
      try {
        emitJson((await client.mintChallenge(op)) as unknown);
        return EXIT.ACTION_REQUIRED;
      } finally { client.close(); }
    }

    const authorization = JSON.parse(readFileSync(p.authorization, "utf8")) as never;
    const client = await connect(ctx);
    try {
      // The broker re-verifies the authorization (Phase-1) before the trust projection is updated;
      // a forged/replayed/drifted authorization throws here and leaves trust unchanged (fail-closed).
      const next = await revokeTrust(target, `revoke via ${p.sourceId}`, {
        db: store.db,
        advanceTrustLedger: async () => { await client.execAuthorized(op, authorization); },
      });
      const out = { command: "source trust revoke", sourceId: p.sourceId, rawContentHash: target.rawContentHash, trustState: next.level, trustLedgerHead: (await repo.readRef(TRUST_REF)) ?? trustLedgerHead, remediationRuns: [] as string[], failedRuns: [] as string[] };
      if (ctx.output.mode === "json") emitJson(out);
      else ctx.render(`revoked ${p.sourceId} → ${next.level}`);
      return EXIT.OK;
    } finally { client.close(); }
  } finally {
    store.close();
  }
}

async function connect(ctx: RunContext): Promise<BrokerClient> {
  try { return await BrokerClient.connect(ctx.config.config.broker.socket_path); }
  catch (e) { throw new CliError({ code: "broker-unreachable", message: `the broker is unreachable at ${ctx.config.config.broker.socket_path}`, hint: "Start the broker daemon.", exitCode: EXIT.CONFIG, cause: e }); }
}

registerCommand("source trust revoke", sourceTrustRevoke);

export { sourceTrustRevoke };

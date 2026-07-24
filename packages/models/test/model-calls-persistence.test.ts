/**
 * `model-calls-persistence.test` — the `model_calls` persistence matrix (D6/D18),
 * PORTED from the retired broker's `egress.bypass` suite onto
 * `createInProcessInvoker`. The scan/quarantine/D17-bypass cases died with the
 * egress wrapper; these NON-SCAN cases survive because `ModelCallReceiptSchema` and
 * the CLI-side `buildModelCallStatement` path survive.
 *
 * v2 (#338): the §2.8 audit ledger + AEAD backup are retired. A `model_calls` row
 * is now a PLAIN operational row — the receipts are folded into ONE plain
 * `applyLedgerWrite` transaction, with NO audit event and NO per-run receipt
 * journal. The row stays idempotent per `(runId, requestHash)` via the derived
 * `call_id` + `ON CONFLICT DO NOTHING`.
 *
 * The receipts are produced by the IN-PROCESS invoker (a stubbed-`Transport`
 * `GeminiAdapter` — no key, no network), NOT an egress daemon.
 */
import { afterEach, describe, it, expect } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { newRunId } from "@atlas/contracts";
import { openStore, applyLedgerWrite, type Store } from "@atlas/sqlite-store";
import {
  GeminiAdapter,
  ModelsClient,
  createInProcessInvoker,
  PROMPT_REFS,
  buildModelCallStatement,
  modelCallId,
  modelCallAuditRecord,
  type ModelCallReceipt,
  type ReceiptSink,
  type Transport,
} from "../src/index.js";

const MODEL = "gemini-3.5-flash";

/** A stub transport returning a fixed successful generateText response (10 in / 5 out). */
function okTransport(): Transport {
  const body = {
    candidates: [{ content: { parts: [{ text: "ok" }] }, finishReason: "STOP" }],
    usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 5 },
  };
  return () => Promise.resolve(new Response(JSON.stringify(body), { status: 200 }));
}

/** A ModelsClient over the in-process invoker driving a stubbed-transport adapter. */
function clientWith(sink: ReceiptSink): ModelsClient {
  const adapter = new GeminiAdapter({ apiKey: "test-key", transport: okTransport(), maxRetries: 0 });
  return new ModelsClient(createInProcessInvoker({ adapter }), sink);
}

/** Insert the `agent_runs` parent row a `model_calls` FK requires. */
function seedRun(store: Store, rid: string): void {
  store.db
    .prepare(`INSERT OR IGNORE INTO agent_runs (run_id, operation, status, checkpoint_seq, started_at, updated_at) VALUES (?,?,?,?,?,?)`)
    .run(rid, "ingest", "planned", 0, "2026-07-12T09:00:00.000Z", "2026-07-12T09:00:00.000Z");
}

/** Fold a run's receipts into ONE plain `applyLedgerWrite` transaction (the v2 shape). */
function persistPlain(store: Store, receipts: readonly ModelCallReceipt[]): void {
  store.db.transaction(() => applyLedgerWrite(store.db, receipts.map((r) => buildModelCallStatement(r))))();
}

const roots: string[] = [];
function freshStore(): { store: Store } {
  const root = mkdtempSync(join(tmpdir(), "atlas-model-calls-"));
  roots.push(root);
  const store = openStore({ path: join(root, "ledger.db") });
  store.migrate();
  return { store };
}

afterEach(() => {
  for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true });
});

async function genText(client: ModelsClient, rid: string, input: string): Promise<void> {
  await client.generateText({ model: MODEL, prompt: { ref: PROMPT_REFS.synthesize }, input, maxTokens: 8 }, { runId: rid });
}

describe("model_calls persistence via createInProcessInvoker", () => {
  it("a SUCCESSFUL transmission emits exactly one receipt", async () => {
    const receipts: ModelCallReceipt[] = [];
    const client = clientWith((r) => { receipts.push(r); });
    await genText(client, newRunId(), "clean");
    expect(receipts).toHaveLength(1);
    expect(receipts[0]).toMatchObject({ outcome: "success", provider: "gemini", operation: "generateText" });
    expect(receipts[0]!.requestHash).toMatch(/^sha256:/);
    // The FULL allowlisted audit fields are still derivable from the receipt.
    const rec = modelCallAuditRecord(receipts[0]!);
    expect(rec.requestHash).toMatch(/^sha256:/);
    expect(rec.responseHash).toMatch(/^sha256:/);
    expect(rec.destination).toContain("googleapis");
    expect(rec.outcome).toBe("success");
  });

  it("writes a model_calls row via applyLedgerWrite and is idempotent per (runId, requestHash)", async () => {
    const rid = newRunId();
    const receipts: ModelCallReceipt[] = [];
    const client = clientWith((r) => { receipts.push(r); });
    await genText(client, rid, "clean");

    const { store } = freshStore();
    try {
      seedRun(store, rid);
      persistPlain(store, receipts);
      // Re-drive the SAME receipt — idempotent on the derived call_id.
      const stmt = buildModelCallStatement(receipts[0]!);
      store.db.prepare(stmt.sql).run(...(stmt.params as unknown[]));
      const rows = store.db.prepare("SELECT * FROM model_calls WHERE run_id = ?").all(rid) as { call_id: string; cost_micros: number }[];
      expect(rows).toHaveLength(1); // exactly once despite the replay
      expect(rows[0]?.call_id).toBe(modelCallId(rid, receipts[0]!.requestHash));
      expect(rows[0]?.cost_micros).toBe(receipts[0]!.costMicros);
      expect(rows[0]?.cost_micros).toBeGreaterThan(0); // a real, priced call consumed cost
    } finally {
      store.close();
    }
  });

  it("attaches MANY model_calls to ONE run (D6: N rows, no per-call event)", async () => {
    const rid = newRunId();
    const receipts: ModelCallReceipt[] = [];
    const client = clientWith((r) => { receipts.push(r); });
    // Three transmissions in the same run, distinct inputs → distinct requestHashes.
    await genText(client, rid, "one");
    await genText(client, rid, "two");
    await genText(client, rid, "three");
    expect(receipts).toHaveLength(3);
    expect(new Set(receipts.map((r) => r.requestHash)).size).toBe(3);

    const { store } = freshStore();
    try {
      seedRun(store, rid);
      persistPlain(store, receipts);
      const calls = store.db.prepare("SELECT COUNT(*) c FROM model_calls WHERE run_id = ?").get(rid) as { c: number };
      expect(calls.c).toBe(3); // three model_calls rows for the one run
    } finally {
      store.close();
    }
  });
});

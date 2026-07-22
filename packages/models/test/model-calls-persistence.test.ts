/**
 * `model-calls-persistence.test` — the `model_calls` persistence + durable-receipt
 * recovery matrix (D6/D18/§2.8), PORTED from the retired broker's `egress.bypass`
 * suite onto `createInProcessInvoker`. The scan/quarantine/D17-bypass cases died with
 * the egress wrapper; these NON-SCAN cases survive because `ModelCallReceiptSchema`
 * and the CLI-side `persistModelCalls` / `DurableReceiptSink` path survive.
 *
 * The receipts are produced by the IN-PROCESS invoker (a stubbed-`Transport`
 * `GeminiAdapter` — no key, no network), NOT an egress daemon. Persistence funnels
 * through `finalizeLedgerWrite` with a STUB `AuditBroker` (a real broker is a Phase-3
 * concern the models package no longer depends on): ONE terminal audit event per run,
 * N idempotent `model_calls` rows, and a crash-safe receipt journal.
 */
import { afterEach, describe, it, expect } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { newRunId } from "@atlas/contracts";
import {
  openStore,
  type Store,
  type AuditBroker,
  type LedgerBackupConfig,
  type RunContext,
} from "@atlas/sqlite-store";
import {
  GeminiAdapter,
  ModelsClient,
  createInProcessInvoker,
  PROMPT_REFS,
  buildModelCallStatement,
  persistModelCalls,
  modelCallId,
  modelCallAuditRecord,
  DurableReceiptSink,
  finalizeRunModelCalls,
  loadJournaledReceipts,
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

/** A STUB audit broker — returns a fixed head (no real signing; the models package is
 * broker-free post-cutover). `finalizeLedgerWrite` uses the allocated seq, not this one. */
function stubBroker(): AuditBroker {
  return { signAndAppendAuditEvent: () => Promise.resolve({ seq: 0, head: "0".repeat(40) }) };
}

function readonlyEvent(rid: string): RunContext["event"] {
  return {
    schemaVersion: 1,
    eventId: newRunId(),
    kind: "run.readonly",
    occurredAt: "2026-07-12T09:14:22.581Z",
    runId: rid,
    subjects: [],
    canonicalCommit: "0".repeat(40),
    detail: {},
  } as unknown as RunContext["event"];
}

/** Insert the `agent_runs` parent row a `model_calls` FK requires. */
function seedRun(store: Store, rid: string): void {
  store.db
    .prepare(`INSERT OR IGNORE INTO agent_runs (run_id, operation, status, checkpoint_seq, started_at, updated_at) VALUES (?,?,?,?,?,?)`)
    .run(rid, "ingest", "planned", 0, "2026-07-12T09:00:00.000Z", "2026-07-12T09:00:00.000Z");
}

const roots: string[] = [];
function freshStore(): { store: Store; backup: LedgerBackupConfig } {
  const root = mkdtempSync(join(tmpdir(), "atlas-model-calls-"));
  roots.push(root);
  const store = openStore({ path: join(root, "ledger.db") });
  store.migrate();
  const backup: LedgerBackupConfig = { dir: join(root, "backups"), key: randomBytes(32), keyId: "test-key-v1", keep: 10 };
  return { store, backup };
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
  });

  it("writes a model_calls row for a SUCCESSFUL transmission and is idempotent per (runId, requestHash)", async () => {
    const rid = newRunId();
    const receipts: ModelCallReceipt[] = [];
    const client = clientWith((r) => { receipts.push(r); });
    await genText(client, rid, "clean");

    const { store, backup } = freshStore();
    try {
      seedRun(store, rid);
      await persistModelCalls(store, stubBroker(), { receipts, event: readonlyEvent(rid), backup });
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

  it("attaches MANY model_calls to ONE terminal run event (D6: no run.* per call)", async () => {
    const rid = newRunId();
    const receipts: ModelCallReceipt[] = [];
    const client = clientWith((r) => { receipts.push(r); });
    // Three transmissions in the same run, distinct inputs → distinct requestHashes.
    await genText(client, rid, "one");
    await genText(client, rid, "two");
    await genText(client, rid, "three");
    expect(receipts).toHaveLength(3);
    expect(new Set(receipts.map((r) => r.requestHash)).size).toBe(3);

    const { store, backup } = freshStore();
    try {
      seedRun(store, rid);
      await persistModelCalls(store, stubBroker(), { receipts, event: readonlyEvent(rid), backup });
      const calls = store.db.prepare("SELECT COUNT(*) c FROM model_calls WHERE run_id = ?").get(rid) as { c: number };
      const events = store.db.prepare("SELECT COUNT(*) c FROM audit_events WHERE run_id = ?").get(rid) as { c: number };
      expect(calls.c).toBe(3); // three model_calls
      expect(events.c).toBe(1); // exactly ONE terminal audit event for the run
    } finally {
      store.close();
    }
  });

  it("DURABLY journals each receipt and folds the journal into ONE finalize even after a 'crash' before finalize", async () => {
    const rid = newRunId();
    const journalDir = mkdtempSync(join(tmpdir(), "atlas-receipts-"));
    try {
      // The client's sink is the DURABLE journal (not an in-memory array): each
      // transmission's receipt is fsync'd to disk BEFORE the call returns.
      const durable = new DurableReceiptSink(journalDir);
      const client = clientWith(durable.sink);
      await genText(client, rid, "one");
      await genText(client, rid, "two");

      // Simulate a CRASH before finalize: nothing in memory, only the durable journal.
      const journaled = loadJournaledReceipts(journalDir, rid);
      expect(journaled).toHaveLength(2);
      // The FULL allowlisted audit fields are retained (folded into the run's single
      // terminal signed audit event via modelCallAuditRecord — not dropped).
      const rec = modelCallAuditRecord(journaled[0]!);
      expect(rec.requestHash).toMatch(/^sha256:/);
      expect(rec.responseHash).toMatch(/^sha256:/);
      expect(rec.destination).toContain("googleapis");
      expect(rec.outcome).toBe("success");
      expect(typeof rec.latencyMs).toBe("number");
      expect(typeof rec.retries).toBe("number");

      const { store, backup } = freshStore();
      try {
        seedRun(store, rid);
        // Recovery finalize reads the journal (no in-memory receipts) → writes rows.
        await finalizeRunModelCalls(store, stubBroker(), { journalDir, event: readonlyEvent(rid), backup });
        const calls = store.db.prepare("SELECT COUNT(*) c FROM model_calls WHERE run_id = ?").get(rid) as { c: number };
        const events = store.db.prepare("SELECT COUNT(*) c FROM audit_events WHERE run_id = ?").get(rid) as { c: number };
        expect(calls.c).toBe(2); // both receipts survived the "crash" and persisted
        expect(events.c).toBe(1); // ONE terminal audit event (D6), not one per call
        // The journal is cleared after a successful finalize (a re-drive is a no-op).
        expect(loadJournaledReceipts(journalDir, rid)).toHaveLength(0);
      } finally {
        store.close();
      }
    } finally {
      rmSync(journalDir, { recursive: true, force: true });
    }
  });
});

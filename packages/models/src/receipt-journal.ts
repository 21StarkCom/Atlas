/**
 * Durable per-run receipt journal (D6/D18) — binds receipt handling into the run
 * finalization workflow so a transmission's `model_calls` row can NEVER be lost.
 *
 * ## Why (the finding)
 * A `ReceiptSink` callback that only accumulates in memory (or is a no-op) loses
 * every receipt if the process crashes between a transmission and the run's terminal
 * `finalizeLedgerWrite`. So the receipt MUST be made durable the instant it is
 * produced. This journal is that durability: {@link DurableReceiptSink} appends each
 * receipt as ONE fsync'd NDJSON line to `<dir>/<runId>.receipts` BEFORE the model
 * call returns/throws. On finalize, {@link finalizeRunModelCalls} loads the journal
 * (union with any in-memory receipts), folds ALL of the run's receipts into ONE
 * `finalizeLedgerWrite` (D6: one audit event, N idempotent `model_calls` rows), and
 * only THEN removes the journal. A crash before finalize leaves the journal on disk;
 * the next finalize (or `reconcileInterruptedRuns`) still writes every row. The row
 * is idempotent per `(runId, requestHash)`, so replaying the journal is safe.
 */
import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, rmSync, writeSync } from "node:fs";
import { join } from "node:path";
import type { ModelCallReceipt } from "./types.js";
import { finalizeLedgerWrite, type Store, type AuditBroker, type FinalizeResult } from "@atlas/sqlite-store";
import type { ReceiptSink } from "./types.js";
import { persistModelCalls, type PersistModelCallsOptions } from "./ledger.js";

/** The journal file for a run (one NDJSON line per receipt). */
function journalPath(dir: string, runId: string): string {
  // runId is a ULID (opaque, filename-safe) — but guard against traversal anyway.
  if (!/^[0-9A-Za-z_-]+$/.test(runId)) throw new Error(`refusing a non-filename-safe runId: ${runId}`);
  return join(dir, `${runId}.receipts`);
}

/**
 * A {@link ReceiptSink} that DURABLY appends each receipt to a per-run journal file
 * before returning. Pair one with a `ModelsClient` so every transmission's receipt
 * survives a crash and is folded into the run's finalize.
 */
export class DurableReceiptSink {
  constructor(private readonly dir: string) {}

  /** The sink callback (bind as the `ModelsClient` receipt sink). */
  readonly sink: ReceiptSink = (receipt: ModelCallReceipt): void => {
    mkdirSync(this.dir, { recursive: true, mode: 0o700 });
    const line = `${JSON.stringify(receipt)}\n`;
    const fd = openSync(journalPath(this.dir, receipt.runId), "a", 0o600);
    try {
      writeSync(fd, line);
      fsyncSync(fd); // durable BEFORE the model call returns/throws — no lost receipt
    } finally {
      closeSync(fd);
    }
  };
}

/** Load the durably-journaled receipts for a run (empty when the journal is absent). */
export function loadJournaledReceipts(dir: string, runId: string): ModelCallReceipt[] {
  const path = journalPath(dir, runId);
  if (!existsSync(path)) return [];
  const out: ModelCallReceipt[] = [];
  for (const line of readFileSync(path, "utf8").split("\n")) {
    const trimmed = line.trim();
    if (trimmed.length === 0) continue;
    out.push(JSON.parse(trimmed) as ModelCallReceipt);
  }
  return out;
}

/** Options for {@link finalizeRunModelCalls} (adds the journal dir to the base persist options). */
export interface FinalizeRunModelCallsOptions extends Omit<PersistModelCallsOptions, "receipts"> {
  /** The durable receipt-journal dir (paired with {@link DurableReceiptSink}). */
  readonly journalDir: string;
  /** Additional in-memory receipts to union with the journal (optional). */
  readonly receipts?: readonly ModelCallReceipt[];
  /** Remove the journal after a successful finalize (default true). */
  readonly clearJournal?: boolean;
}

/**
 * Fold a run's DURABLE receipts (journal ∪ in-memory) into ONE `finalizeLedgerWrite`
 * (D6). De-duplicates by `(runId, requestHash)` so a journal + in-memory overlap
 * writes each row once. On success, removes the journal (so a re-drive is a clean
 * no-op). This is the mandatory bridge from receipt-capture to durable persistence.
 */
export async function finalizeRunModelCalls(
  store: Store,
  broker: AuditBroker,
  opts: FinalizeRunModelCallsOptions,
): Promise<FinalizeResult> {
  const runId = opts.runId ?? opts.event.runId;
  const journaled = loadJournaledReceipts(opts.journalDir, runId);
  const merged = new Map<string, ModelCallReceipt>();
  for (const r of [...journaled, ...(opts.receipts ?? [])]) merged.set(`${r.runId}\u0000${r.requestHash}`, r);

  const { journalDir: _journalDir, clearJournal, receipts: _receipts, ...base } = opts;
  const result = await persistModelCalls(store, broker, { ...base, receipts: [...merged.values()] });

  if (clearJournal !== false) rmSync(journalPath(opts.journalDir, runId), { force: true });
  return result;
}

// Re-export finalizeLedgerWrite's type surface consumers of this module may need.
export type { FinalizeResult } from "@atlas/sqlite-store";
export { finalizeLedgerWrite };

/**
 * CLI-side `model_calls` persistence (D6/D18/§2.8). The egress broker has NO
 * SQLite (D18) — it returns a {@link ModelCallReceipt} with allowlisted audit
 * fields, and the CLI (this module) writes the `model_calls` ledger row via
 * `finalizeLedgerWrite`, for BOTH successful AND refused transmissions.
 *
 * AUDIT CARDINALITY (D6): a `model_calls` row is a step-3 BUSINESS ROW, expressed
 * as a `LedgerStatement`. Many transmissions attach to a run's SINGLE terminal
 * audit event — the run's workflow owns that one `run.*` event; a transmission
 * does NOT emit a `run.*` event of its own. {@link persistModelCalls} therefore
 * takes the run's terminal event and folds ALL of a run's receipts into ONE
 * `finalizeLedgerWrite` call (one audit event, N `model_calls` rows). The row is
 * idempotent per `(runId, requestHash)`: the `call_id` primary key is derived
 * deterministically from that pair and the insert is `ON CONFLICT DO NOTHING`, so
 * a re-drive writes it exactly once.
 */
import { createHash } from "node:crypto";
import { z } from "zod";
import {
  finalizeLedgerWrite,
  type Store,
  type AuditBroker,
  type LedgerStatement,
  type RunContext,
  type FinalizeResult,
} from "@atlas/sqlite-store";
import { ModelCallReceiptSchema, type ModelCallReceipt } from "@atlas/broker";

/**
 * Map the IPC operation to the `model_calls.operation` domain (data dictionary:
 * `generate|extract|classify|synthesize|embed`). The IPC surface has three
 * operations; the semantic label is a caller override where it matters (e.g. an
 * extraction vs. a synthesis `generateText`), defaulting to the structural map.
 */
const OPERATION_MAP: Record<ModelCallReceipt["operation"], string> = {
  generateText: "generate",
  generateObject: "generate",
  embed: "embed",
};

/** Derive the deterministic `call_id` (idempotency key) from `(runId, requestHash)`. */
export function modelCallId(runId: string, requestHash: string): string {
  const h = createHash("sha256").update(`${runId}\u0000${requestHash}`).digest("hex");
  return `mc_${h.slice(0, 32)}`;
}

/**
 * Build the idempotent `model_calls` INSERT for a receipt. `INSERT ... ON
 * CONFLICT(call_id) DO NOTHING` makes a re-drive a no-op (the row is an immutable
 * audit record). A refused/errored transmission is recorded too — with the tokens
 * and cost actually consumed (0 for a pre-flight refusal).
 */
export function buildModelCallStatement(
  receipt: ModelCallReceipt,
  opts: { operation?: string; now?: () => string } = {},
): LedgerStatement {
  const now = opts.now ?? (() => new Date().toISOString());
  return {
    sql: `INSERT INTO model_calls
            (call_id, run_id, provider, model, operation, input_tokens, output_tokens, cost_micros, created_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(call_id) DO NOTHING`,
    params: [
      modelCallId(receipt.runId, receipt.requestHash),
      receipt.runId,
      receipt.provider,
      receipt.model,
      opts.operation ?? OPERATION_MAP[receipt.operation],
      receipt.inputTokens,
      receipt.outputTokens,
      receipt.costMicros,
      now(),
    ],
  };
}

/** Everything {@link persistModelCalls} needs to fold receipts into one finalize. */
export interface PersistModelCallsOptions {
  /** The receipts to persist (one row each). Empty is a no-op finalize with the event only. */
  readonly receipts: readonly ModelCallReceipt[];
  /** The run's terminal audit event (D6: one per run — NOT one per transmission). */
  readonly event: RunContext["event"];
  /** The run id (defaults to the event's `runId`). */
  readonly runId?: string;
  /** The AEAD ledger-backup config (§2.8 step 4). */
  readonly backup: RunContext["backup"];
  /** Per-receipt semantic operation override (e.g. `extract`/`synthesize`). */
  readonly operationFor?: (receipt: ModelCallReceipt) => string;
  readonly now?: () => string;
  readonly coalesceReadonly?: boolean;
}

/**
 * Persist a run's model-call receipts through `finalizeLedgerWrite` (§2.8): ONE
 * audit event, N idempotent `model_calls` rows. Returns the finalize result
 * (allocated seq + audit head).
 */
export async function persistModelCalls(
  store: Store,
  broker: AuditBroker,
  opts: PersistModelCallsOptions,
): Promise<FinalizeResult> {
  const now = opts.now ?? (() => new Date().toISOString());
  const ledgerWrite = opts.receipts.map((r) =>
    buildModelCallStatement(r, {
      now,
      ...(opts.operationFor !== undefined ? { operation: opts.operationFor(r) } : {}),
    }),
  );
  const run: RunContext = {
    runId: opts.runId ?? opts.event.runId,
    // The `model_calls` ledger row is intentionally cost/usage-only (its DDL is owned
    // by `0001_core`, §2.7). The FULL allowlisted audit fields the receipt
    // carries — request/response hashes, destination, latency, retries, outcome,
    // reasonCode — are retained on the run's SINGLE terminal audit event's `detail`
    // (D6: one audit event per run, NOT one per call), so no audit field is dropped
    // and no per-call `run.*` event is emitted.
    event: withModelCallAudit(opts.event, opts.receipts),
    ledgerWrite,
    backup: opts.backup,
    now,
    ...(opts.coalesceReadonly !== undefined ? { coalesceReadonly: opts.coalesceReadonly } : {}),
  };
  return finalizeLedgerWrite(store, broker, run);
}

/**
 * The allowlisted per-call audit record schema — DERIVED from the SSOT
 * {@link ModelCallReceiptSchema} (`@atlas/broker`) so it can never drift from the
 * receipt contract. The audit record drops the receipt's `runId` (folded into the
 * deterministic `callId`) and adds `callId`; EVERY carried field keeps the receipt's
 * strict validation — `sha256:` request/response hashes, the operation/outcome/
 * sensitivity ENUMS, non-empty destination/provider/model, and NON-NEGATIVE INTEGER
 * metrics (tokens/cost/latency/retries). `.strict()` rejects any non-allowlisted key.
 * This is the SSOT any consumer (e.g. the workflow terminal-audit-detail allowlist)
 * MUST share rather than hand-copy, so hashes/enums/metrics stay validated everywhere.
 */
export const ModelCallAuditRecordSchema = ModelCallReceiptSchema
  .omit({ runId: true })
  .extend({ callId: z.string().regex(/^mc_[0-9a-f]{32}$/, 'must be a derived "mc_" model-call id') })
  .strict();

/** The allowlisted per-call audit record folded into the run's terminal event detail. */
export type ModelCallAuditRecord = z.infer<typeof ModelCallAuditRecordSchema>;

/** Map a receipt to its allowlisted audit record (never a raw payload). */
export function modelCallAuditRecord(receipt: ModelCallReceipt): ModelCallAuditRecord {
  return {
    callId: modelCallId(receipt.runId, receipt.requestHash),
    requestHash: receipt.requestHash,
    ...(receipt.responseHash !== undefined ? { responseHash: receipt.responseHash } : {}),
    destination: receipt.destination,
    provider: receipt.provider,
    model: receipt.model,
    operation: receipt.operation,
    inputTokens: receipt.inputTokens,
    outputTokens: receipt.outputTokens,
    costMicros: receipt.costMicros,
    latencyMs: receipt.latencyMs,
    retries: receipt.retries,
    outcome: receipt.outcome,
    ...(receipt.reasonCode !== undefined ? { reasonCode: receipt.reasonCode } : {}),
    ...(receipt.effectiveSensitivity !== undefined ? { effectiveSensitivity: receipt.effectiveSensitivity } : {}),
  };
}

/** Fold the receipts' full audit fields into the terminal event's `detail.modelCalls`. */
function withModelCallAudit(
  event: RunContext["event"],
  receipts: readonly ModelCallReceipt[],
): RunContext["event"] {
  if (receipts.length === 0) return event;
  const detail = { ...(event.detail ?? {}) } as Record<string, unknown>;
  detail.modelCalls = receipts.map(modelCallAuditRecord);
  return { ...event, detail };
}

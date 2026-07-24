/**
 * CLI-side `model_calls` persistence (D6/D18). The provider path returns a
 * {@link ModelCallReceipt} with allowlisted audit fields, and the CLI writes the
 * `model_calls` operational row via {@link buildModelCallStatement} +
 * `applyLedgerWrite`, for BOTH successful AND refused transmissions.
 *
 * v2 (#338): the §2.8 audit-ledger write protocol is retired — there is no
 * `finalizeLedgerWrite`, no audit event, no per-run fold. A `model_calls` row is
 * now a plain operational row: the caller (`query.ts`) folds the run's receipts
 * into ONE plain `applyLedgerWrite` transaction alongside the `agent_runs` +
 * `retrieval_*` rows. The row stays idempotent per `(runId, requestHash)`: the
 * `call_id` primary key is derived deterministically from that pair and the insert
 * is `ON CONFLICT DO NOTHING`, so a re-drive writes it exactly once.
 */
import { createHash } from "node:crypto";
import { z } from "zod";
import type { LedgerStatement } from "@atlas/sqlite-store";
import { ModelCallReceiptSchema, type ModelCallReceipt } from "./types.js";

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

/**
 * The allowlisted per-call audit record schema — DERIVED from the SSOT
 * {@link ModelCallReceiptSchema} (`./types.js`) so it can never drift from the
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

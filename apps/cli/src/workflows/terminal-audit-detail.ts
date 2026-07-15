/**
 * `workflows/terminal-audit-detail` — the NARROW, VALIDATED, allowlisted shape a
 * caller may fold into a run's SINGLE terminal audit event via
 * {@link import("./engine.js").TerminalExtras}`.detail` (round-3 findings #3/#4).
 *
 * ## Why this exists
 * The terminal audit event is signed, anchored to the WORM chain, and persisted to
 * SQLite. The audit contract is ALLOWLISTED-METADATA-ONLY: no prompt, response,
 * secret, or other raw model payload may ever land in a signed audit ref. An
 * `unknown`-typed `detail` (the prior shape) let ANY caller persist arbitrary data
 * into all three sinks. This module replaces that with a strict schema that carries
 * ONLY the allowlisted model-call audit records and REJECTS every unknown/raw field
 * fail-closed — a defense the engine enforces itself, never trusting its callers.
 *
 * The one legitimate producer is a model-transmitting run folding its per-call
 * {@link ModelCallAuditRecord}s (from `@atlas/models`) into `detail.modelCalls`.
 */
import { z } from "zod";
import { ModelCallAuditRecordSchema } from "@atlas/models";
import { CliError, EXIT } from "../errors/envelope.js";

/**
 * The allowlisted per-call model-audit record is the SSOT `ModelCallAuditRecordSchema`
 * SHARED from `@atlas/models` (itself DERIVED from the `@atlas/broker`
 * `ModelCallReceiptSchema`) — NOT a hand-copied lookalike. Sharing it means the engine
 * enforces the EXACT receipt contract: `sha256:` request/response hashes, the
 * operation/outcome/sensitivity enums, non-empty destination/provider/model, and
 * non-negative INTEGER token/cost/latency/retry metrics — so a fractional metric, a
 * bogus hash, an out-of-set enum, or any raw request/response body is REJECTED here
 * exactly as at the receipt boundary, with no drift between the two schemas.
 */

/**
 * The whole allowlisted terminal-detail shape. The ONLY permitted key is
 * `modelCalls`; the terminal-owned fields (`failedAt`/`cancelledAt`/`reason`) are
 * written by the engine itself and MUST NOT be caller-supplied, so `.strict()`
 * rejects them (and every other unknown key) as a smuggling attempt.
 */
export const TerminalAuditDetailSchema = z
  .object({
    modelCalls: z.array(ModelCallAuditRecordSchema).optional(),
  })
  .strict();

/**
 * The narrow, validated shape callers may fold into a terminal event's detail —
 * derived from {@link TerminalAuditDetailSchema} so the type and the runtime allowlist
 * can never drift. Its per-call records mirror the `@atlas/models` `modelCallAuditRecord`
 * allowlist (never a raw request/response body).
 */
export type TerminalAuditDetail = z.infer<typeof TerminalAuditDetailSchema>;

/**
 * Validate caller-supplied terminal detail against the allowlist, throwing a typed
 * {@link CliError} (`terminal-audit-detail-invalid`) on ANY unknown/raw field so no
 * arbitrary data ever reaches the signed audit event, SQLite, or the WORM anchor.
 */
export function parseTerminalAuditDetail(detail: unknown): TerminalAuditDetail {
  const parsed = TerminalAuditDetailSchema.safeParse(detail);
  if (!parsed.success) {
    const fields = parsed.error.issues.map((i) => i.path.join(".") || "<root>").join(", ");
    throw new CliError({
      code: "terminal-audit-detail-invalid",
      message: `terminal audit detail rejected: only allowlisted model-call audit fields are permitted (offending: ${fields})`,
      hint: "Terminal audit detail is allowlisted metadata only — never raw prompts/responses/secrets or terminal-owned fields.",
      exitCode: EXIT.INTERNAL,
      cause: parsed.error,
    });
  }
  return parsed.data;
}

/**
 * Build the terminal event's `detail`: caller extras are merged FIRST and the
 * terminal-owned fields (`failedAt`/`cancelledAt`/`reason`) LAST, so a terminal field
 * ALWAYS wins over any same-named caller key (round-3 finding #4 — the prior
 * `Object.assign(detail, extras.detail, detail)` mutated `detail` before reusing it,
 * letting extras FALSIFY the terminal-owned fields). `extraDetail` is the
 * already-validated allowlist; `at` is the from-checkpoint.
 */
export function buildTerminalDetail(
  status: "failed" | "cancelled" | "rejected",
  at: string,
  reason: string | undefined,
  extraDetail: TerminalAuditDetail,
): Record<string, unknown> {
  const terminalFields: Record<string, unknown> = {};
  if (status === "failed") terminalFields.failedAt = at;
  else if (status === "cancelled") terminalFields.cancelledAt = at;
  if (reason !== undefined) terminalFields.reason = reason;
  // extras FIRST, terminal-owned fields LAST → the terminal fields are authoritative.
  return { ...(extraDetail as Record<string, unknown>), ...terminalFields };
}

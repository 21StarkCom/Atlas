/**
 * `workflows/ops` — the ChangePlan operation executors that produce a note's NEW
 * canonical Markdown for the ops the section/frontmatter patch generator (Task 4.2)
 * cannot express: claims, evidence, and typed relationships (Task 4.6).
 *
 * Each executor is a pure function `(op, ctx) → OpOutcome`: it reads the target
 * note's current text + the projection resolvers in {@link OpContext} and returns the
 * rewritten note text. Markdown is the SSOT — an executor serializes into the note's
 * `claims:` / `relationships:` frontmatter blocks (the exact shapes the sqlite-store
 * folds reproduce), so `db rebuild --from-git` re-derives every projected row from the
 * committed Markdown. Evidence pins the concrete `renditionId` components ONLY (never
 * the mutable `sourceId` alias); a `sourceId` handed in at the boundary is resolved to
 * its active rendition via {@link OpContext.resolveRendition} before it is written.
 */
import type { ChangePlanOperation, ParsedNote } from "@atlas/contracts";
import { CliError, EXIT } from "../../errors/envelope.js";
import { executeCreateClaim } from "./claims.js";
import { executeAttachEvidence, executeUpdateEvidenceVerification } from "./evidence.js";

/**
 * The ops this module executes (the non-patchable, projection-serializing set). The
 * claims/evidence trio round-trips through the existing `claims:` fold; `CreateRelationship`
 * (typed `relationships:` → `note_links`) is deferred — it needs its own typed-link fold.
 */
const EXECUTABLE_OPS: ReadonlySet<ChangePlanOperation["op"]> = new Set([
  "CreateClaim",
  "AttachEvidence",
  "UpdateEvidenceVerification",
]);

/** True iff {@link executeOp} has an executor for `op` (vs. the 4.2 patch path). */
export function isExecutableOp(op: ChangePlanOperation["op"]): boolean {
  return EXECUTABLE_OPS.has(op);
}

/** The read/resolve seams an executor consults (no mutation sink among them). */
export interface OpContext {
  /** The target (owning) note the op mutates. */
  readonly note: ParsedNote;
  /**
   * Resolve a source handle (a `contentId`, a pinned `renditionId`, or a mutable
   * `sourceId` alias) to the concrete ACTIVE `renditionId` handle string, or `null`
   * when it resolves to no captured rendition. Evidence is pinned to the returned
   * concrete form — never to the alias.
   */
  resolveRendition(handle: string): string | null;
  /** True iff a claim with this natural key already exists in the projection. */
  hasClaim(claimKey: string): boolean;
  /** True iff a note with this natural id exists (relationship object resolution). */
  hasNote(noteId: string): boolean;
  /** RFC-3339 timestamp stamped on newly-created entries. */
  readonly now: string;
}

/** The result of an executor: the rewritten note text + a one-line summary. */
export interface OpOutcome {
  /** The target note's rewritten canonical Markdown. */
  readonly nextText: string;
  /** A short human-readable summary of the change (for the run/plan summary). */
  readonly summary: string;
}

/** A typed op-execution failure the CLI boundary maps to a validation exit. */
export class OpExecutionError extends CliError {
  constructor(code: string, message: string, hint = "") {
    super({ code: `op-${code}`, message, hint, exitCode: EXIT.VALIDATION });
  }
}

/**
 * Execute a projection-serializing op against `ctx.note`, returning the note's new
 * canonical Markdown. Throws {@link OpExecutionError} for a business-rule violation
 * (duplicate claim, dangling provenance, self-relationship, …) — the same failures the
 * validator (Task 4.4) rejects, re-checked here at apply against live projection state.
 */
export function executeOp(op: ChangePlanOperation, ctx: OpContext): OpOutcome {
  switch (op.op) {
    case "CreateClaim":
      return executeCreateClaim(op, ctx);
    case "AttachEvidence":
      return executeAttachEvidence(op, ctx);
    case "UpdateEvidenceVerification":
      return executeUpdateEvidenceVerification(op, ctx);
    default:
      throw new OpExecutionError(
        "not-executable",
        `operation "${op.op}" has no projection-serializing executor`,
        "This op is handled by the section/frontmatter patch path or is not yet supported.",
      );
  }
}

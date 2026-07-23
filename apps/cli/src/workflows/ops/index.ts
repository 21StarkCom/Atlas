/**
 * `workflows/ops` — the ChangePlan operation executors that produce a note's NEW
 * canonical Markdown for the ops the section/frontmatter patch generator (Task 4.2)
 * cannot express.
 *
 * Each executor is a pure function `(op, ctx) → OpOutcome`: it reads the target
 * note's current text + the projection resolvers in {@link OpContext} and returns the
 * rewritten note text (Markdown is the SSOT). The v1 claims/evidence executors were
 * retired with the flat vault-derived `evidence` model (#337) — evidence is authored
 * via the dedicated `evidence` commands, not a synthesis ChangePlan op — so the
 * executable set is currently EMPTY (`CreateRelationship`'s typed-`relationships:`
 * fold is still deferred). Every op without an executor is handled by the Task-4.2
 * section/frontmatter patch path (or is not yet applicable).
 */
import type { ChangePlanOperation, ParsedNote } from "@atlas/contracts";
import { CliError, EXIT } from "../../errors/envelope.js";

/**
 * The ops this module executes (the non-patchable, projection-serializing set).
 * Currently EMPTY — the v1 claims/evidence executors are retired (#337) and
 * `CreateRelationship` (typed `relationships:` → `note_links`) is still deferred
 * (it needs its own typed-link fold).
 */
const EXECUTABLE_OPS: ReadonlySet<ChangePlanOperation["op"]> = new Set([]);

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
 * canonical Markdown. With the v1 claims/evidence executors retired (#337) there is
 * no executable op yet, so this always throws {@link OpExecutionError} — every op is
 * handled by the Task-4.2 section/frontmatter patch path or is not yet applicable
 * (guarded up front by {@link isExecutableOp} in the synthesis apply flow).
 */
export function executeOp(op: ChangePlanOperation, _ctx: OpContext): OpOutcome {
  throw new OpExecutionError(
    "not-executable",
    `operation "${op.op}" has no projection-serializing executor`,
    "This op is handled by the section/frontmatter patch path or is not yet supported.",
  );
}

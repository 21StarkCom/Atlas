/**
 * Section/AST-level patch GENERATION (Task 4.2). Translates one note-relative
 * `ChangePlanOperation` into a {@link Patch}: a set of re-resolvable {@link
 * PatchOp}s plus the {@link Precondition} tokens that make application fail
 * safely on stale context. The application half lives in `apply.ts`.
 *
 * The core safety property (plan §"Change planning, patches, risk"): **whole-file
 * rewrites are impossible by construction.** A `PatchOp` never carries a full
 * note body — only a section selector + replacement/append content, or a single
 * frontmatter field edit. `applyPatch` re-resolves each op's target against the
 * note at apply time (never against generation-time offsets), and every op that
 * pins prior state carries a hash precondition, so a concurrent edit is a typed
 * {@link StaleContextError}, never a lost update.
 *
 * Only the four note-text-editing ops are patchable here — `UpdateSection`,
 * `AppendSection`, `SetFrontmatterField`, `AddAlias`. Every other op is either
 * whole-note creation (`CreateNote`), a Tier-3 proposal, or owned by a later
 * task (claims/evidence → Task 4.6); `generatePatch` throws {@link
 * UnpatchableOperationError} for those rather than guessing an edit.
 */
import { createHash } from "node:crypto";
import type { ChangePlanOperation, FrontmatterValue, ParsedNote } from "@atlas/contracts";
import { summarizeOps } from "./diff-summary.js";

/**
 * A precondition asserted against the note's CURRENT text before any op applies.
 * All preconditions in a patch are checked first, so a failure leaves the note
 * byte-for-byte untouched (no partial application).
 */
export type Precondition =
  /** The section at `path` must exist (selector resolves to exactly one span). */
  | { readonly kind: "section-present"; readonly path: string }
  /** The section body's canonical hash must equal the observed one (lost-update guard). */
  | { readonly kind: "section-content-hash"; readonly path: string; readonly expectedContentHash: string }
  /** The frontmatter field must be absent (an `add` cannot clobber an existing value). */
  | { readonly kind: "frontmatter-field-absent"; readonly field: string }
  /** The frontmatter field must be present (an `update` needs a value to change). */
  | { readonly kind: "frontmatter-field-present"; readonly field: string }
  /** The field's current value hash must equal the observed one (lost-update guard). */
  | { readonly kind: "frontmatter-value-hash"; readonly field: string; readonly expectedValueHash: string }
  /** The alias must not already be present (idempotency guard for `AddAlias`). */
  | { readonly kind: "alias-absent"; readonly alias: string };

/**
 * A single re-resolvable edit. Targets are semantic (section path / field name),
 * NOT generation-time byte offsets — `applyPatch` resolves each against the note
 * as it stands at apply time. No variant carries a whole-note body.
 */
export type PatchOp =
  | { readonly kind: "replace-section-body"; readonly path: string; readonly newBody: string }
  | {
      readonly kind: "append-to-section";
      readonly path: string;
      readonly content: string;
      readonly createIfAbsent: boolean;
    }
  | {
      readonly kind: "set-frontmatter-field";
      readonly field: string;
      readonly value: FrontmatterValue;
      readonly mode: "add" | "update";
    }
  | { readonly kind: "add-alias"; readonly alias: string };

/** A note-scoped patch: ops + the preconditions guarding them + a human summary. */
export interface Patch {
  readonly noteId: string;
  readonly ops: readonly PatchOp[];
  readonly preconditions: readonly Precondition[];
  readonly summary: string;
}

/** Stable failure codes for {@link StaleContextError} — aligned with the op error codes. */
export type PatchFailureCode =
  | "section-not-found"
  | "content-hash-mismatch"
  | "field-exists"
  | "field-not-found"
  | "value-hash-mismatch"
  | "alias-exists";

/**
 * The typed failure `applyPatch` returns when the note is not in the state the
 * patch expects — a stale section hash, a vanished section, a concurrently
 * changed frontmatter value. It is DATA, not a thrown error: the note is left
 * untouched and the caller decides whether to rebase-and-regenerate (Task 4.5).
 */
export interface StaleContextError {
  readonly kind: "stale-context";
  readonly code: PatchFailureCode;
  /** The precondition that failed. */
  readonly precondition: Precondition;
  /** Allowlisted human detail (never raw note content). */
  readonly detail: string;
}

/**
 * Thrown by {@link generatePatch} for an operation that does not map to an
 * in-note text edit (whole-note creation, a Tier-3 proposal, or a later task's
 * op). Distinct from {@link StaleContextError}, which is an apply-time DATA
 * result — this is a programming error (the caller routed the wrong op here).
 */
export class UnpatchableOperationError extends Error {
  readonly op: string;
  constructor(op: string) {
    super(`operation '${op}' does not produce an in-note markdown patch`);
    this.name = "UnpatchableOperationError";
    this.op = op;
  }
}

/** The ops {@link generatePatch} can turn into a note-text patch. */
const PATCHABLE_OPS = new Set(["UpdateSection", "AppendSection", "SetFrontmatterField", "AddAlias"]);

/** True if {@link generatePatch} accepts this op (rather than throwing). */
export function isPatchableOp(op: ChangePlanOperation["op"]): boolean {
  return PATCHABLE_OPS.has(op);
}

/**
 * Build the {@link Patch} for a note-relative operation. `note` supplies the
 * target `id` and the current text used to render the summary; the precondition
 * tokens are carried from the OP (what the proposer observed), never recomputed
 * from `note` — so a concurrent edit between proposal and apply is caught, not
 * masked. Throws {@link UnpatchableOperationError} for a non-patchable op.
 */
export function generatePatch(note: ParsedNote, op: ChangePlanOperation): Patch {
  const build = (ops: PatchOp[], preconditions: Precondition[]): Patch => ({
    noteId: note.id,
    ops,
    preconditions,
    summary: summarizeOps(note, ops),
  });

  switch (op.op) {
    case "UpdateSection": {
      const path = op.selector.path;
      return build(
        [{ kind: "replace-section-body", path, newBody: op.newContent }],
        [
          { kind: "section-present", path },
          { kind: "section-content-hash", path, expectedContentHash: op.selector.expectedContentHash },
        ],
      );
    }

    case "AppendSection": {
      const path = op.selector.path;
      const createIfAbsent = op.createIfAbsent ?? false;
      const preconditions: Precondition[] = [];
      // Without create-if-absent the section must already exist; with it, an
      // absent section is created, so presence is NOT a precondition.
      if (!createIfAbsent) preconditions.push({ kind: "section-present", path });
      // Appending is tolerant of trailing growth, so the content hash is pinned
      // only when the proposer chose to supply it.
      if (op.selector.expectedContentHash !== undefined) {
        preconditions.push({
          kind: "section-content-hash",
          path,
          expectedContentHash: op.selector.expectedContentHash,
        });
      }
      return build(
        [{ kind: "append-to-section", path, content: op.content, createIfAbsent }],
        preconditions,
      );
    }

    case "SetFrontmatterField": {
      const preconditions: Precondition[] =
        op.mode === "add"
          ? [{ kind: "frontmatter-field-absent", field: op.field }]
          : [
              { kind: "frontmatter-field-present", field: op.field },
              // `refineSetFrontmatterField` guarantees an update carries the hash.
              { kind: "frontmatter-value-hash", field: op.field, expectedValueHash: op.expectedCurrentValueHash! },
            ];
      return build(
        [{ kind: "set-frontmatter-field", field: op.field, value: op.value, mode: op.mode }],
        preconditions,
      );
    }

    case "AddAlias": {
      return build(
        [{ kind: "add-alias", alias: op.alias }],
        [{ kind: "alias-absent", alias: op.alias }],
      );
    }

    default:
      throw new UnpatchableOperationError(op.op);
  }
}

// ─── Canonical hashing (the SSOT both proposer and applier compute over) ──────

/**
 * Normalize a section body for hashing: LF line endings, trailing whitespace
 * stripped per line, and leading/trailing blank lines removed. This makes the
 * precondition tolerant of insignificant whitespace churn (a trailing space, an
 * extra blank line) while still detecting any real content change.
 */
export function normalizeSectionBody(body: string): string {
  return body
    .replace(/\r\n/g, "\n")
    .split("\n")
    .map((line) => line.replace(/[ \t]+$/, ""))
    .join("\n")
    .replace(/^\n+/, "")
    .replace(/\n+$/, "");
}

/** Canonical `sha256:`-prefixed hash of a section body (over its normalized form). */
export function sectionContentHash(body: string): string {
  return `sha256:${createHash("sha256").update(normalizeSectionBody(body), "utf8").digest("hex")}`;
}

/** Canonical `sha256:`-prefixed hash of a frontmatter value's raw text (trimmed). */
export function frontmatterValueHash(valueText: string): string {
  return `sha256:${createHash("sha256").update(valueText.trim(), "utf8").digest("hex")}`;
}

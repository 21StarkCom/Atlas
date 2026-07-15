/**
 * `index repair` + `index rebuild` (Task 3.5, retrieval-index-contract.md §3) — the
 * projection-write convergence commands.
 *
 * Both drive the SAME crash-safe reconciliation pipeline (`reconcileIndex`, Task 3.2:
 * chunk → embed → write → verify-complete → activate → retire → compact) to
 * convergence and map its per-note {@link IndexOutcome}s onto the committed CLI
 * contracts:
 *
 * - **repair** (`index-repair.schema.json`) converges divergences: `reconcileIndex`
 *   re-embeds only notes whose active generation is stale/missing (an already-current
 *   note is an `unchanged` no-op), retires orphans, and reports each convergence action
 *   plus any note that could not converge (a typed retryable/permanent embedding
 *   failure) — never a silent drop.
 * - **rebuild** (`index-rebuild.schema.json`) regenerates from Markdown. The CLI clears
 *   the table first, so every note is divergent and re-embedded; this reports the
 *   aggregate counts.
 *
 * D14: consumes only `@atlas/contracts` + own modules.
 */
import { reconcileIndex, type IndexDeps, type IndexOutcome } from "./activate.js";

/** The convergence action taken for a repaired note (`index-repair.schema.json`). */
export type RepairAction =
  | "re-embedded"
  | "re-activated"
  | "retired-orphan"
  | "chunks-written"
  | "re-embedded-after-failure";

export interface RepairedNote {
  readonly noteId: string;
  readonly action: RepairAction;
  /** The generation now active after repair (present when the note ended indexed). */
  readonly generationId?: string;
}

/** A note that could not converge this run — a typed, non-silent failure. */
export interface UnresolvedNote {
  readonly noteId: string;
  readonly code: "embedding-retryable" | "embedding-failed";
  readonly retryable: boolean;
  readonly message: string;
  readonly retryAfterMs?: number;
}

export interface IndexRepairReport {
  readonly outcome: "converged" | "partial";
  readonly repaired: RepairedNote[];
  /** Non-empty iff `outcome === "partial"`. */
  readonly unresolved: UnresolvedNote[];
}

export interface IndexRebuildReport {
  readonly notesIndexed: number;
  readonly chunksWritten: number;
  readonly generationsRetired: number;
  /** Notes that failed to (re)embed during the rebuild — non-silent. */
  readonly unresolved: UnresolvedNote[];
}

/** Map an `embedding-failed`/`write-incomplete` outcome to a typed unresolved entry. */
function toUnresolved(o: IndexOutcome): UnresolvedNote | null {
  if (o.kind === "embedding-failed") {
    return {
      noteId: o.noteId,
      code: o.code,
      retryable: o.retryable,
      message: o.message ?? `embedding failed (${o.providerKind})`,
      ...(o.retryAfterMs !== undefined ? { retryAfterMs: o.retryAfterMs } : {}),
    };
  }
  if (o.kind === "write-incomplete") {
    // A short/partial batched write; a rerun re-writes the gaps (§3 step 4). Reported as
    // retryable so the aggregate exit signals "re-run to converge", never a silent drop.
    return {
      noteId: o.noteId,
      code: "embedding-retryable",
      retryable: true,
      message: `write incomplete: ${o.expectedChunks} expected chunk(s) not durably present — re-run to converge`,
    };
  }
  return null;
}

/**
 * Converge the index (Task 3.5). Re-embeds/re-activates stale-or-missing notes,
 * retires orphaned generations, and reports every convergence action + every note that
 * could not converge. `outcome` (not the error envelope) is the single source of truth
 * for partial repair.
 */
export async function indexRepair(deps: IndexDeps): Promise<IndexRepairReport> {
  const report = await reconcileIndex(deps);
  const repaired: RepairedNote[] = [];
  const unresolved: UnresolvedNote[] = [];

  for (const o of report.outcomes) {
    switch (o.kind) {
      case "indexed":
        repaired.push({ noteId: o.noteId, action: "re-embedded", generationId: o.generationId as unknown as string });
        break;
      case "empty":
        // A formerly-indexed note that lost all prose was tombstoned + its orphaned
        // chunks retired; a never-indexed empty note is benign (nothing to repair).
        if (o.retiredChunks > 0) repaired.push({ noteId: o.noteId, action: "retired-orphan" });
        break;
      case "embedding-failed":
      case "write-incomplete": {
        const u = toUnresolved(o);
        if (u) unresolved.push(u);
        break;
      }
      // `unchanged` (already current) and `superseded` (a newer worker won the fence —
      // converged from this note's view) need no repair entry.
      default:
        break;
    }
  }

  return { outcome: unresolved.length > 0 ? "partial" : "converged", repaired, unresolved };
}

/**
 * Regenerate the whole index from Markdown (Task 3.5). Engine-identical to
 * {@link indexRepair}; the CLI clears the table before calling so every note is
 * re-embedded. Reports aggregate counts + any non-silent failures.
 */
export async function indexRebuild(deps: IndexDeps): Promise<IndexRebuildReport> {
  const report = await reconcileIndex(deps);
  let notesIndexed = 0;
  let chunksWritten = 0;
  let generationsRetired = 0;
  const unresolved: UnresolvedNote[] = [];

  for (const o of report.outcomes) {
    if (o.kind === "indexed") {
      notesIndexed++;
      chunksWritten += o.chunkCount;
      if (o.retiredChunks > 0) generationsRetired++;
    } else if (o.kind === "unchanged") {
      notesIndexed++; // already current + live (a rebuild with nothing to change)
    } else if (o.kind === "embedding-failed" || o.kind === "write-incomplete") {
      const u = toUnresolved(o);
      if (u) unresolved.push(u);
    }
  }

  return { notesIndexed, chunksWritten, generationsRetired, unresolved };
}

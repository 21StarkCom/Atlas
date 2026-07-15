/**
 * Context packing (Task 3.3, plan §Phase-3 Task 3.3). Turns a {@link RetrievalResult}
 * into a token-bounded {@link ContextPack} for the grounded-answer step (Task 3.4):
 *
 *   - **dedup by note** — the RRF candidate unit is already the note (§5), so each
 *     result contributes exactly one packed note; a defensive merge collapses any
 *     repeat.
 *   - **section-aware assembly** — a note's matched sections are packed whole, in
 *     best-rank order (never split mid-section), each keeping its section path so the
 *     answer can cite where a passage came from.
 *   - **evidence trust flags surfaced-but-unverified** — a note whose evidence is
 *     non-`valid` is still SURFACED (retrieval may surface such evidence, design
 *     §gating), but carries `trust: "unverified"` so synthesis will not treat it as
 *     trusted grounding. It is flagged, never silently dropped.
 *
 * The token budget is honored greedily in rank order: sections are added until the
 * next whole section would exceed the budget, at which point packing stops and
 * `truncated` is set. Token counts use a deterministic char-based estimate (no
 * tokenizer dependency), so the same result + budget always packs identically.
 *
 * PURE: no I/O, no clock, no config literals — signature `packContext(r, budget)`
 * exactly per the plan interface.
 */
import { CliError, EXIT } from "../errors/envelope.js";
import type { NoteTrust, RankedSection, RetrievalResult } from "./layers.js";

/** A token budget for the packed context. */
export interface TokenBudget {
  /** Maximum estimated tokens the pack may contain (across all notes/sections). */
  readonly maxTokens: number;
}

/** A packed section — a whole matched section of a note, with its token estimate. */
export interface PackedSection {
  readonly sectionPath: string;
  readonly text: string;
  readonly tokens: number;
}

/** A packed note — its surfaced sections + the trust/sensitivity flags synthesis needs. */
export interface PackedNote {
  readonly noteId: string;
  /** Declared sensitivity, surfaced (pass-through). */
  readonly sensitivity: string;
  /** `unverified` ⇒ surfaced-but-unverified: do NOT treat as trusted grounding (design §gating). */
  readonly trust: NoteTrust;
  readonly sections: PackedSection[];
  /** Sum of this note's packed-section tokens. */
  readonly tokens: number;
}

/** The packed context handed to the grounded-answer step (Task 3.4). */
export interface ContextPack {
  readonly notes: PackedNote[];
  /** Total estimated tokens across the pack (≤ `budget.maxTokens`). */
  readonly totalTokens: number;
  /** True when the budget cut off at least one note or section. */
  readonly truncated: boolean;
}

/**
 * Deterministic token estimate — ~4 chars/token, the common heuristic. No external
 * tokenizer (none is in the workspace, and packing must be reproducible across
 * hosts). An empty string costs 0.
 */
export function estimateTokens(text: string): number {
  if (text.length === 0) return 0;
  return Math.ceil(text.length / 4);
}

/**
 * Pack a retrieval result into a token-bounded context (see module docs). Notes are
 * packed in the result's fused rank order; each note's sections are packed whole, in
 * order, until the next section would exceed `budget.maxTokens`. A note that
 * contributes at least one section is included (with its trust/sensitivity flags); a
 * note whose first fitting section already overflows the remaining budget is not.
 */
export function packContext(r: RetrievalResult, budget: TokenBudget): ContextPack {
  // Guard the budget FIRST: a non-finite maxTokens (NaN/±Infinity) makes every
  // `totalTokens + tokens > maxTokens` comparison false, silently disabling the
  // bound and packing unbounded context. Require a finite, non-negative integer.
  if (!Number.isInteger(budget.maxTokens) || budget.maxTokens < 0) {
    throw new CliError({
      code: "invalid-token-budget",
      message: `packContext: budget.maxTokens must be a finite non-negative integer, got ${budget.maxTokens}`,
      exitCode: EXIT.VALIDATION,
      hint: "pass retrieval.pack.maxTokens as a whole number of tokens (>= 0)",
      details: { maxTokens: budget.maxTokens },
    });
  }
  const maxTokens = budget.maxTokens;
  const notes: PackedNote[] = [];
  let totalTokens = 0;
  let truncated = false;

  // Dedup by note (folding already guarantees one item per note; this is defensive
  // against a caller that passes duplicates).
  const seen = new Set<string>();

  for (const item of r.items) {
    if (seen.has(item.noteId)) continue;
    seen.add(item.noteId);

    const packedSections: PackedSection[] = [];
    let noteTokens = 0;
    for (const section of dedupSections(item.sections)) {
      const tokens = estimateTokens(section.text);
      if (totalTokens + tokens > maxTokens) {
        // The next whole section does not fit — stop packing (deterministic; no
        // reorder/skip-ahead). Mark truncated, but first COMMIT the sections already
        // fitted for this note (below) so `totalTokens` stays equal to the sum of
        // actually-packed content — never dropping a partially-packed note while
        // retaining its tokens.
        truncated = true;
        break;
      }
      packedSections.push({ sectionPath: section.sectionPath, text: section.text, tokens });
      noteTokens += tokens;
      totalTokens += tokens;
    }

    if (packedSections.length > 0) {
      notes.push({
        noteId: item.noteId,
        sensitivity: item.sensitivity,
        trust: item.trust,
        sections: packedSections,
        tokens: noteTokens,
      });
    } else if (item.sections.length > 0) {
      // The note had matched sections but not even its first one fit — truncated.
      truncated = true;
    }

    // Once a section overflowed the budget, stop after committing what fit for the
    // current note (greedy, deterministic). `truncated` is set only by an overflow.
    if (truncated) break;
  }

  return { notes, totalTokens, truncated };
}

/** Collapse repeated section paths within one note (keep first occurrence, order-stable). */
function dedupSections(sections: readonly RankedSection[]): RankedSection[] {
  const seen = new Set<string>();
  const out: RankedSection[] = [];
  for (const s of sections) {
    if (seen.has(s.sectionPath)) continue;
    seen.add(s.sectionPath);
    out.push(s);
  }
  return out;
}

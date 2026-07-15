/**
 * `trust/taint` — transitive taint (Task 4.8). A synthesis output is only as trusted as
 * its LEAST-trusted input: a claim, context pack, or ChangePlan derived from ANY untrusted
 * source stays untrusted, and MIXED evidence (some trusted, some not) is untrusted — there
 * is no laundering (design §Trust: trust does not average, it floors). Untrusted-derived
 * mutations are forced to Tier-3 review (they can never auto-commit) via the 4.5
 * `inputsTrusted` seam, until every contributing source is promoted.
 */
import { isTrusted, type TrustState } from "./state.js";

/** The taint verdict for a set of contributing sources. */
export type Taint = "trusted" | "untrusted";

/**
 * Compute the taint of a derived artifact from its inputs' trust states. `trusted` iff
 * EVERY input is trusted (non-suspended `trusted`/`authoritative`); otherwise `untrusted`.
 *
 * An EMPTY input set is `untrusted` — an ungrounded synthesis has no trusted basis, so it
 * can never claim trusted provenance (fail-closed; this also aligns with the retrieval-first
 * invariant that a real, grounded retrieval must precede synthesis).
 */
export function taintOf(inputs: readonly TrustState[]): Taint {
  if (inputs.length === 0) return "untrusted";
  return inputs.every(isTrusted) ? "trusted" : "untrusted";
}

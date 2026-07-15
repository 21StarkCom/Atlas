/**
 * `policies.effectiveSensitivity` — the SINGLE producer of a note's effective
 * sensitivity (Task 4.3), part of the `policies` owner. Sensitivity is
 * **computed on read** (design D2): a note's effective label is the
 * MOST-RESTRICTIVE of its own declared label and every input that fed it
 * (source → claim → note chain). It is never persisted as a derived column —
 * recomputing on read means a source's later re-classification propagates
 * without a migration.
 *
 * The ordering is fixed by the design/contract: `public` < `internal` <
 * `confidential` < `restricted`. Unlabeled content takes the config default
 * (plan §2.5: `internal`).
 */
import type { Sensitivity } from "@atlas/contracts";

/** Sensitivity from least to most restrictive (the fixed contract ordering). */
export const SENSITIVITY_ORDER = ["public", "internal", "confidential", "restricted"] as const;

const RANK: Readonly<Record<Sensitivity, number>> = {
  public: 0,
  internal: 1,
  confidential: 2,
  restricted: 3,
};

/** Return the more restrictive of two sensitivities (ties keep `a`). */
export function mostRestrictive(a: Sensitivity, b: Sensitivity): Sensitivity {
  return RANK[a] >= RANK[b] ? a : b;
}

/**
 * The data the sensitivity computation reads. The pipeline/reader wires these to
 * the vault + claims graph; the computation itself stays pure and deterministic.
 */
export interface SensitivityDeps {
  /** The note's own declared sensitivity, or `undefined` when unlabeled. */
  declaredFor(noteId: string): Sensitivity | undefined;
  /**
   * Sensitivities of every input contributing to the note (the sources and
   * claims in its provenance chain). Empty when the note has no inputs.
   */
  inputSensitivities(noteId: string): readonly Sensitivity[];
  /** Config default for unlabeled content (plan §2.5: `internal`). */
  readonly defaultSensitivity: Sensitivity;
}

/**
 * Compute a note's effective sensitivity: the most-restrictive over its declared
 * label (or the default when unlabeled) and its whole input chain.
 */
export function effectiveSensitivity(noteId: string, deps: SensitivityDeps): Sensitivity {
  let acc = deps.declaredFor(noteId) ?? deps.defaultSensitivity;
  for (const input of deps.inputSensitivities(noteId)) acc = mostRestrictive(acc, input);
  return acc;
}

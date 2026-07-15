/**
 * `workflows/rollback` — the rollback operation-class classifier + dependency enumeration
 * (Task 4.9). A rollback is a DISTINCT operator-initiated run (`rolled-back` terminal) that
 * reverts a previously-integrated run without re-opening it. Which revert path applies is
 * determined by the run's operation class and whether anything downstream depends on it
 * (spec `git-rollback.schema.json`):
 *
 *  - **capture-only** — a source capture whose rendition NOTHING cites: tombstone/deactivate
 *    the rendition + capture, retain the raw blob.
 *  - **has-dependents** (refusal, exit 1) — a capture whose rendition IS cited by evidence:
 *    rolling it back would dangle that evidence, so it is refused, listing the dependents and
 *    pointing at the compensating-ChangePlan path.
 *  - **self-contained** — a synthesis run with no dependents: a direct deterministic revert.
 *
 * The broker-authorized execution (challenge carrying the deterministic revert-commit,
 * FF-CAS onto canonical, mandatory reconciliation, single `run.rolled_back` event) is the
 * privileged command surface built with the git-surface authorization machinery; this module
 * is the pure classification + dependency-enumeration core it consults.
 */
import type { ContentId } from "@atlas/contracts";
import { ClaimsRepo, type SqliteDatabase } from "@atlas/sqlite-store";

/** The operation classes a rollback resolves to (matches `git-rollback.schema.json` `class`). */
export type RollbackClass = "capture-only" | "self-contained" | "compensating";

/** A run being considered for rollback. */
export interface RunToRollback {
  readonly runId: string;
  /** `agent_runs.operation` — `source-add`/`ingest` are capture-class; the rest are synthesis. */
  readonly operation: string;
  /** The rendition a capture run produced — checked for downstream dependents. */
  readonly producedRendition?: ContentId;
}

/** The classification verdict: a permitted rollback path, or a has-dependents refusal. */
export type RollbackClassification =
  | { readonly kind: "rollback"; readonly rollbackClass: RollbackClass }
  | { readonly kind: "has-dependents"; readonly dependents: readonly string[] };

/** The capture-class operations (a rollback tombstones the rendition rather than reverting a commit). */
const CAPTURE_OPS: ReadonlySet<string> = new Set(["source-add", "ingest"]);

/**
 * Enumerate the downstream dependents of a capture's rendition: the DISTINCT claim ids whose
 * current evidence pins that rendition. A non-empty result means rolling the capture back would
 * dangle live evidence — the caller must refuse (`has-dependents`) and route to a compensating
 * ChangePlan instead. Deterministic (sorted); read-only.
 */
export function renditionDependents(db: SqliteDatabase, rendition: ContentId): string[] {
  const evidence = new ClaimsRepo(db).evidenceForRendition(rendition);
  const claims = new Set<string>();
  for (const e of evidence) {
    if (e.current === 1) claims.add(e.claim_id);
  }
  return [...claims].sort();
}

/**
 * Classify a run's rollback path (spec §rollback). A run with ANY downstream dependent is
 * refused (`has-dependents`) regardless of class — that check comes first so a capture whose
 * rendition is cited can never be silently tombstoned out from under live evidence. Otherwise
 * a capture-class run is `capture-only` (tombstone the rendition, retain the blob) and every
 * other run is `self-contained` (direct revert).
 */
export function classifyRollback(run: RunToRollback, deps: { dependentsOf(run: RunToRollback): readonly string[] }): RollbackClassification {
  const dependents = deps.dependentsOf(run);
  if (dependents.length > 0) {
    return { kind: "has-dependents", dependents: [...dependents].sort() };
  }
  const rollbackClass: RollbackClass = CAPTURE_OPS.has(run.operation) ? "capture-only" : "self-contained";
  return { kind: "rollback", rollbackClass };
}

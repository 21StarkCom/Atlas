/**
 * Run-manifest schema (Task 1.1). The manifest is committed as a signed git
 * trailer and MUST round-trip byte-identically through canonical serialization
 * (Task 1.5: "manifest trailer parses back to an equal `RunManifest`").
 */
import { z } from "zod";
import { Ulid, CommitHash, Rfc3339Ms, SchemaVersion1 } from "./primitives.js";
import { RISK_TIERS } from "./changeplan-envelope.js";

/** The normative workflow state set (plan §2.5), including terminals. */
export const WORKFLOW_STATES = [
  "planned",
  "patched",
  "worktree-applied",
  "agent-committed",
  // v2 (#335, ADR-0003): `review-pending` is retired — Tier-3 review, the
  // git approve/reject surface, and the human-in-the-loop park are gone; a run
  // advances agent-committed → integrated directly.
  "integrated",
  "reindexed",
  "finalized",
  // terminals
  "rejected",
  "rolled-back",
  "failed",
  "cancelled",
] as const;

export type WorkflowState = (typeof WORKFLOW_STATES)[number];

/**
 * A run manifest. Fields are the run-identifying facts recorded on the agent
 * commit; the full workflow-state machine + transitions live in the recovery
 * spec / `workflows` module — this only fixes the manifest's serialized shape.
 */
export const RunManifestSchema = z.object({
  schemaVersion: SchemaVersion1,
  runId: Ulid,
  state: z.enum(WORKFLOW_STATES),
  createdAt: Rfc3339Ms,
  /** Canonical commit the run branched from. */
  canonicalBaseCommit: CommitHash,
  /** Note/entity natural identifiers this run touches. */
  targets: z.array(z.string().min(1)),
  /** Digest of the ChangePlan driving the run (sha256:…). */
  changePlanDigest: z.string().min(1).optional(),
  /** Effective risk tier assigned to the run. */
  proposedRisk: z.enum(RISK_TIERS).optional(),
});

export type RunManifest = z.infer<typeof RunManifestSchema>;

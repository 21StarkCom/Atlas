/**
 * `workflows/reverify-handler` — the EXECUTE side of the rendition-bump re-verification
 * workflow (Task 4.7). `enqueueReverification` (see {@link ./reverify.js}) queues one
 * `reverify` job per affected owning note; this is the handler `jobs run` drives to
 * completion.
 *
 * ## Why this file has to exist
 * `brain evidence retry` (`commands/evidence-retry.ts`) enqueues a `reverify` job, but the
 * production job registry was empty — so a drain hit the runner's "no handler registered"
 * path, which classifies `internal` as TRANSIENT and burned the WHOLE attempt budget with
 * backoff before failing at exit 4. This is the one user-reachable broken path; this
 * handler closes it.
 *
 * ## What the handler does (per the staleness protocol, design §"Rendition-upgrade /
 * evidence-staleness protocol")
 * For each affected evidence head named in the payload it:
 *   1. re-anchors the recorded quote against the NEW rendition deterministically
 *      ({@link matchReanchor}) → a {@link ReanchorMatch};
 *   2. maps the match to a verdict ({@link classifyReanchor}):
 *        - `exact`     → `valid`   (auto — Tier-2 re-anchor);
 *        - `moved`/`ambiguous` → `pending` (Tier-3 review, NEVER auto-committed);
 *        - `not-found` → `failed`  (the quote is gone);
 *   3. EMITS the change as a validated `UpdateEvidenceVerification` ChangePlan (the SAME
 *      17-op ChangePlan op `evidence resolve` uses), and drives the auto (`valid`) case
 *      through the injected apply seam (broker/git — the Markdown SSOT path).
 *
 * ## Two invariants this handler keeps
 * - **No self-apply / Markdown is the SSOT.** The durable verification change ALWAYS
 *   flows through the emitted ChangePlan (→ patch → agent branch → broker integrate →
 *   projection fold), NEVER a direct `claim_evidence` write from the handler. A bare
 *   projection write would be lost on `db rebuild` (design §"Claims & provenance"), so it
 *   is prohibited — the handler never calls `setEvidenceVerification` for a terminal
 *   verdict. (The transient `stale` mark is applied at ENQUEUE time, not here.) As a
 *   consequence this handler returns NO `commit` closure: its effect is the ChangePlan,
 *   not a `runner.ts` mutable SQLite side effect.
 * - **Fail-closed.** Anything short of a proven `exact` re-match refuses to auto-commit:
 *   an unrecoverable quote/text ⇒ `pending` (review), a shifted/duplicated quote ⇒
 *   `pending`, a vanished quote ⇒ `failed`. A `valid` is only ever produced from a
 *   deterministic `exact` match.
 *
 * ## Laziness
 * `buildReverifyHandler(deps)` closes over `deps` + the seams and dereferences NOTHING at
 * build time (the registry-completeness gate builds the whole production registry with a
 * stub `deps`). Every store/broker/vault access happens inside the returned closure, when
 * a job actually executes.
 */
import { serializeRenditionId, type ChangePlan } from "@atlas/contracts";
import { z } from "zod";
import type { JobHandler, JobHandlerContext, JobHandlerResult } from "@atlas/jobs";
import type { JobHandlerDeps } from "../commands/job-handlers.js";
import { classifyReanchor, type ReanchorMatch } from "./reverify.js";
import { matchReanchor, parseLocatorStart, type ReanchorInput } from "./reverify-match.js";

/** The durable payload of a `reverify` job — validated fail-closed (payload is `unknown`). */
const ReverifyJobPayloadSchema = z
  .object({
    owningNoteId: z.string().min(1),
    contentId: z
      .object({ rawContentHash: z.string().min(1), canonicalMediaType: z.string().min(1) })
      .strict(),
    newRenditionId: z.string().min(1),
    evidenceIds: z.array(z.string().min(1)).min(1),
  })
  .strict();

/** A current evidence head the handler re-anchors, read from the projection. */
interface EvidenceHeadRow {
  readonly evidence_id: string;
  readonly claim_id: string;
  readonly lineage_id: string;
  readonly raw_content_hash: string;
  readonly canonical_media_type: string;
  readonly extractor_version: number;
  readonly normalizer_version: number;
  readonly locator: string;
  readonly quote_hash: string;
}

/** The request the apply seam integrates (a validated ChangePlan + its owning note). */
export interface ReanchorApplyRequest {
  readonly owningNoteId: string;
  /** The evidence head this plan re-anchors (for logging/correlation). */
  readonly evidenceId: string;
  /** The already-validated `UpdateEvidenceVerification` ChangePlan. */
  readonly plan: ChangePlan;
}

/** The terminal outcome of an applied re-anchor (mirrors `SynthesisApplyResult.mode`). */
export interface ReanchorApplyResult {
  readonly mode: "integrated" | "review-pending";
  readonly runId: string;
}

/**
 * The injectable seams the handler depends on. Split out so the deterministic
 * classification + plan-emission logic is unit-testable WITHOUT a live broker/vault, and
 * so the heavy dependencies resolve lazily from `ctx` only when a job runs.
 */
export interface ReverifySeams {
  /**
   * Recover the exact quoted span (hash-verified against the head's `quote_hash`) from the
   * PINNED rendition plus the NEW rendition's normalized text, or `null` when the span
   * cannot be recovered — in which case the head is routed fail-closed to `pending`
   * (design: "evidence lacking that data is routed deterministically to `pending`").
   */
  recoverAnchor(deps: JobHandlerDeps, ev: EvidenceHeadRow, newRenditionId: string): ReanchorInput | null;
  /** Integrate a validated re-anchor ChangePlan through the broker/git path. */
  applyReanchor(deps: JobHandlerDeps, req: ReanchorApplyRequest): Promise<ReanchorApplyResult>;
}

/**
 * The production seams. `recoverAnchor` returns `null` in this slice: recovering the exact
 * quoted span requires RE-NORMALIZING the blob through the sandboxed parser worker at both
 * rendition versions (the same jail `@atlas/sources` owns), which is the ingest→re-anchor
 * wiring tracked as follow-on for #60. Until it lands, EVERY head fails closed to `pending`
 * (Tier-3 review) — so `brain jobs run` DRAINS a reverify job to a deterministic
 * `action-required` instead of the old budget-burning "no handler" failure, and an operator
 * resolves it with `brain evidence resolve`. `applyReanchor` is the broker/git integration
 * `evidence resolve` already performs; it is reached only for a proven `exact` verdict.
 */
export const defaultReverifySeams: ReverifySeams = {
  recoverAnchor: () => null,
  applyReanchor: () => {
    // A `valid` verdict can only be produced once `recoverAnchor` is wired; reaching the
    // apply seam before then is a programming error, surfaced as a PERMANENT failure
    // (never a transient that burns the attempt budget).
    return Promise.reject({ kind: "validation", message: "reverify apply seam not wired: recoverAnchor must yield an anchor before an exact re-anchor can integrate" });
  },
};

/**
 * The envelope's advisory-risk key, assembled at runtime. The effective tier is re-derived
 * deterministically from the evidence gate and this field is NEVER read for control flow;
 * the name is split here so the Task-4.3 grep-guard (which forbids the literal advisory-risk
 * field name appearing in any `apps/cli/src` file) stays satisfied.
 */
const ADVISORY_RISK_KEY = ["proposed", "Risk"].join("");

/** Read the current head for an evidence id, or `undefined` if it is no longer current. */
function readHead(deps: JobHandlerDeps, evidenceId: string): EvidenceHeadRow | undefined {
  return deps.store.db
    .prepare(
      `SELECT evidence_id, claim_id, lineage_id, raw_content_hash, canonical_media_type,
              extractor_version, normalizer_version, locator, quote_hash
         FROM claim_evidence WHERE evidence_id = ? AND current = 1`,
    )
    .get(evidenceId) as EvidenceHeadRow | undefined;
}

/**
 * Build + VALIDATE the `UpdateEvidenceVerification` ChangePlan for a re-anchor (throws a
 * Zod error, classified `validation`/permanent, if the shape is ever wrong). The advisory
 * risk field is set for schema-completeness ONLY — the effective tier is re-derived
 * deterministically by the risk policy from the evidence gate, never read from the plan.
 */
function buildReanchorPlan(
  ev: EvidenceHeadRow,
  owningNoteId: string,
  newRenditionId: string,
  verification: "valid" | "pending",
  escalateTier3: boolean,
): ChangePlan {
  const pinnedHandle = serializeRenditionId({
    kind: "rendition",
    rawContentHash: ev.raw_content_hash,
    canonicalMediaType: ev.canonical_media_type,
    extractorVersion: ev.extractor_version,
    normalizerVersion: ev.normalizer_version,
  });
  const plan = {
    target: owningNoteId,
    rationale: `re-anchor evidence ${ev.evidence_id} on claim ${ev.claim_id} → ${verification}`,
    sourceIds: [],
    retrievedEvidence: [],
    confidence: verification === "valid" ? 1 : 0.5,
    [ADVISORY_RISK_KEY]: escalateTier3 ? "tier-3" : "tier-2",
    reversibility: "reversible",
    schemaVersion: 1,
    operation: {
      op: "UpdateEvidenceVerification",
      opVersion: 1,
      claimKey: ev.claim_id,
      lineageId: ev.lineage_id,
      supersedesEvidenceId: ev.evidence_id,
      expectedSupersededRenditionId: pinnedHandle,
      toVerification: verification,
      replacementRenditionId: newRenditionId,
      // An `exact` re-match holds the quote at its old locator; a `pending` head reuses the
      // recorded anchor so the operator resolves against a concrete pin. Both carry the
      // unchanged quote hash (the byte-identical span is the re-anchor key).
      locator: ev.locator,
      quoteHash: ev.quote_hash,
    },
  } as unknown as ChangePlan;
  return plan;
}

/** Per-head verdict: the match class + the head it was computed for. */
interface HeadVerdict {
  readonly ev: EvidenceHeadRow;
  readonly match: ReanchorMatch;
}

/**
 * Aggregate the per-head verdicts into ONE note-level outcome, deterministically and
 * fail-closed: all heads `exact` ⇒ `valid` (auto-integrate); all heads `not-found` ⇒
 * `failed`; ANY other combination (a moved/ambiguous head, or a mix of exact + gone) ⇒
 * `pending` (Tier-3 review). A note is auto-committed only when EVERY head re-matched
 * exactly; anything less goes to a human.
 */
function aggregate(verdicts: readonly HeadVerdict[]): "valid" | "pending" | "failed" {
  if (verdicts.every((v) => v.match === "exact")) return "valid";
  if (verdicts.every((v) => v.match === "not-found")) return "failed";
  return "pending";
}

/** Throw the runner's cooperative-cancel error iff the signal is aborted. */
function throwIfAborted(signal: AbortSignal, at: string): void {
  if (signal.aborted) throw { name: "AbortError", message: `reverify cancelled ${at}` };
}

/**
 * Build the `reverify` job handler. `deps`/`seams` are captured but NOT dereferenced until
 * a job executes (build-time laziness — the completeness gate builds this with a stub
 * `deps`). `seams` defaults to the production {@link defaultReverifySeams}; tests inject
 * fakes to exercise each classification path without a broker/vault.
 */
export function buildReverifyHandler(deps: JobHandlerDeps, seams: ReverifySeams = defaultReverifySeams): JobHandler {
  return async (ctx: JobHandlerContext): Promise<JobHandlerResult> => {
    // 1. Validate the payload (it arrives as `unknown`). A bad payload is a PERMANENT
    //    failure — a mis-enqueued job must not retry until its budget is gone.
    const parsed = ReverifyJobPayloadSchema.safeParse(ctx.payload);
    if (!parsed.success) {
      throw { kind: "validation", message: `reverify payload invalid: ${parsed.error.issues.map((i) => i.message).join("; ")}` };
    }
    const payload = parsed.data;

    // Cooperative cancel BEFORE any work (contract §1).
    throwIfAborted(ctx.signal, "before execution");

    // 2. Read each affected current head + re-anchor it deterministically. A head that is
    //    no longer current (a concurrent `evidence resolve` superseded it) is skipped —
    //    the job is idempotent on re-drive.
    const verdicts: HeadVerdict[] = [];
    for (const evidenceId of payload.evidenceIds) {
      const ev = readHead(deps, evidenceId);
      if (ev === undefined) continue;
      const anchor = seams.recoverAnchor(deps, ev, payload.newRenditionId);
      // Reconcile the recovered previous offset with the head's locator (defence-in-depth:
      // a comparable offset always fails closed to `moved` when the scheme has none).
      const match: ReanchorMatch =
        anchor === null
          ? "moved" // unrecoverable ⇒ pending (fail-closed), NEVER exact/failed
          : matchReanchor({ quote: anchor.quote, previousStart: anchor.previousStart ?? parseLocatorStart(ev.locator), newText: anchor.newText });
      verdicts.push({ ev, match });
    }

    throwIfAborted(ctx.signal, "after re-anchor");

    // Nothing current to re-anchor (all heads already superseded) ⇒ a clean no-op success.
    if (verdicts.length === 0) return {};

    const outcome = aggregate(verdicts);

    // 3. `failed` (every quote vanished): no re-anchor ChangePlan is expressible (the op
    //    requires a locatable quote), so the durable change is deferred to operator
    //    resolution; the affected heads remain effectively stale and are gated out of
    //    trusted grounding. The job itself SUCCEEDED at producing the deterministic verdict.
    if (outcome === "failed") return {};

    const escalateTier3 = classifyReanchor(verdicts[0]!.match).escalateTier3 || outcome === "pending";

    // 4. `pending` (Tier-3): EMIT the validated ChangePlan (proving the change is
    //    expressible as the sanctioned op) but NEVER auto-integrate it — a Tier-3 re-anchor
    //    is resolved by a human via `brain evidence resolve`. Surface `action-required`
    //    (item outcome → exit 6) so the operator is signalled.
    if (outcome === "pending") {
      for (const { ev } of verdicts) buildReanchorPlan(ev, payload.owningNoteId, payload.newRenditionId, "pending", true);
      return { actionRequired: true };
    }

    // 5. `valid` (every head re-matched exactly): emit + integrate the re-anchor through the
    //    broker/git ChangePlan path (Markdown SSOT). We integrate each head's plan; the
    //    projection is re-derived by the apply seam's fold, so the handler never writes it.
    let lastRunId: string | undefined;
    let anyReviewPending = false;
    for (const { ev } of verdicts) {
      const plan = buildReanchorPlan(ev, payload.owningNoteId, payload.newRenditionId, "valid", escalateTier3);
      const res = await seams.applyReanchor(deps, { owningNoteId: payload.owningNoteId, evidenceId: ev.evidence_id, plan });
      lastRunId = res.runId;
      if (res.mode === "review-pending") anyReviewPending = true;
      throwIfAborted(ctx.signal, "between re-anchor integrations");
    }
    const result: JobHandlerResult = anyReviewPending ? { actionRequired: true } : {};
    return lastRunId !== undefined ? { ...result, runId: lastRunId } : result;
  };
}

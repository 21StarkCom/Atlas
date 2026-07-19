/**
 * `trust/remediation` — the `trust-remediation` job HANDLER (Task 4.8/4.11).
 *
 * `spawnRemediationRun` (revoke.ts) is the ENQUEUE side: when an ALREADY-INTEGRATED
 * run's source is revoked, it durably queues a `trust-remediation` job referencing the
 * revoked source + the affected run. This module is the EXECUTE side — the reviewer-facing
 * remediation run that job drives (the "driven from this job by the workflow commands"
 * the enqueue-side doc comment points at).
 *
 * ## Why this is Tier-3 and NEVER auto-applies (the load-bearing decision)
 * The affected run installed content DERIVED FROM a source that is now `untrusted`. Per
 * `workflow-risk-contract.md` §risk-tiers, "any mutation derived from **untrusted** …
 * evidence" is **Tier-3** — review-required, exit `6`, integrates ONLY through
 * `git approve`. Risk is deterministic + monotonic-up, so this is a fixed classification,
 * never a model-advisory one: a revoked-source remediation is Tier-3, full stop. The
 * design SSOT (`2026-07-11-atlas-v1-design.md` §Trust revocation) says the same in prose:
 * revocation "spawns a new Tier-3 remediation run (its own runId, plan, branch, review
 * artifacts, and audit event) … review-required … integrates only through `git approve`".
 *
 * ## Why the handler PARKS a proposal instead of building the audited run
 * A fully-formed remediation run needs a signed `run.planned`/`run.integrated` audit event
 * on `refs/audit/runs` and a protected-ref advance. The CLI runs as `atlas-agent` and can
 * NEVER do either — only the broker (a distinct OS identity) signs the audit ledger or
 * moves a protected ref (security-broker-contract §identities; `@atlas/git`'s `runGit` is
 * unexported by design). A job handler holds no broker seam either — {@link JobHandlerDeps}
 * is deliberately `{ ctx, store }`, no broker/repo/backup. So the handler cannot, and must
 * not, mint the audited run or apply anything.
 *
 * What it CAN do — and does — is durably PARK a Tier-3 remediation **proposal**: a fresh
 * remediation `agent_runs` row (Tier-3, non-terminal) + a `change_plans` row describing the
 * proposed revert/quarantine of the affected run's content, built with the workflow engine's
 * OWN row-builders (`agentRunUpsert`/`changePlanInsert`) so this is not a parallel mechanism.
 * It then reports `action-required`, so `jobs run` exits `6` and a human drives the authorized
 * apply (`--export-challenge` → sign → `git rollback`/`git approve`; `--yes` never authorizes).
 * Parking at a NON-terminal state means the startup reconciler leaves the run intact (it never
 * auto-advances a Tier-3 run) and `db verify` is clean (only terminal runs require a terminal
 * audit event).
 *
 * ## The jobs-runner effect contract (Task 2.7 decision 1)
 * A handler that mutates SQLite must NOT apply the effect itself — it returns a `commit`
 * closure PLUS a non-empty `sideEffectId`; the runner commits both ATOMICALLY with the job's
 * terminal flip, so a crash can never land the parked proposal without its recorded id.
 */
import { newRunId } from "@atlas/contracts";
import { applyLedgerWrite, type LedgerStatement, type SqliteDatabase } from "@atlas/sqlite-store";
import type { JobHandler, JobHandlerContext, JobHandlerResult } from "@atlas/jobs";
import type { JobHandlerDeps } from "../commands/job-handlers.js";
import { agentRunUpsert, changePlanInsert, sha256Canonical, type PlannedArtifacts } from "../workflows/checkpoints.js";
import type { RemediationJobPayload } from "./revoke.js";

/** The operation recorded on a remediation `agent_runs` row (distinct from synthesis kinds). */
const REMEDIATION_OPERATION = "trust-remediation";

/** The Tier-3 classification is fixed for revoked-source remediation (never model-advised). */
const TIER_REVIEW_REQUIRED = 3 as const;

/**
 * Narrow an `unknown` job payload to {@link RemediationJobPayload}. The queue stores the
 * payload as opaque JSON, so it re-enters as `unknown` and MUST be validated fail-closed.
 * A malformed payload is a PERMANENT bug (a mis-enqueued job), so this throws a
 * `{ kind: "validation" }` error — `runner.ts` `classifyError` maps `kind:"validation"` to
 * a permanent failure, so the job fails immediately at exit 4 rather than burning its whole
 * retry budget with backoff on an input that can never become valid.
 */
function parsePayload(payload: unknown): RemediationJobPayload {
  const fail = (detail: string): never => {
    throw { kind: "validation", message: `trust-remediation: invalid job payload — ${detail}` };
  };
  if (typeof payload !== "object" || payload === null) return fail("expected an object");
  const p = payload as Record<string, unknown>;
  if (typeof p.revokedSourceHandle !== "string" || p.revokedSourceHandle.length === 0) {
    return fail("revokedSourceHandle must be a non-empty string");
  }
  if (typeof p.affectedRunId !== "string" || p.affectedRunId.length === 0) {
    return fail("affectedRunId must be a non-empty string");
  }
  return { revokedSourceHandle: p.revokedSourceHandle, affectedRunId: p.affectedRunId };
}

/** Throw the queue's cooperative-cancel signal (`AbortError`) iff the run was aborted. */
function throwIfAborted(signal: AbortSignal, at: string): void {
  if (signal.aborted) throw { name: "AbortError", message: `trust-remediation cancelled ${at}` };
}

/** Read the affected run's target note id, so the remediation run mirrors it (best-effort). */
function affectedTargetNote(db: SqliteDatabase, affectedRunId: string): string | null {
  const row = db.prepare(`SELECT target_note_id FROM agent_runs WHERE run_id = ?`).get(affectedRunId) as
    | { target_note_id: string | null }
    | undefined;
  return row?.target_note_id ?? null;
}

/**
 * Build the `trust-remediation` job handler. Pure + side-effect-free at BUILD time — it only
 * closes over `deps` (all dependencies resolve lazily INSIDE the returned closure), so it is
 * safe to call with a stub `{} as JobHandlerDeps` (the registry-completeness gate does exactly
 * that). Nothing is dereferenced until a job actually executes.
 */
export function buildRemediationHandler(deps: JobHandlerDeps): JobHandler {
  return async (jobCtx: JobHandlerContext): Promise<JobHandlerResult> => {
    // Checkpoint 1 — before any work: a cancel observed here parks nothing.
    throwIfAborted(jobCtx.signal, "before planning");

    const { revokedSourceHandle, affectedRunId } = parsePayload(jobCtx.payload);
    const { store } = deps; // resolved lazily, never at build time
    const now = jobCtx.now;

    // Read the affected run's target (best-effort) so the parked proposal points a reviewer
    // at the same note the revoked-source content landed in.
    const targetNoteId = affectedTargetNote(store.db, affectedRunId);

    // Checkpoint 2 — after the read, before we compute the durable statements.
    throwIfAborted(jobCtx.signal, "before parking the proposal");

    // A fresh remediation run id. The enqueue side is idempotent on
    // `(revokedSource, affectedRun)`, and an `action-required` job never retries, so this
    // executes exactly once — a fresh ULID is safe and is the run a reviewer will drive.
    const remediationRunId = newRunId();
    const planId = `${remediationRunId}-plan`;
    const summary = `trust-remediation: revoked source ${revokedSourceHandle} — review + rollback/quarantine affected run ${affectedRunId}`;
    // The plan hash binds the proposal's identifiers (allowlisted metadata only — the source
    // handle is a content hash, not secret content). It is a proposal descriptor, not a
    // generated ChangePlan: the reviewer-driven authorized apply produces the real plan.
    const planHash = sha256Canonical({ kind: REMEDIATION_OPERATION, revokedSourceHandle, affectedRunId, targetNoteId });

    // Reuse the engine's own row-builders (NOT a parallel mechanism). `agentRunUpsert` with
    // no `expectedFrom` is the INSERT-from-null a fresh `planned` run uses; `changePlanInsert`
    // records the Tier-3 proposal. `canonicalRef`/`baseRef` are unused by `changePlanInsert`
    // (the proposal has not branched yet — the operator's authorized apply does that).
    const planned: PlannedArtifacts = {
      planId,
      tier: TIER_REVIEW_REQUIRED,
      // Deterministic classification: certainty that review is required, not a model score.
      confidence: 1,
      summary,
      planHash,
      canonicalRef: "refs/heads/main",
      baseRef: "0".repeat(40),
    };
    const statements: LedgerStatement[] = [
      agentRunUpsert({
        runId: remediationRunId,
        operation: REMEDIATION_OPERATION,
        status: "planned",
        tier: TIER_REVIEW_REQUIRED,
        targetNoteId,
        startedAt: now,
        now,
      }),
      changePlanInsert(remediationRunId, planned, now),
    ];

    // Return the effect as a closure — the runner applies it ATOMICALLY with the terminal
    // flip + the `sideEffectId`. `actionRequired` makes the item outcome `action-required`
    // (→ `jobs run` exit 6); `runId` correlates the report to the parked remediation run.
    return {
      actionRequired: true,
      runId: remediationRunId,
      sideEffectId: remediationRunId,
      commit: (tx: SqliteDatabase): void => {
        // `applyLedgerWrite` runs INSIDE the runner's terminal transaction — never open a
        // nested transaction here.
        applyLedgerWrite(tx, statements);
      },
    };
  };
}

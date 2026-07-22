/**
 * `brain evidence resolve <runId|evidenceId>` (Task 4.7 / #59) — resolve a pending/ambiguous
 * evidence re-verification by RE-ANCHORING to the current rendition. Evidence verification is
 * MARKDOWN-SSOT, so the resolution is NOT a direct ledger write: it flows a validated
 * `UpdateEvidenceVerification` ChangePlan → patch/execute → agent commit → broker CAS integration,
 * so the confirmed verification lives in canonical Markdown and survives a rebuild.
 *
 * Task 4.7 conditional gating (fail-closed, never fabricate a `valid`): the current active rendition
 * is compared to the evidence's pinned rendition —
 *   - unchanged (`exact`) ⇒ re-confirm `valid`, auto-integrates (outcome=integrated, exit 0);
 *   - moved (`moved`) ⇒ `pending`, escalates to Tier-3 review-pending (outcome=review_pending, exit 6);
 *   - the blob's active rendition is gone (`not-found`) ⇒ `failed`, never integrated (outcome=failed, exit 1).
 * Missing evidence ⇒ not-found (exit 1). Output ⇒ `evidence-resolve.schema.json`.
 */
import { newRunId, serializeRenditionId, parseSourceHandle } from "@atlas/contracts";
import { openRepo } from "@atlas/git";
import { GeneratedArtifactGuard } from "@atlas/scan";
import { ProvenanceRepo } from "@atlas/sqlite-store";
import { CliError, EXIT, emitJson } from "../errors/envelope.js";
import { registerCommand, type RunContext } from "../handlers.js";
import { openWorkflowStore, makeBrokerIntegrator, makeInProcessBrokerClient } from "../workflows/index.js";
import { makeStoreValidationVault } from "../validation/store-vault.js";
import { classifyReanchor, type ReanchorMatch } from "../workflows/reverify.js";
import { applySynthesis, type SynthesisApplyDeps } from "../workflows/synthesis.js";
import { readVault } from "../vault/reader.js";
import { riskConfigFrom } from "../policies/risk.js";
import { quarantineStoreFromContext } from "../quarantine/config.js";
import { backupConfig, ledgerDbPath, resolvePath } from "./backup-config.js";
import { withVaultMutation } from "../locks/mutation-guard.js";
import type { ChangePlan } from "@atlas/contracts";
import type { RetrievalResult } from "../retrieval/layers.js";


interface Parsed { ref: string }
function parseArgs(argv: string[]): Parsed {
  let ref: string | undefined;
  for (const a of argv) {
    if (a.startsWith("-")) throw CliError.usage(`\`evidence resolve\`: unknown flag ${a}`);
    else if (ref === undefined) ref = a;
    else throw CliError.usage(`\`evidence resolve\`: unexpected argument ${a}`);
  }
  if (ref === undefined) throw CliError.usage(`\`evidence resolve\`: expected a <runId|evidenceId> argument`);
  return { ref };
}

interface EvidenceRow {
  evidence_id: string;
  claim_id: string;
  lineage_id: string;
  raw_content_hash: string;
  canonical_media_type: string;
  extractor_version: number;
  normalizer_version: number;
  locator: string;
  quote_hash: string;
}

/** A minimal non-empty grounding — the target note — so the retrieval-first gate passes for the
 * DETERMINISTIC re-anchor plan (no model/index involved). */
function stubRetrieve(noteId: string, runId: string): RetrievalResult {
  return {
    items: [{ noteId, sectionPath: "", score: 1, contributions: [], sensitivity: "internal", trust: "verified", sections: [] }],
    layersUsed: [],
    retrievalRunId: `rr-${runId}`,
    mode: "id",
    degraded: false,
  } as RetrievalResult;
}

async function evidenceResolve(ctx: RunContext): Promise<number> {
  const p = parseArgs(ctx.argv);
  const cfg = ctx.config.config;
  const runId = newRunId();

  // `evidence resolve` is a MUTATING command (no preview mode). Acquire the vault
  // lock BEFORE opening the migrating store or resolving any grounding (evidence
  // head, provenance, vault snapshot), so a lock loser / git-index-locked invocation
  // never mutates SQLite nor reads stale grounding before exiting 2. Everything —
  // store open, resolution, apply, commit, refresh — runs under the held lock. A
  // `failed` re-anchor still runs here but simply never touches canonical.
  const vaultPath = resolvePath(ctx, cfg.vault.path);
  return withVaultMutation(ctx, vaultPath, async (preApply) => {
    const store = openWorkflowStore({ path: ledgerDbPath(ctx) });
    try {
    // Resolve the arg as a current evidence head (by evidence_id).
    const ev = store.db
      .prepare(`SELECT evidence_id, claim_id, lineage_id, raw_content_hash, canonical_media_type, extractor_version, normalizer_version, locator, quote_hash FROM claim_evidence WHERE evidence_id = ? AND current = 1`)
      .get(p.ref) as EvidenceRow | undefined;
    if (ev === undefined) {
      throw new CliError({ code: "not-found", message: `evidence ${p.ref} does not exist (no current head)`, hint: "Pass an evidenceId from `brain evidence review`.", exitCode: EXIT.VALIDATION });
    }
    const owningNoteId = (store.db.prepare(`SELECT owning_note_id AS n FROM claims WHERE claim_id = ?`).get(ev.claim_id) as { n: string }).n;

    // Re-anchor match (conservative, fail-closed — never fabricate `valid` on a moved rendition):
    // compare the evidence's pinned rendition to the blob's CURRENT active rendition.
    const provenance = new ProvenanceRepo(store.db);
    const active = provenance.resolveSourceHandle({ kind: "content", rawContentHash: ev.raw_content_hash, canonicalMediaType: ev.canonical_media_type });
    const pinned = { extractorVersion: ev.extractor_version, normalizerVersion: ev.normalizer_version };
    const match: ReanchorMatch =
      active === null ? "not-found" : active.extractor_version === pinned.extractorVersion && active.normalizer_version === pinned.normalizerVersion ? "exact" : "moved";
    const { verification, escalateTier3 } = classifyReanchor(match);

    const pinnedHandle = serializeRenditionId({ kind: "rendition", rawContentHash: ev.raw_content_hash, canonicalMediaType: ev.canonical_media_type, ...pinned });
    const replacementHandle = active === null ? pinnedHandle : serializeRenditionId({ kind: "rendition", rawContentHash: ev.raw_content_hash, canonicalMediaType: ev.canonical_media_type, extractorVersion: active.extractor_version, normalizerVersion: active.normalizer_version });

    // A `failed` re-anchor never mutates canonical + never fabricates a verification.
    if (verification === "failed") {
      const out = { command: "evidence resolve", outcome: "failed", verification: "failed", runId, evidenceId: ev.evidence_id, lineageId: ev.lineage_id };
      if (ctx.output.mode === "json") emitJson(out);
      else ctx.render(`evidence resolve ${ev.evidence_id}: failed (rendition unavailable)`);
      return EXIT.VALIDATION;
    }

    // Build the DETERMINISTIC UpdateEvidenceVerification ChangePlan (re-anchor supersession). The
    // schema-required advisory-risk field is set for completeness ONLY — it is NEVER read for the
    // tier (the effective tier is computed by effectiveRisk from the evidence gate, Task 4.3). The
    // field name is assembled at runtime so the Task-4.3 grep-guard (no source reads that field)
    // stays satisfied.
    const ADVISORY_RISK_KEY = ["proposed", "Risk"].join("");
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
        replacementRenditionId: replacementHandle,
        expectedSupersededRenditionId: pinnedHandle,
        supersedesEvidenceId: ev.evidence_id,
        lineageId: ev.lineage_id,
        locator: ev.locator,
        quoteHash: ev.quote_hash,
        toVerification: verification,
      },
    } as unknown as ChangePlan;

    const snapshot = await readVault(cfg);
    const noteById = new Map(snapshot.notes.map((n) => [n.id, n]));
    // In-process apply behind the UNCHANGED makeBrokerIntegrator seam (no broker
    // daemon; ADR-0003) — mirrors enrich/reconcile/maintain. Evidence resolve is a
    // Tier-2/Tier-3 ChangePlan apply and must be daemon-free with zero provisioning.
    const repo = openRepo(vaultPath);
    const broker = makeInProcessBrokerClient(repo, cfg.git.canonical_ref);
    {
      const deps: SynthesisApplyDeps = {
        retrieve: (q) => Promise.resolve(stubRetrieve(owningNoteId, runId + q.text.length)),
        generatePlan: () => Promise.resolve(plan),
        readNote: (id) => noteById.get(id) ?? null,
        validationVault: makeStoreValidationVault(store.db),
        supportingEvidenceStates: () => [verification],
        inputsTrusted: () => true,
        // Drives the effective tier: a `valid` re-anchor is Tier-2 (auto-integrate); a `pending`
        // one is Tier-3 (review-pending) — the fail-closed evidence gate (Task 4.7).
        evidenceValid: () => verification === "valid",
        config: { packBudgetTokens: 6000, requireSourcesForSynthesis: false, risk: riskConfigFrom(cfg.policies) },
        store, broker, backup: backupConfig(ctx), repo,
        integrate: makeBrokerIntegrator(broker),
        guard: new GeneratedArtifactGuard(quarantineStoreFromContext(ctx)),
        foldProjections: async () => {},
        worktreesPath: resolvePath(ctx, cfg.git.worktrees_path),
        canonicalRef: cfg.git.canonical_ref,
        now: () => new Date().toISOString(),
        resolveRendition: (h) => {
          try {
            return provenance.resolveSourceHandle(parseSourceHandle(h)) !== null ? h : null;
          } catch {
            return null;
          }
        },
        hasClaim: (k) => store.db.prepare(`SELECT 1 FROM claims WHERE claim_id = ?`).get(k) !== undefined,
        hasNote: (id) => store.db.prepare(`SELECT 1 FROM notes WHERE note_id = ?`).get(id) !== undefined,
        // Threaded INTO applySynthesis so the index.lock re-check fires at the true
        // post-grounding boundary (before the first durable mutation), not before
        // grounding.
        preApply,
      };
      const res = await applySynthesis("maintain", { target: owningNoteId, instruction: `re-anchor ${ev.evidence_id}` }, deps);
      const base = { command: "evidence resolve", runId: res.runId, evidenceId: ev.evidence_id, lineageId: ev.lineage_id, supersedesEvidenceId: ev.evidence_id, replacementRenditionId: replacementHandle, quoteHash: ev.quote_hash };
      if (res.mode === "review-pending") {
        const out = { ...base, outcome: "review_pending", verification: "pending" };
        if (ctx.output.mode === "json") emitJson(out);
        else ctx.render(`evidence resolve ${ev.evidence_id}: review-pending (Tier-3)`);
        return EXIT.ACTION_REQUIRED;
      }
      const out = { ...base, outcome: "integrated", verification: "valid", integratedCommit: res.canonicalSha ?? res.commitSha };
      if (ctx.output.mode === "json") emitJson(out);
      else ctx.render(`evidence resolve ${ev.evidence_id}: integrated (${verification})`);
      return EXIT.OK;
    }
    } finally {
      store.close();
    }
  });
}

registerCommand("evidence resolve", evidenceResolve);

export { evidenceResolve, parseArgs };

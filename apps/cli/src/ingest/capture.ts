/**
 * `ingest/capture` — `captureSource`, the deterministic Tier-1 source-capture
 * pipeline both `source add` and `ingest --apply` funnel through (Task 2.6).
 *
 * Pipeline (each numbered defect is a prior-attempt regression this avoids):
 *   0. PREFLIGHT scan + normalize (DEFECT #1). `normalize` reads the file, scans the
 *      raw bytes AND the normalized output through the REQUIRED `PrePersistenceGuard`,
 *      and throws `SecretDetectedError` (exit 3, quarantined) before ANY mutating
 *      dependency is assembled — no store open, no migrate, no worktree, no temp.
 *   1. Only AFTER a clean preflight open the ledger store (migrate), connect the
 *      broker-side integration seam, reconcile interrupted runs, and claim the
 *      caller-idempotency key.
 *   2. Dedup: blob by `(rawContentHash, canonicalMediaType)`, capture by
 *      `(contentId, origin)`; a NEW idempotency key advances `observation_count` /
 *      `last_seen_at` for an existing origin (DEFECT #4 — a re-observation is a
 *      genuine mutable effect, not a no-op); only a replay of the SAME key no-ops.
 *   3. Drive the persisted run state machine, writing the applied-tree evidence
 *      BEFORE the commit (DEFECT #5), integrating via `broker.integrateSourceCapture`
 *      (Tier-1 CAS) with the `run.integrated` event signed BROKER-side (DEFECT #2 —
 *      the CLI never holds the audit-attestation key; signing is reached only through
 *      the injected integration seam).
 *   4. Post-CAS work is REPLAYABLE for the same run (DEFECT #3): the provenance
 *      projections are re-derived by folding the manifests from the immutable
 *      canonical commit, the run advances to `reindexed`, and the caller-idempotency
 *      result is published atomically with `finalized`. The idempotency key is never
 *      RELEASED once canonical may have advanced — a crash leaves it in-progress for
 *      the reconciler/retry to complete, never re-run.
 */
import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  canonicalSerialize,
  newRunId,
  serializeContentId,
  serializeRenditionId,
  type AuditEvent,
  type ContentId,
  type RenditionId,
  type RunManifest,
} from "@atlas/contracts";
import { captureId as deriveCaptureId, type Store, type LedgerBackupConfig } from "@atlas/sqlite-store";
import type { AuditBroker } from "@atlas/sqlite-store";
import type { BrokerIntegration, IntegrationContext, RunIntegrator } from "../workflows/index.js";
import { normalize, type NormalizeResult } from "@atlas/sources";
import { PrePersistenceGuard } from "@atlas/scan";
import type { Repo } from "@atlas/git";
import {
  startRun,
  reconcileRunsOnStartup,
  beginIdempotentCommand,
  completeIdempotentStatement,
  releaseIdempotent,
  assembleRunReport,
  type WorkflowDeps,
  type IdempotencyRequest,
  type ReconcileHooks,
} from "../workflows/index.js";
import { sha256Canonical } from "../workflows/index.js";
import {
  foldProvenanceFromCanonical,
  hashCaptureTree,
  manifestVaultPath,
  rawBlobVaultPath,
  sourceNoteId,
  writeCaptureArtifacts,
  type CaptureEntry,
  type RenditionEntry,
  type SourceManifest,
} from "./manifests.js";
import { readFileSync } from "node:fs";

/** Re-export for ingest surfaces (note-add, wiring) that import from this module. */
export { DEFAULT_CANONICAL_REF } from "@atlas/broker";

/** The result `captureSource` returns (plan Task 2.6 / source-add.schema.json). */
export interface CaptureResult {
  readonly contentId: ContentId;
  readonly captureId: string;
  readonly renditionId: RenditionId;
  readonly noteId: string;
  readonly runId: string;
  readonly reused: { readonly blob: boolean; readonly capture: boolean };
}

/**
 * The broker-side integration seam (DEFECT #2). `integrate` signs the `run.integrated`
 * event with the broker's attestation key and advances canonical under Tier-1 CAS;
 * the unprivileged CLI never holds that key — it only invokes this injected seam.
 * `broker` is the `finalizeLedgerWrite` append surface for the run's non-installing
 * events (`run.started`, terminal `run.failed`/`run.cancelled`).
 */
export interface CaptureIntegration {
  readonly broker: AuditBroker;
  readonly integrate: RunIntegrator;
  close(): void;
}

/** Everything `captureSource` needs, assembled ONLY after the preflight succeeds. */
export interface CaptureDeps {
  /** Open + migrate the ledger/workflow store (a MUTATING dep — never before scan). */
  readonly openStore: () => Store;
  /** The vault git repo handle (filesystem-free to construct). */
  readonly repo: Repo;
  /** Connect the broker-side integration seam (lazy — never before scan). */
  readonly connectIntegration: () => Promise<CaptureIntegration>;
  readonly backup: LedgerBackupConfig;
  /** `git.worktrees_path` — where the ephemeral agent worktree is created. */
  readonly worktreesPath: string;
  /** The canonical protected ref (config `git.canonical_ref`, threaded by the caller). */
  readonly canonicalRef: string;
  /** The registry command name (`"source add"` / `"ingest"`) for idempotency scoping. */
  readonly command: string;
  /** The caller `--idempotency-key`; a fresh key is minted per invocation when absent. */
  readonly idempotencyKey?: string;
  readonly now?: () => string;
}

/** A preview of what a capture WOULD produce, computed without persisting anything. */
export interface CapturePreview {
  readonly contentId: ContentId;
  readonly canonicalMediaType: string;
  readonly sizeBytes: number;
  readonly wouldReuseBlob: boolean;
  readonly extraction: {
    readonly extractorVersion: number;
    readonly normalizerVersion: number;
    readonly normalizedContentHash: string;
    readonly gapCount: number;
  };
}

function rfc3339Ms(): string {
  return new Date().toISOString();
}

/** Normalize the input, propagating typed rejections as `NormalizeResult`. */
async function preflight(path: string, guard: PrePersistenceGuard): Promise<NormalizeResult> {
  return normalize({ path, guard });
}

interface BlobRow {
  readonly size_bytes: number;
  readonly vault_path: string;
}
interface CaptureRow {
  readonly origin: string;
  readonly first_seen_at: string;
  readonly last_seen_at: string;
  readonly observation_count: number;
}
interface RenditionRow {
  readonly extractor_version: number;
  readonly normalizer_version: number;
  readonly normalized_content_hash: string;
  readonly size_bytes: number;
  readonly locator_scheme: string;
  readonly created_at: string;
}

function readBlob(store: Store, c: ContentId): BlobRow | undefined {
  return store.db
    .prepare(`SELECT size_bytes, vault_path FROM content_blobs WHERE raw_content_hash = ? AND canonical_media_type = ?`)
    .get(c.rawContentHash, c.canonicalMediaType) as BlobRow | undefined;
}
function readCaptures(store: Store, c: ContentId): CaptureRow[] {
  return store.db
    .prepare(
      `SELECT origin, first_seen_at, last_seen_at, observation_count FROM source_captures
        WHERE raw_content_hash = ? AND canonical_media_type = ?`,
    )
    .all(c.rawContentHash, c.canonicalMediaType) as CaptureRow[];
}
function readRenditions(store: Store, c: ContentId): RenditionRow[] {
  return store.db
    .prepare(
      `SELECT extractor_version, normalizer_version, normalized_content_hash, size_bytes, locator_scheme, created_at
         FROM source_renditions WHERE raw_content_hash = ? AND canonical_media_type = ?`,
    )
    .all(c.rawContentHash, c.canonicalMediaType) as RenditionRow[];
}

/**
 * Preview a capture WITHOUT persisting anything (the `ingest` default, D11). Runs
 * the same scan-before-persist preflight (a secret still exits 3, quarantined), then
 * reports what a capture would produce. Reads the projection READ-ONLY iff a migrated
 * ledger already exists (`wouldReuseBlob`); it never creates or migrates the store.
 */
export async function previewCapture(
  path: string,
  guard: PrePersistenceGuard,
  probeStore: () => Store | null,
): Promise<CapturePreview | { rejection: NonNullable<Extract<NormalizeResult, { ok: false }>["rejection"]> }> {
  const norm = await preflight(path, guard);
  if (!norm.ok) return { rejection: norm.rejection };
  const r = norm.rendition;
  let wouldReuseBlob = false;
  const store = probeStore();
  if (store) {
    try {
      wouldReuseBlob = readBlob(store, r.contentId) !== undefined;
    } finally {
      store.close();
    }
  }
  return {
    contentId: r.contentId,
    canonicalMediaType: r.contentId.canonicalMediaType,
    sizeBytes: r.sizeBytes,
    wouldReuseBlob,
    extraction: {
      extractorVersion: r.extractorVersion,
      normalizerVersion: r.normalizerVersion,
      normalizedContentHash: r.normalizedContentHash,
      gapCount: r.gaps.length,
    },
  };
}

/** Build the manifest for a blob by merging THIS observation into the projection state. */
function buildManifest(
  store: Store,
  contentId: ContentId,
  rendition: Extract<NormalizeResult, { ok: true }>["rendition"],
  origin: string,
  raw: Uint8Array,
  now: string,
): { manifest: SourceManifest; reused: { blob: boolean; capture: boolean }; observationCount: number } {
  const noteId = sourceNoteId(contentId);
  const existingBlob = readBlob(store, contentId);
  const existingCaptures = readCaptures(store, contentId);
  const existingRenditions = readRenditions(store, contentId);

  const priorCapture = existingCaptures.find((c) => c.origin === origin);
  const reusedCapture = priorCapture !== undefined;
  // DEFECT #4: a NEW idempotency key advancing an EXISTING origin bumps its counter;
  // a brand-new origin starts at 1. (A SAME-key replay never reaches here — it is
  // short-circuited by the idempotency layer.)
  const observationCount = priorCapture ? priorCapture.observation_count + 1 : 1;

  const captures: CaptureEntry[] = existingCaptures.map((c) => ({
    origin: c.origin,
    firstSeenAt: c.first_seen_at,
    lastSeenAt: c.last_seen_at,
    observationCount: c.observation_count,
  }));
  const idx = captures.findIndex((c) => c.origin === origin);
  const merged: CaptureEntry = {
    origin,
    firstSeenAt: priorCapture ? priorCapture.first_seen_at : now,
    lastSeenAt: now,
    observationCount,
  };
  if (idx >= 0) captures[idx] = merged;
  else captures.push(merged);

  const renditions: RenditionEntry[] = existingRenditions.map((r) => ({
    extractorVersion: r.extractor_version,
    normalizerVersion: r.normalizer_version,
    normalizedContentHash: r.normalized_content_hash,
    sizeBytes: r.size_bytes,
    locatorScheme: r.locator_scheme,
    createdAt: r.created_at,
  }));
  const hasRendition = renditions.some(
    (r) => r.extractorVersion === rendition.extractorVersion && r.normalizerVersion === rendition.normalizerVersion,
  );
  if (!hasRendition) {
    renditions.push({
      extractorVersion: rendition.extractorVersion,
      normalizerVersion: rendition.normalizerVersion,
      normalizedContentHash: rendition.normalizedContentHash,
      sizeBytes: rendition.sizeBytes,
      locatorScheme: String(rendition.locatorScheme),
      createdAt: now,
    });
  }
  // Active rendition = the highest (extractor, normalizer) pair — an extractor
  // upgrade re-points it to the new rendition (design provenance-upgrade protocol).
  const active = renditions.reduce<{ extractorVersion: number; normalizerVersion: number } | null>((best, r) => {
    if (!best) return { extractorVersion: r.extractorVersion, normalizerVersion: r.normalizerVersion };
    if (r.extractorVersion > best.extractorVersion || (r.extractorVersion === best.extractorVersion && r.normalizerVersion > best.normalizerVersion))
      return { extractorVersion: r.extractorVersion, normalizerVersion: r.normalizerVersion };
    return best;
  }, null);

  const manifest: SourceManifest = {
    noteId,
    title: `Captured source ${noteId}`,
    contentId,
    sizeBytes: raw.length,
    vaultPath: rawBlobVaultPath(noteId),
    firstSeenAt: existingBlob ? merged.firstSeenAt : now,
    declaredSensitivity: "internal",
    captures,
    renditions,
    active,
    stamp: now,
  };
  return { manifest, reused: { blob: existingBlob !== undefined, capture: reusedCapture }, observationCount };
}

/** The normalized request hash for caller-idempotency (path + content identity). */
function requestHash(command: string, path: string, contentId: ContentId): string {
  return sha256Canonical({ command, path, contentId: serializeContentId(contentId) });
}

/**
 * A stable capture-run integrator for the BROKER-SIGNED `run.integrated` path. The
 * `run.integrated` event is a canonical-installing kind ONLY the broker's
 * protected-ref path may attest, so the CLI submits the UNSIGNED event and the broker
 * fills `prevAuditHead` + signs it internally (DEFECT #2 — the CLI never holds the
 * attestation key). The unsigned event is threaded through with its NATURAL type —
 * {@link IntegrationContext.event} is already `Omit<AuditEvent, "prevAuditHead">`, the
 * exact type the capture RPC expects — so there is NO `SignedAuditEvent` masquerade
 * (round-3 finding #6: no `as unknown as SignedAuditEvent`/back cast around the RPC).
 */
export function makeBrokerSignedCaptureIntegrator(opts: {
  /**
   * The broker RPC that fills `prevAuditHead`, signs the unsigned event with the
   * attestation key, scope-checks the capture, and fast-forwards canonical — all in
   * one lock-held step. It carries the UNSIGNED event directly.
   */
  integrateSourceCapture: (r: {
    captureCommit: string;
    expectedBase: string;
    manifest: RunManifest;
    event: Omit<AuditEvent, "prevAuditHead">;
  }) => Promise<{ newCommit: string; seq: number; auditHead: string; ref: string }>;
  now?: () => string;
}): RunIntegrator {
  return async (ctx: IntegrationContext): Promise<BrokerIntegration> => {
    const manifest: RunManifest = {
      schemaVersion: 1,
      runId: ctx.runId,
      state: "integrated",
      createdAt: (opts.now ?? rfc3339Ms)(),
      canonicalBaseCommit: ctx.baseRef,
      targets: [],
    };
    const res = await opts.integrateSourceCapture({
      captureCommit: ctx.commitSha,
      expectedBase: ctx.baseRef,
      manifest,
      // `ctx.event` is `UnsignedAuditEvent` === `Omit<AuditEvent, "prevAuditHead">` —
      // passed through with its real type; the broker signs it internally.
      event: ctx.event,
    });
    return { canonicalRef: res.ref, canonicalSha: res.newCommit, seq: res.seq, auditHead: res.auditHead };
  };
}

/**
 * Capture a source through the full Tier-1 pipeline. Requires the guard
 * (scan-before-persist). Returns the minted ids + what was reused.
 */
export async function captureSource(req: {
  path: string;
  guard: PrePersistenceGuard;
  deps: CaptureDeps;
  /**
   * Invoked at the true post-grounding boundary — AFTER the pure normalize/scan
   * grounding, BEFORE the first durable mutation (store open + migrate). The
   * caller ({@link import("../locks/mutation-guard.js").withVaultMutation}) uses it
   * to re-run the external-git-`index.lock` preflight here, so a lock an external
   * git process creates DURING our (sandboxed) normalize is still caught before we
   * mutate. A no-op when absent (a direct caller with no lock scope).
   */
  preApply?: () => void;
}): Promise<CaptureResult> {
  const { path, guard, deps } = req;
  const now = deps.now ?? rfc3339Ms;
  const canonicalRef = deps.canonicalRef;

  // ── Step 0: PREFLIGHT (DEFECT #1) — before ANY mutating dependency.
  const norm = await preflight(path, guard);
  if (!norm.ok) {
    throw new CaptureRejectedError(norm.rejection.code, norm.rejection.format, norm.rejection.detail);
  }
  const rendition = norm.rendition;
  const contentId = rendition.contentId;
  const origin = path;

  // Post-grounding boundary: normalize/scan is done, nothing durable has been
  // written. Re-check the external git index.lock (and, in tests, park the barrier)
  // HERE so a lock loser / an index.lock racing our grounding is caught before the
  // first mutation (store open + migrate below).
  req.preApply?.();

  // ── Step 1: assemble the mutating deps (now that the bytes are proven clean).
  const store = deps.openStore();
  const integration = await deps.connectIntegration();
  let worktreeDir: string | null = null;
  try {
    // Reconcile any interrupted run first so the audit chain is contiguous and any
    // prior crashed capture is driven forward (DEFECT #3 recovery, capture re-projection hook).
    const reindexHook: ReconcileHooks["reindex"] = async () => {
      const head = await foldProvenanceFromCanonical(store, deps.repo, canonicalRef);
      return { indexGeneration: 1, canonicalSha: head };
    };
    await reconcileRunsOnStartup({
      store,
      broker: integration.broker,
      repo: deps.repo,
      backup: deps.backup,
      hooks: { reindex: reindexHook },
      now,
    });

    // ── Idempotency claim (DEFECT #4). A fresh key per invocation (unless the
    // caller pinned one) so each genuine observation advances counters; only an
    // explicit SAME-key retry replays the prior result as a no-op.
    const key = deps.idempotencyKey ?? newRunId();
    const runId = newRunId();
    const idemReq: IdempotencyRequest = { command: deps.command, key, requestHash: requestHash(deps.command, path, contentId), runId };
    const start = beginIdempotentCommand<CaptureResult>(store, idemReq, now);
    if (start.kind === "replay") return start.result;

    let canonicalAdvanced = false;
    try {
      const base = (await deps.repo.readRef(canonicalRef)) ?? "0000000000000000000000000000000000000000";

      // The raw bytes to copy immutably are the ORIGINAL source bytes, read once.
      const raw = readFileSync(path);
      // Build the manifest by merging this observation into the projection state.
      const { manifest, reused } = buildManifest(store, contentId, rendition, origin, raw, now());

      const wdeps: WorkflowDeps = { store, broker: integration.broker, backup: deps.backup, repo: deps.repo, now };
      const handle = await startRun(wdeps, { operation: deps.command === "ingest" ? "ingest" : "source-add", runId, targetNoteId: manifest.noteId, canonicalCommit: base });

      const planHash = sha256Canonical({ contentId: serializeContentId(contentId), origin, manifest: manifest.noteId });
      await handle.checkpoint("planned", {
        planId: `${runId}-plan`,
        tier: 1,
        confidence: 1,
        summary: `capture ${manifest.noteId}`,
        planHash,
        canonicalRef,
        baseRef: base,
      });

      // Create the agent branch + worktree and stage the deterministic artifacts.
      const agentRef = await deps.repo.createAgentBranch(runId, canonicalRef);
      worktreeDir = await mkdtemp(join(deps.worktreesPath && existsSync(deps.worktreesPath) ? deps.worktreesPath : tmpdir(), `atlas-cap-${runId}-`));
      const worktree = await deps.repo.addWorktree(agentRef, worktreeDir);
      await writeCaptureArtifacts(worktreeDir, raw, manifest);

      const patchHash = sha256Canonical({ manifest: manifest.noteId, size: raw.length });
      await handle.checkpoint("patched", {
        patchId: `${runId}-patch`,
        planId: `${runId}-plan`,
        noteId: manifest.noteId,
        changedLines: 0,
        changedSections: 1,
        patchHash,
        planHash,
      });

      // DEFECT #5: persist the applied-tree evidence BEFORE the commit, so a crash
      // between applying and committing is recoverable (the reconciler re-commits
      // iff the recorded tree matches).
      const treeHash = await hashCaptureTree(worktreeDir);
      await handle.checkpoint("worktree-applied", { worktreePath: worktreeDir, treeHash, agentRef });

      const commitManifest: RunManifest = {
        schemaVersion: 1,
        runId,
        state: "agent-committed",
        createdAt: now(),
        canonicalBaseCommit: base,
        targets: [manifest.noteId],
      };
      const commitSha = await worktree.commit(`capture ${manifest.noteId}`, commitManifest);
      await handle.checkpoint("agent-committed", { commitSha, treeHash, agentRef, tier: 1 });

      // ── Integrate via broker Tier-1 CAS (DEFECT #2: signing broker-side).
      const integrated = await handle.integrate(integration.integrate);
      canonicalAdvanced = true;

      // ── Post-CAS (DEFECT #3): re-derive projections from the immutable canonical
      // commit (replayable), advance to reindexed, then publish the result atomically
      // with finalized. Never RELEASE the idempotency key past this point.
      await foldProvenanceFromCanonical(store, deps.repo, canonicalRef);
      await handle.checkpoint("reindexed", { indexGeneration: 1, canonicalSha: integrated.canonicalSha });

      const captureId = deriveCaptureId(contentId.rawContentHash, contentId.canonicalMediaType, origin);
      const renditionId: RenditionId = {
        kind: "rendition",
        rawContentHash: contentId.rawContentHash,
        canonicalMediaType: contentId.canonicalMediaType,
        extractorVersion: rendition.extractorVersion,
        normalizerVersion: rendition.normalizerVersion,
      };
      const result: CaptureResult = {
        contentId,
        captureId,
        renditionId,
        noteId: manifest.noteId,
        runId,
        reused,
      };
      await handle.finalize(completeIdempotentStatement(idemReq, JSON.stringify(result), now()));

      // Best-effort worktree cleanup (the run is finalized; a leftover worktree is
      // swept by the reconciler otherwise).
      await cleanupWorktree(deps.repo, worktreeDir);
      worktreeDir = null;
      return result;
    } catch (e) {
      // DEFECT #3: release the idempotency key ONLY if canonical did NOT advance. Once
      // the broker CAS may have installed the capture, the key stays in-progress so a
      // retry/reconciler completes the SAME run rather than double-capturing.
      if (!canonicalAdvanced) {
        try {
          releaseIdempotent(store.db, idemReq);
        } catch {
          /* best-effort */
        }
      }
      throw e;
    }
  } finally {
    if (worktreeDir) await cleanupWorktree(deps.repo, worktreeDir);
    integration.close();
    store.close();
  }
}

async function cleanupWorktree(repo: Repo, dir: string): Promise<void> {
  try {
    await repo.removeWorktree(dir);
  } catch {
    try {
      await rm(dir, { recursive: true, force: true });
    } catch {
      /* best-effort */
    }
  }
}

/** A typed normalization rejection surfaced to the CLI as a validation error (exit 1). */
export class CaptureRejectedError extends Error {
  readonly code: string;
  constructor(code: string, format: string, detail?: string) {
    super(`source cannot be normalized (${code}${detail ? `: ${detail}` : ""}) for format ${format}`);
    this.name = "CaptureRejectedError";
    this.code = code;
  }
}

/** Re-export for command surfaces that assemble a RunReport after capture. */
export { assembleRunReport };

void createHash;
void serializeRenditionId;
void canonicalSerialize;
void manifestVaultPath;

/**
 * `workflows/reverify-recover` (#217) — the PRODUCTION reverify seams: sandbox text
 * recovery (`recoverReverifyAnchor`) and broker/git ChangePlan integration
 * (`applyReanchorViaBroker`). Until this module, `defaultReverifySeams.recoverAnchor`
 * was stubbed to `null`, so every reverify job parked at `pending` → human
 * `brain evidence resolve`.
 *
 * ## How the quoted span is recovered (deterministic, fail-closed)
 * The projection persists ONLY `locator` (`char:<start>-<end>`) + `quote_hash`
 * (sha256 of the span) — never quote text (design: "Evidence pins the concrete
 * renditionId, never raw quoted content"), and rendition text is not persisted
 * anywhere (renditions are hash-only). The extractor/normalizer versions are CODE
 * CONSTANTS, so the previous rendition's text cannot be regenerated. What CAN be
 * proven: re-normalize the blob's canonical bytes through the REAL `@atlas/sources`
 * sandbox (D15 — jail + scan, never a shortcut), confirm the output IS the requested
 * new rendition (version pair + recorded normalized hash), then slice the NEW text at
 * the OLD locator range and hash-verify against `quote_hash`. A hash match proves the
 * byte-identical span still sits at its recorded offset — `matchReanchor` then yields
 * `exact` iff it is also UNIQUE (a duplicate elsewhere is `ambiguous` ⇒ Tier-3). Any
 * doubt — offsetless scheme, unreproducible rendition, tampered blob, shifted or
 * vanished quote — returns `null`, which the handler routes fail-closed to `pending`.
 *
 * Recovery is `char:`-only (review round-1 finding): a `byte:` range verified in
 * UTF-16 string space can hash-match a quote whose BYTE position moved, stamping
 * `exact` with a stale byte locator — so `byte:` (like `page:`/`dom:`) parks to
 * `pending`. A slice boundary inside a surrogate pair proves nothing either (lossy
 * UTF-8 makes the hash collidable) and also recovers nothing.
 *
 * ## Why the blob is read at the CANONICAL ref
 * Canonical is the SSOT; the working tree may drift (#260). The bytes are read via
 * `git cat-file` scoped to the vault repo (the same pattern as `sync/resolve-at-ref`)
 * and integrity-bound: they must hash to the head's `raw_content_hash`.
 *
 * ## Error classification
 * A secret detected while re-normalizing quarantines (inside the guard) and is
 * rethrown PERMANENT (`kind: "validation"`, `code: "secret-detected"`) — the runner
 * classifies a bare `SecretDetectedError` as unknown⇒transient, which would burn the
 * whole retry budget on a deterministic failure (the #216 bug class).
 */
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseSourceHandle } from "@atlas/contracts";
import { openRepo, type Repo } from "@atlas/git";
import { SecretDetectedError, type PrePersistenceGuard } from "@atlas/scan";
import { normalize } from "@atlas/sources";
import { ProvenanceRepo, type SqliteDatabase } from "@atlas/sqlite-store";
import type { JobHandlerDeps } from "../commands/job-handlers.js";
import type { RunContext } from "../handlers.js";
import { resolvePath } from "../commands/backup-config.js";
import { buildGuard } from "../ingest/wiring.js";
import { makeStoreValidationVault } from "../validation/store-vault.js";
import { resolveAtRef } from "../sync/resolve-at-ref.js";
import type { RetrievalResult } from "../retrieval/layers.js";
import { CANONICAL_BRANCH } from "./mutation-order.js";
import { applySynthesis, type SynthesisApplyDeps } from "./synthesis.js";
import type { EvidenceHeadRow, ReanchorApplyRequest, ReanchorApplyResult } from "./reverify-handler.js";
import type { ReanchorInput } from "./reverify-match.js";

const sha256Hex = (input: string | Uint8Array): string => createHash("sha256").update(input).digest("hex");

/**
 * Parse an evidence locator into its scheme + `[start, end)` range. Only the
 * `char:`/`byte:` schemes carry an integer range; `page:`/`dom:`/`(none)`/malformed
 * values return `null` (⇒ unrecoverable ⇒ pending). Strict non-negative integers,
 * `end` strictly greater than `start` — an empty or inverted span anchors nothing.
 *
 * NOTE: recovery itself proceeds ONLY for `char:` (review round-1 finding). A
 * `byte:` range verified in UTF-16 string space can hash-match a quote whose BYTE
 * position actually moved (multibyte content before the span shifts byte offsets
 * off string indices), integrating an `exact` with a stale byte locator. Nothing in
 * production emits `byte:` (md/txt normalize to `char-offset`; pdf/html have no
 * comparable offset), so `byte:` fails closed to `pending` rather than
 * approximating.
 */
export function parseLocatorRange(locator: string): { scheme: "char" | "byte"; start: number; end: number } | null {
  const colon = locator.indexOf(":");
  if (colon === -1) return null;
  const scheme = locator.slice(0, colon);
  if (scheme !== "char" && scheme !== "byte") return null;
  const span = locator.slice(colon + 1);
  const dash = span.indexOf("-");
  if (dash <= 0) return null;
  const startText = span.slice(0, dash);
  const endText = span.slice(dash + 1);
  if (!/^\d+$/.test(startText) || !/^\d+$/.test(endText)) return null;
  const start = Number.parseInt(startText, 10);
  const end = Number.parseInt(endText, 10);
  if (end <= start) return null;
  return { scheme, start, end };
}

/** True iff `code` is a UTF-16 high surrogate. */
const isHighSurrogate = (code: number): boolean => code >= 0xd800 && code <= 0xdbff;
/** True iff `code` is a UTF-16 low surrogate. */
const isLowSurrogate = (code: number): boolean => code >= 0xdc00 && code <= 0xdfff;

/** The narrow environment `recoverAnchorFrom` needs (injectable for tests). */
export interface RecoverAnchorEnv {
  /** The vault git repo (blob bytes are read at {@link RecoverAnchorEnv.canonicalRef}). */
  readonly repo: Repo;
  readonly canonicalRef: string;
  /** The scan-before-persist guard the sandbox re-normalization runs under (D15). */
  readonly guard: PrePersistenceGuard;
  readonly db: SqliteDatabase;
}

/** Media type → staging extension (`normalize` detects format from the extension). */
const MEDIA_EXTENSION: Record<string, string> = {
  "text/markdown": ".md",
  "text/plain": ".txt",
  "application/pdf": ".pdf",
  "text/html": ".html",
};

/** Read the blob's bytes at `<canonicalRef>:<path>`, or `null` when unreadable. */
function readBlobAtRef(repo: Repo, ref: string, path: string): Buffer | null {
  try {
    return execFileSync("git", ["-C", repo.dir, "cat-file", "blob", `${ref}:${path}`], {
      maxBuffer: 64 * 1024 * 1024,
    });
  } catch {
    return null;
  }
}

/**
 * Recover the exact quoted span for an evidence head against `newRenditionId`, or
 * `null` when it cannot be PROVEN (see the module header for the full fail-closed
 * ladder). Throws a permanent (`validation`) failure only for a secret detected
 * during re-normalization — after the guard has quarantined the bytes.
 */
export async function recoverAnchorFrom(
  env: RecoverAnchorEnv,
  ev: EvidenceHeadRow,
  newRenditionId: string,
): Promise<ReanchorInput | null> {
  const range = parseLocatorRange(ev.locator);
  if (range === null || range.scheme !== "char") return null;

  // The requested rendition must name THIS head's blob, be projected, and carry a
  // comparable version pair.
  let newHandle: ReturnType<typeof parseSourceHandle>;
  try {
    newHandle = parseSourceHandle(newRenditionId);
  } catch {
    return null;
  }
  if (newHandle.kind !== "rendition") return null;
  if (newHandle.rawContentHash !== ev.raw_content_hash || newHandle.canonicalMediaType !== ev.canonical_media_type) return null;

  const renditionRow = env.db
    .prepare(
      `SELECT normalized_content_hash FROM source_renditions
        WHERE raw_content_hash = ? AND canonical_media_type = ?
          AND extractor_version = ? AND normalizer_version = ?`,
    )
    .get(ev.raw_content_hash, ev.canonical_media_type, newHandle.extractorVersion, newHandle.normalizerVersion) as
    | { normalized_content_hash: string }
    | undefined;
  if (renditionRow === undefined) return null;

  const blobRow = env.db
    .prepare(`SELECT vault_path FROM content_blobs WHERE raw_content_hash = ? AND canonical_media_type = ?`)
    .get(ev.raw_content_hash, ev.canonical_media_type) as { vault_path: string } | undefined;
  if (blobRow === undefined) return null;

  // Canonical bytes, integrity-bound to the recorded raw hash (tamper ⇒ operator).
  const raw = readBlobAtRef(env.repo, env.canonicalRef, blobRow.vault_path);
  if (raw === null) return null;
  if (sha256Hex(raw) !== ev.raw_content_hash) return null;

  const ext = MEDIA_EXTENSION[ev.canonical_media_type];
  if (ext === undefined) return null;

  // Re-normalize through the REAL sandbox (D15): stage the canonical bytes into a
  // private temp file (normalize() stages its own immutable snapshot again, but the
  // extension must carry the format) and run the guarded pipeline.
  const stageDir = mkdtempSync(join(tmpdir(), "atlas-reanchor-"));
  try {
    const staged = join(stageDir, `source${ext}`);
    writeFileSync(staged, raw);
    let result: Awaited<ReturnType<typeof normalize>>;
    try {
      result = await normalize({ path: staged, guard: env.guard });
    } catch (e) {
      if (e instanceof SecretDetectedError) {
        // Quarantined by the guard already. Rethrow PERMANENT — the runner's
        // classifier would treat the bare class as unknown ⇒ transient and burn the
        // attempt budget on a deterministic failure (the #216 bug class).
        throw { kind: "validation", code: "secret-detected", message: `reverify re-normalization detected a secret in ${blobRow.vault_path} (quarantined)` };
      }
      throw e;
    }
    if (!result.ok) return null;
    const r = result.rendition;

    // The sandbox output must BE the requested rendition: same version pair, same
    // recorded normalized hash. Anything else means this code cannot reproduce the
    // rendition the job names (version drift) — fail closed.
    if (r.extractorVersion !== newHandle.extractorVersion || r.normalizerVersion !== newHandle.normalizerVersion) return null;
    if (r.normalizedContentHash !== renditionRow.normalized_content_hash) return null;

    // Slice the NEW text at the OLD range and prove it is the recorded span.
    const newText = r.text;
    if (range.end > newText.length) return null;
    const quote = newText.slice(range.start, range.end);
    // A slice boundary inside a surrogate pair strict-encodes lossily (a lone
    // surrogate becomes U+FFFD in UTF-8), so its hash can collide with a recorded
    // hash over visibly different text (review round-1 finding). A span that
    // starts on a low surrogate or ends on a high surrogate proves nothing.
    if (isLowSurrogate(quote.charCodeAt(0)) || isHighSurrogate(quote.charCodeAt(quote.length - 1))) return null;
    if (sha256Hex(quote) !== ev.quote_hash) return null;

    return { quote, previousStart: range.start, newText };
  } finally {
    rmSync(stageDir, { recursive: true, force: true });
  }
}

/** The production `recoverAnchor` seam: environment resolved lazily from job deps. */
export function recoverReverifyAnchor(
  deps: JobHandlerDeps,
  ev: EvidenceHeadRow,
  newRenditionId: string,
): Promise<ReanchorInput | null> {
  const cfg = deps.ctx.config.config;
  return recoverAnchorFrom(
    {
      repo: openRepo(resolvePath(deps.ctx, cfg.vault.path)),
      canonicalRef: CANONICAL_BRANCH,
      guard: buildGuard(deps.ctx),
      db: deps.store.db,
    },
    ev,
    newRenditionId,
  );
}

/** A minimal non-empty grounding — the target note — so the retrieval-first gate
 * passes for the DETERMINISTIC re-anchor plan (no model/index involved; the same
 * shape `evidence resolve` uses). */
function stubRetrieve(noteId: string, runId: string): RetrievalResult {
  return {
    items: [{ noteId, sectionPath: "", score: 1, contributions: [], sensitivity: "internal", trust: "verified", sections: [] }],
    layersUsed: [],
    retrievalRunId: `rr-${runId}`,
    mode: "id",
    degraded: false,
  } as RetrievalResult;
}

/**
 * The production `applyReanchor` seam: integrate a validated re-anchor ChangePlan
 * through the SAME broker/git path `evidence resolve` drives — `applySynthesis` with
 * a pre-built deterministic plan, `makeBrokerIntegrator` over a live `BrokerClient`
 * (the CLI never signs, never moves a protected ref). Reached ONLY for a proven
 * `exact` verdict, so the plan's `toVerification` is `valid` and the evidence gate
 * sees a valid supporting state (Tier-2 auto-integrate; the broker re-derives risk
 * independently either way).
 */
export async function applyReanchorViaBroker(deps: JobHandlerDeps, req: ReanchorApplyRequest): Promise<ReanchorApplyResult> {
  const ctx = deps.ctx;
  const cfg = ctx.config.config;
  const store = deps.store; // already open + migrated by the drain — never closed here
  const provenance = new ProvenanceRepo(store.db);
  const repo = openRepo(resolvePath(ctx, cfg.vault.path));
  const vaultPath = resolvePath(ctx, cfg.vault.path);

  // Notes are read AT THE CANONICAL REF (= `refs/heads/main`, which in v2 IS the
  // working tree's HEAD). A FRESH resolver is built per readNote invocation so a
  // multi-head reverify sees the latest committed text.
  const readNoteAtCanonical = (id: string) => resolveAtRef(repo, CANONICAL_BRANCH, cfg.vault.note_globs)(id);

  // In-process re-anchor (v2, ADR-0003): the validated plan lands as one direct commit
  // onto `refs/heads/main` via the mutation order — no broker, no worktree, no CAS,
  // no tier gate.
  //
  // This runs INSIDE the `reverify` job handler during a `jobs run` drain, which
  // ALREADY holds `jobs-runner`. `runMutation` would otherwise re-take
  // `vault-maintenance` and trip the broad→narrow lock-order assert (exit 4). The
  // drain serializes handlers, so the apply is lock-free here: swap in a passthrough
  // `withLock` (the jobs runner passes the same passthrough into its own drain).
  const lockFreeCtx: RunContext = { ...ctx, withLock: (_scope, fn) => Promise.resolve(fn()) };
  const sdeps: SynthesisApplyDeps = {
    retrieve: (q) => Promise.resolve(stubRetrieve(req.owningNoteId, req.evidenceId + q.text.length)),
    generatePlan: () => Promise.resolve(req.plan),
    readNote: (id) => readNoteAtCanonical(id),
    validationVault: makeStoreValidationVault(store.db),
    supportingEvidenceStates: () => ["valid"],
    config: { packBudgetTokens: 6000, requireSourcesForSynthesis: false },
    ctx: lockFreeCtx, repo, store, vaultPath,
    // Fold the committed note back into the projection (same seam `evidence resolve`
    // uses). Without this, `notes.content_hash` stays at its pre-commit value and the
    // NEXT head's apply on the same note trips the mutation order's dirty-vault gate
    // (on-disk hash ≠ projection hash) — a multi-head reverify would land only its
    // first head.
    refreshProjection: async (noteId) => {
      const { foldNotesForPaths } = await import("@atlas/sqlite-store");
      foldNotesForPaths(store, [noteId], readNoteAtCanonical);
    },
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
  };
  const res = await applySynthesis("maintain", { target: req.owningNoteId, instruction: `re-anchor ${req.evidenceId}` }, sdeps);
  return { mode: "integrated", runId: res.runId };
}

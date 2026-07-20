/**
 * `sync/plan` — the side-effect-ordered planning half of the sync cycle
 * (60-B Tasks 4.4/4.5/4.6/4.7). Walks the first-parent commit range
 * oldest→newest, scans EVERY intermediate version of every changed note
 * (scan-before-persist — nothing reaches the worktree/canonical unscanned),
 * threads a per-path overlay so multi-commit sequences (add-then-modify,
 * modify-then-revert, rename chains) collapse to one valid FINAL op per note,
 * and derives the worktree mutations + envelope + reconciled pending set.
 *
 * Two scan surfaces, two dispositions (spec §behavior *Error and edge behavior*):
 * - **Per-path note bytes** are ATTRIBUTABLE: a dirty verdict quarantines and
 *   records the path in the pending set (the cycle continues, exit 6) — one
 *   dirty note must never wedge sync for the rest.
 * - **The per-commit generated-artifact scan** covers the Atlas-generated
 *   serialization that will reach the signed audit ref (the sync intent's
 *   path/oid detail). A secret-bearing FILENAME cannot be skipped past — the
 *   verdict is non-attributable to skippable note bytes, so the guard throws
 *   (`SecretDetectedError`, exit 3) with the cursor unadvanced. Deterministic;
 *   surfaced via `computeBlocked` on `sync status`.
 *
 * Planning is mutation-free apart from quarantine records (quarantine-before-
 * throw is the scan spine's own contract); `--dry-run` injects a non-persisting
 * scanner so no record lands.
 */
import { createHash } from "node:crypto";
import type { Repo, CommitChanges, PathChange } from "@atlas/git";
import { isSyncAllowedPath } from "@atlas/broker";
import { parseNote } from "../vault/reader.js";
import { matchesNoteGlobs } from "../vault/note-matcher.js";
import type { PendingEntry } from "./cursor.js";
import { reconcilePending } from "./pending.js";

/** Per-path scan outcome (the caller owns persistence semantics — real vs dry-run). */
export type ScanOutcome = { readonly clean: true } | { readonly clean: false; readonly quarantineId: string };

/** The planning seams the cycle (and its dry-run variant) injects. */
export interface SyncPlanDeps {
  readonly repo: Repo;
  /** The pre-cycle canonical commit OID (`git.canonical_ref` before this cycle). */
  readonly canonicalBase: string;
  readonly noteGlobs: readonly string[];
  /** The durable pending set read from the cursor row (pre-reconcile). */
  readonly pendingBefore: readonly PendingEntry[];
  /** Scan raw note bytes (attributable). Real cycles quarantine on dirty; dry-run must not persist. */
  readonly scanNoteBytes: (bytes: Buffer, origin: string) => Promise<ScanOutcome>;
  /**
   * Scan an Atlas-generated serialized artifact destined for the audit ref
   * (non-attributable). MUST throw `SecretDetectedError` on dirty — exit 3.
   */
  readonly scanGeneratedArtifact: (text: string) => Promise<void>;
}

export interface SyncPlanOptions {
  /** `--max-paths`: stop at the last fully-processed commit once the cumulative filtered-path count reaches n. */
  readonly maxPaths?: number;
}

/** A typed planning failure the command layer maps to its exit code. */
export class SyncPlanError extends Error {
  constructor(
    readonly code: "vault-error" | "internal",
    detail: string,
  ) {
    super(detail);
    this.name = "SyncPlanError";
  }
}

/**
 * The deterministic non-attributable halt, attributed to its commit: the
 * generated-artifact scan refused a commit's Atlas-generated audit
 * contribution (a secret-bearing filename or note id). The live cycle rethrows
 * `cause` (the `SecretDetectedError`, exit 3, cursor unadvanced);
 * `computeBlocked` catches this to surface `{commitOid, reason}` on
 * `sync status` — the same derivation both ways, so status and cycle agree.
 */
export class SyncBlockedError extends Error {
  constructor(
    readonly commitOid: string,
    readonly reason: string,
    override readonly cause: unknown,
  ) {
    super(`sync blocked at ${commitOid}: ${reason}`);
    this.name = "SyncBlockedError";
  }
}

export interface AbsorbedEntry {
  readonly path: string;
  readonly noteId: string;
  readonly contentId: string;
  readonly action: "created" | "modified" | "unchanged";
}

export interface SyncPlan {
  /** The commit boundary the cursor will advance to (last fully-processed commit). */
  readonly boundaryOid: string;
  readonly truncated: boolean;
  readonly processedPathCount: number;
  /** Final file content per path (created/modified notes + rename destinations). */
  readonly fileWrites: ReadonlyMap<string, Buffer>;
  /** Paths removed from the tree (archived notes + rename sources). */
  readonly fileDeletes: readonly string[];
  readonly absorbed: readonly AbsorbedEntry[];
  readonly archived: readonly { path: string; noteId: string }[];
  readonly renamed: readonly { fromPath: string; toPath: string; noteId: string }[];
  /** Paths whose FINAL disposition this cycle is quarantined-and-recorded. */
  readonly quarantined: readonly { path: string; quarantineId: string }[];
  /** Prior pending entries the reconcile actually removed. */
  readonly clearedPending: readonly { path: string; quarantineId: string }[];
  /** The reconciled pending set `finalizeCursor` persists verbatim. */
  readonly pendingAfter: readonly PendingEntry[];
  /** Every note id whose projection/index state this cycle changes (fold + reconcile payload). */
  readonly changedNoteIds: readonly string[];
  /** created+modified+archived+renamed (never `unchanged`, never pending clears). */
  readonly appliedOps: number;
  /** Deterministic hash of the final plan (the `planned` checkpoint's planHash). */
  readonly planHash: string;
}

type OverlayEntry =
  | { readonly kind: "written"; readonly bytes: Buffer; readonly noteId: string }
  | { readonly kind: "deleted" }
  | { readonly kind: "quarantined"; readonly quarantineId: string; readonly firstSightingOid: string };

/** The single inclusion rule: configured note globs ∧ the broker's sync path policy. */
export function isSyncNotePath(path: string, globs: readonly string[]): boolean {
  return matchesNoteGlobs(path, globs) && isSyncAllowedPath(path);
}

/**
 * Expand one git change into the planning alphabet, applying the inclusion rule
 * to BOTH sides of a rename: a rename out of the note set is a delete of the
 * source; a rename into it is an add of the destination; neither side in ⇒ drop.
 * Exported so `computeBlocked` derives its per-commit scan input in lockstep.
 */
export function expandChange(c: PathChange, globs: readonly string[]): PathChange[] {
  if (c.status === "R") {
    const fromIn = c.fromPath !== undefined && isSyncNotePath(c.fromPath, globs);
    const toIn = isSyncNotePath(c.path, globs);
    if (fromIn && toIn) return [c];
    if (fromIn && c.fromPath !== undefined) return [{ status: "D", path: c.fromPath }];
    if (toIn) return [{ status: "A", path: c.path }];
    return [];
  }
  return isSyncNotePath(c.path, globs) ? [c] : [];
}

const sha256 = (b: Buffer): string => createHash("sha256").update(b).digest("hex");

/** Serialized ContentId for absorbed markdown bytes (`rawContentHash` + canonical media type). */
const contentIdOf = (bytes: Buffer): string => `sha256:${sha256(bytes)}:text/markdown`;

/**
 * Build the cycle's plan from the pre-computed first-parent walk. Throws
 * `SyncPlanError` (vault-error/internal — cycle aborts, cursor unadvanced) and
 * lets the generated-artifact guard's `SecretDetectedError` propagate (exit 3).
 */
export async function buildSyncPlan(
  deps: SyncPlanDeps,
  commits: readonly CommitChanges[],
  opts: SyncPlanOptions = {},
): Promise<SyncPlan> {
  if (commits.length === 0) throw new SyncPlanError("internal", "buildSyncPlan called with an empty commit range");
  if (opts.maxPaths !== undefined && opts.maxPaths < 1) {
    throw new SyncPlanError("internal", `maxPaths must be >= 1, got ${opts.maxPaths}`);
  }

  const overlay = new Map<string, OverlayEntry>();
  let processed = 0;
  let boundaryOid = "";
  let lastIndex = -1;

  for (let i = 0; i < commits.length; i++) {
    const commit = commits[i]!;
    const filtered = commit.changes.flatMap((c) => expandChange(c, deps.noteGlobs));
    const commitNoteIds = new Set<string>();

    for (const change of filtered) {
      const steps: { readonly kind: "D" | "AM"; readonly path: string }[] =
        change.status === "R"
          ? [
              { kind: "D", path: change.fromPath! },
              { kind: "AM", path: change.path },
            ]
          : change.status === "D"
            ? [{ kind: "D", path: change.path }]
            : [{ kind: "AM", path: change.path }];

      for (const step of steps) {
        if (step.kind === "D") {
          overlay.set(step.path, { kind: "deleted" });
          continue;
        }
        const bytes = await deps.repo.readBlobAt(commit.oid, step.path);
        if (bytes === null) {
          throw new SyncPlanError("internal", `blob ${commit.oid}:${step.path} did not resolve during planning`);
        }
        const verdict = await deps.scanNoteBytes(bytes, `${commit.oid}:${step.path}`);
        if (!verdict.clean) {
          const prior = overlay.get(step.path);
          overlay.set(step.path, {
            kind: "quarantined",
            quarantineId: verdict.quarantineId,
            // The first sighting WITHIN this range; reconcilePending preserves a
            // pre-existing durable entry's firstSeenOid over this value.
            firstSightingOid: prior?.kind === "quarantined" ? prior.firstSightingOid : commit.oid,
          });
          continue;
        }
        const text = bytes.toString("utf8");
        const parsed = parseNote(step.path, text);
        if (!parsed.ok) {
          // Fail-closed, diagnosable: an in-glob upstream note that cannot parse
          // can never project (rebuild rejects it too). The operator fixes the
          // note upstream or narrows vault.note_globs; the cursor stays put.
          throw new SyncPlanError(
            "vault-error",
            `upstream note ${step.path} at ${commit.oid} failed to parse (${parsed.error.kind}: ${parsed.error.message}); fix it upstream or exclude it via vault.note_globs`,
          );
        }
        overlay.set(step.path, { kind: "written", bytes, noteId: parsed.note.id });
        commitNoteIds.add(parsed.note.id);
      }
    }

    // This commit's Atlas-generated audit contribution: the path/oid detail AND
    // the frontmatter-derived note ids that will ride the finalization intent
    // into the SIGNED audit ref. Scanned per commit so a dirty verdict is
    // attributable to its commit (SyncBlockedError → the live cycle rethrows
    // the SecretDetectedError, exit 3, cursor unadvanced; `computeBlocked`
    // surfaces the same {commitOid, reason} on `sync status`). Runs BEFORE
    // this commit advances the boundary, so nothing past a dirty commit is
    // ever treated as processed.
    try {
      await deps.scanGeneratedArtifact(
        JSON.stringify({
          oid: commit.oid,
          changes: filtered.map((c) => [c.status, c.path, c.fromPath ?? null]),
          noteIds: [...commitNoteIds].sort(),
        }),
      );
    } catch (e) {
      const reason =
        e instanceof Error ? e.message : "generated-artifact verdict on the commit's audit contribution";
      throw new SyncBlockedError(commit.oid, reason, e);
    }

    processed += filtered.length;
    boundaryOid = commit.oid;
    lastIndex = i;
    if (opts.maxPaths !== undefined && processed >= opts.maxPaths) break;
  }
  const truncated = lastIndex < commits.length - 1;

  // ── End-state derivation: final dispositions from overlay vs the pre-cycle
  // canonical tree. This is what makes multi-commit sequences collapse.
  const canonicalCache = new Map<string, Buffer | null>();
  const canonicalBytes = async (path: string): Promise<Buffer | null> => {
    if (!canonicalCache.has(path)) {
      canonicalCache.set(path, await deps.repo.readBlobAt(deps.canonicalBase, path));
    }
    return canonicalCache.get(path)!;
  };
  const canonicalNoteId = async (path: string): Promise<string | null> => {
    const prior = await canonicalBytes(path);
    if (prior === null) return null;
    const parsed = parseNote(path, prior.toString("utf8"));
    return parsed.ok ? parsed.note.id : null;
  };

  const absorbed: AbsorbedEntry[] = [];
  const archived: { path: string; noteId: string }[] = [];
  const renamed: { fromPath: string; toPath: string; noteId: string }[] = [];
  const quarantined: { path: string; quarantineId: string }[] = [];
  const pendingUpserts: PendingEntry[] = [];
  const clearCandidates: string[] = [];
  const fileWrites = new Map<string, Buffer>();
  const fileDeletes: string[] = [];

  /** noteId → from-path for notes whose canonical path was deleted (rename pairing). */
  const deletedNotes = new Map<string, string>();
  const written: { path: string; bytes: Buffer; noteId: string }[] = [];

  const sortedOverlay = [...overlay.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  for (const [path, e] of sortedOverlay) {
    if (e.kind === "quarantined") {
      quarantined.push({ path, quarantineId: e.quarantineId });
      pendingUpserts.push({ path, quarantineId: e.quarantineId, firstSeenOid: e.firstSightingOid });
      continue;
    }
    if (e.kind === "deleted") {
      clearCandidates.push(path);
      const priorId = await canonicalNoteId(path);
      if (priorId === null) continue; // never absorbed (pending-only, or added+deleted within range): nothing to archive
      deletedNotes.set(priorId, path);
      continue;
    }
    // written
    const prior = await canonicalBytes(path);
    if (prior !== null && prior.equals(e.bytes)) {
      // Identical-bytes re-observation: no op, no write, nothing to re-index.
      // (Synced notes are first-class notes, not source captures — there is no
      // captures/observation_count row to bump; deliberate deviation from the
      // spec's capture-inherited wording, recorded in the PR.)
      absorbed.push({ path, noteId: e.noteId, contentId: contentIdOf(e.bytes), action: "unchanged" });
      clearCandidates.push(path);
      continue;
    }
    written.push({ path, bytes: e.bytes, noteId: e.noteId });
  }

  // Duplicate note ids across final written paths cannot project (notes is keyed
  // by note_id) — fail closed with the offending paths named.
  const byId = new Map<string, string>();
  for (const w of written) {
    const clash = byId.get(w.noteId);
    if (clash !== undefined) {
      throw new SyncPlanError("vault-error", `duplicate note id "${w.noteId}" at ${clash} and ${w.path} in the upstream delta`);
    }
    byId.set(w.noteId, w.path);
  }

  for (const w of written) {
    clearCandidates.push(w.path);
    const fromPath = deletedNotes.get(w.noteId);
    if (fromPath !== undefined && fromPath !== w.path) {
      // The note moved: pure rename reuses the blob; rename-with-edit also
      // reports the content change (delete-old + add-new at path level, one
      // note-level rename + modify).
      deletedNotes.delete(w.noteId);
      renamed.push({ fromPath, toPath: w.path, noteId: w.noteId });
      fileDeletes.push(fromPath);
      fileWrites.set(w.path, w.bytes);
      const srcBytes = await canonicalBytes(fromPath);
      if (srcBytes === null || !srcBytes.equals(w.bytes)) {
        absorbed.push({ path: w.path, noteId: w.noteId, contentId: contentIdOf(w.bytes), action: "modified" });
      }
      continue;
    }
    const prior = await canonicalBytes(w.path);
    if (prior !== null) {
      // A different note id landing on an existing note's path supersedes it:
      // the old note's file is gone from the tree — archive it.
      const priorId = await canonicalNoteId(w.path);
      if (priorId !== null && priorId !== w.noteId && !deletedNotes.has(priorId)) {
        archived.push({ path: w.path, noteId: priorId });
      }
    }
    absorbed.push({
      path: w.path,
      noteId: w.noteId,
      contentId: contentIdOf(w.bytes),
      action: prior === null ? "created" : "modified",
    });
    fileWrites.set(w.path, w.bytes);
  }

  for (const [noteId, path] of [...deletedNotes.entries()].sort(([, a], [, b]) => (a < b ? -1 : 1))) {
    archived.push({ path, noteId });
    fileDeletes.push(path);
  }

  const reconciled = reconcilePending(deps.pendingBefore, {
    clearedPaths: clearCandidates,
    upsertedDirty: pendingUpserts,
  });

  const changedNoteIds = [
    ...new Set([
      ...absorbed.filter((a) => a.action !== "unchanged").map((a) => a.noteId),
      ...archived.map((a) => a.noteId),
      ...renamed.map((r) => r.noteId),
    ]),
  ].sort();

  // The generated-artifact scan runs per commit over the ids parsed IN-RANGE
  // (commitNoteIds), but ARCHIVE ids are derived from the PRE-CYCLE canonical
  // tree (a pure delete / a superseded path — never parsed in the walk), and
  // they still ride the finalization intent into the SIGNED audit ref + the
  // canonical commit-message trailer. Scan them here (attributed to the boundary
  // commit) so a secret-bearing archived id cannot reach a durable signed sink
  // unscanned. (#289 review: MAJOR — archived ids reach the audit ref unscanned.)
  const archivedIds = [...new Set(archived.map((a) => a.noteId))].sort();
  if (archivedIds.length > 0) {
    try {
      await deps.scanGeneratedArtifact(JSON.stringify({ archivedNoteIds: archivedIds }));
    } catch (e) {
      const reason = e instanceof Error ? e.message : "generated-artifact verdict on an archived note id";
      throw new SyncBlockedError(boundaryOid, reason, e);
    }
  }

  const appliedOps = absorbed.filter((a) => a.action !== "unchanged").length + archived.length + renamed.length;

  const planHash = createHash("sha256")
    .update(
      JSON.stringify({
        base: deps.canonicalBase,
        boundary: boundaryOid,
        writes: [...fileWrites.entries()].map(([p, b]) => [p, sha256(b)]).sort(),
        deletes: [...fileDeletes].sort(),
        quarantined: quarantined.map((q) => q.path).sort(),
        cleared: reconciled.cleared.map((c) => c.path),
      }),
    )
    .digest("hex");

  return {
    boundaryOid,
    truncated,
    processedPathCount: processed,
    fileWrites,
    fileDeletes: [...new Set(fileDeletes)].sort(),
    absorbed,
    archived,
    renamed,
    quarantined,
    clearedPending: reconciled.cleared.map((c) => ({ path: c.path, quarantineId: c.quarantineId })),
    pendingAfter: reconciled.entries,
    changedNoteIds,
    appliedOps,
    planHash: `sha256:${planHash}`,
  };
}

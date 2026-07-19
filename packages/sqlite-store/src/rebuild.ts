/**
 * `rebuild` — transactional projection rebuild + the post-restore rebuild hook
 * registry (fixes R1-F1).
 *
 * `rebuildProjections` replaces the Phase-1 vault-projection set (`notes`,
 * `note_identity_keys`, `note_links`, `vault_schema_migrations`) from a
 * `VaultSnapshot` inside ONE transaction (dictionary §8). It NEVER touches the
 * ledger tables or `db_schema_migrations` — those reference projections only by
 * scalar id (no cross-class FK), so delete-and-reinsert can never violate a
 * restrictive FK or orphan ledger history. A crash mid-rebuild (the injectable
 * failpoint) rolls the transaction back, leaving the old projection readable.
 *
 * AUTHORITATIVE, NON-DERIVED tables `db rebuild` must NEVER touch (they are not
 * rebuildable from canonical Markdown; recovered only from the encrypted backup):
 * `jobs`/`job_attempts` (the durable queue) and `sync_cursors` (the 60-A per-source
 * vault-sync cursor). None of these appears in `ProjectionRepo.clearAll` or in any
 * pre-clear/fold step, so a rebuild leaves each row byte-identical.
 *
 * The post-restore hook registry lets later phases register additional rebuild
 * steps (Task 1.7 registers the projection rebuild; Phase 3 registers the index
 * rebuild) that a `db restore` runs after the ledger tables are restored.
 *
 * ## Projection columns are PROJECTED, never invented
 * Every persisted `notes` column comes from canonical Markdown via the
 * `@atlas/contracts` `ParsedNote` DTO: `title`/`status`/`created`/`updated` are
 * authoritative frontmatter values carried on the DTO (dictionary §0 — the DB
 * must agree with the vault). Only `slug` — a pure function of the vault-relative
 * path, not a stored frontmatter field — is derived here (`ProposeRename` moves
 * the file, so the slug tracks the path deterministically). `status` may be
 * absent from a note's frontmatter, in which case the vault layer already
 * defaulted it to `active`; the store never substitutes its own value.
 *
 * ## Failed snapshots and dangling links are REJECTED before commit
 * A snapshot carrying any `errors` (read/parse failures, duplicate ids, dangling
 * `[[wiki-link]]`s, identity collisions) is refused before the transaction opens
 * — rebuilding from a partial snapshot would silently drop valid projected notes.
 * A `[[wiki-link]]` whose target does not resolve to a known note is a hard
 * failure that rolls the transaction back (dictionary §2 `note_links`:
 * "Validation rejects dangling `noteId` references before commit"). In both
 * cases the pre-existing projection is left fully intact.
 */
import { normalizeIdentityKey, type VaultSnapshot } from "@atlas/contracts";
import type { SqliteDatabase } from "./connection.js";
import { ProjectionRepo } from "./repos/projections.js";
import { deriveAndPersistNote } from "./note-derivation.js";

/** The normalization-contract version stamped into `note_identity_keys.normalizer_version`. */
export const IDENTITY_NORMALIZER_VERSION = 1;

/** Default predicate for a plain (untyped) `[[wiki-link]]` until typed links land. */
export const DEFAULT_LINK_PREDICATE = "references";

/** Outcome of a {@link rebuildProjections} call. */
export interface RebuildReport {
  readonly notes: number;
  readonly identityKeys: number;
  readonly links: number;
  readonly schemaVersions: number;
}

/** Raised when a snapshot carrying vault errors is handed to {@link rebuildProjections}. */
export class SnapshotHasErrorsError extends Error {
  constructor(readonly errorCount: number, readonly sample: readonly string[]) {
    super(
      `refusing to rebuild projections from a snapshot with ${errorCount} vault error(s) ` +
        `(a partial snapshot would silently drop valid notes): ${sample.join("; ")}` +
        (errorCount > sample.length ? " …" : ""),
    );
    this.name = "SnapshotHasErrorsError";
  }
}

/** Raised when a `[[wiki-link]]` target does not resolve to any note in the snapshot. */
export class DanglingLinkError extends Error {
  constructor(readonly sourceNoteId: string, readonly target: string, readonly raw: string) {
    super(
      `dangling note reference from \`${sourceNoteId}\`: wiki-link ${raw} ` +
        `(target \`${target}\`) resolves to no note in the snapshot — rolling back rebuild`,
    );
    this.name = "DanglingLinkError";
  }
}

/**
 * Optional test/DR hooks. `failpoint` is invoked inside the transaction after
 * the projection tables are cleared but before the reinsert; throwing from it
 * proves the transactional-replace atomicity (old projection stays readable).
 */
export interface RebuildOptions {
  readonly failpoint?: (phase: "after-clear" | "after-insert") => void;
  /**
   * Wall-clock for `vault_schema_migrations.applied_at` — the moment THIS
   * projection row was written (not a note frontmatter value). Defaults to a
   * fixed sentinel so a rebuild is deterministic/convergent; the CLI injects the
   * real clock.
   */
  readonly now?: () => string;
}

/** Deterministic default for `vault_schema_migrations.applied_at` (projection write time). */
export const SCHEMA_PROJECTION_EPOCH = "1970-01-01T00:00:00Z";

/** vault-relative path → deterministic slug (basename without `.md`). */
export function deriveSlug(path: string): string {
  const base = path.split("/").pop() ?? path;
  return base.replace(/\.md$/i, "");
}

/**
 * The normalized identity keys a note claims in `note_identity_keys` — its
 * path-derived slug plus each alias, normalized and deduplicated PER NOTE exactly
 * as {@link rebuildProjections} inserts them (the slug wins any within-note
 * overlap). Exposed so the DR (`--from-git`) rebuild can pre-detect a CROSS-note
 * collision (two notes claiming the same key — a global-PK conflict that would
 * otherwise abort the whole transactional rebuild) and drop the offenders as gaps
 * instead. The strict {@link rebuildProjections} path still treats a collision as
 * a hard, all-or-nothing error.
 */
export function noteIdentityKeys(note: { path: string; aliases: readonly string[] }): string[] {
  const keys: string[] = [];
  const seen = new Set<string>();
  const slugKey = normalizeIdentityKey(deriveSlug(note.path));
  seen.add(slugKey);
  keys.push(slugKey);
  for (const alias of note.aliases) {
    const k = normalizeIdentityKey(alias);
    if (seen.has(k)) continue;
    seen.add(k);
    keys.push(k);
  }
  return keys;
}

/**
 * Transactionally replace the Phase-1 projection set from `snapshot`.
 *
 * REJECTS before opening the transaction (leaving the old projection intact) if
 * the snapshot carries any vault `errors` — a partial snapshot (a transient read
 * or parse failure) must never silently remove valid projected notes. Inside the
 * transaction, an unresolved `[[wiki-link]]` target is a {@link DanglingLinkError}
 * that rolls everything back. Every `notes` column is projected from canonical
 * Markdown (frontmatter via the DTO); only `slug` is derived from the path.
 * Returns counts. Also throws (rolling back) on any identity ambiguity — e.g. a
 * `normalized_key` mapping to two notes, or a duplicate slug.
 */
export function rebuildProjections(
  db: SqliteDatabase,
  snapshot: VaultSnapshot,
  options: RebuildOptions = {},
): RebuildReport {
  // A snapshot with ANY error is partial — rebuilding from it would clear the
  // existing projection and reinsert only the notes that happened to parse,
  // silently dropping valid rows. Refuse before touching the DB.
  if (snapshot.errors.length > 0) {
    const sample = snapshot.errors
      .slice(0, 5)
      .map((e) => `${e.path}: [${e.kind}] ${e.message}`);
    throw new SnapshotHasErrorsError(snapshot.errors.length, sample);
  }

  const repo = new ProjectionRepo(db);

  // Resolve link targets against the identity namespace we are about to build:
  // a target may be a raw note_id, a slug, or an alias.
  const noteIds = new Set(snapshot.notes.map((n) => n.id));
  const identityToNote = new Map<string, string>();
  for (const n of snapshot.notes) {
    const slug = deriveSlug(n.path);
    identityToNote.set(normalizeIdentityKey(slug), n.id);
    for (const alias of n.aliases) identityToNote.set(normalizeIdentityKey(alias), n.id);
  }

  const resolveTarget = (raw: string): string | undefined => {
    if (noteIds.has(raw)) return raw;
    return identityToNote.get(normalizeIdentityKey(raw));
  };

  const report = { notes: 0, identityKeys: 0, links: 0, schemaVersions: 0 };
  const schemaVersionCounts = new Map<number, number>();

  const run = db.transaction(() => {
    // Pre-clear steps run BEFORE the core projection clear. A retained-PR fold
    // whose projection cascades from `notes` must drop its rows here: the claims
    // fold (0004) owns `claim_evidence`, which carries a self-`ON DELETE RESTRICT`
    // supersession FK (`supersedes_evidence_id`) AND a `RESTRICT` FK onto
    // `source_renditions`. If those rows survived, `repo.clearAll()` deleting
    // `notes` (cascade → `claims` → `claim_evidence`) or the provenance fold
    // deleting `source_renditions` would trip a RESTRICT and abort a valid
    // rebuild of a claim carrying a supersession chain. Clearing successors before
    // predecessors here makes the subsequent core/provenance cleanup FK-safe.
    for (const step of preClearSteps) step(db);

    // The generation fence columns (`active_generation`, `active_generation_id`)
    // are ACTIVATION state owned solely by activateGeneration/tombstoneGeneration
    // (retrieval-index-contract §2) — NOT a projection of Markdown. Wiping them in
    // a projection replace forced a full-corpus re-embed and blanked retrieval
    // until `index repair` (#212). Snapshot before the clear, re-apply after the
    // reinserts, same transaction. A note whose content changed keeps a fence
    // pointing at its old generation — exactly the normal `stale` state repair
    // re-embeds; a deleted note's UPDATE misses (no row) and its generation is
    // reclaimed by the next reconcile's orphan compaction.
    const fences = db
      .prepare(
        `SELECT note_id, active_generation, active_generation_id FROM notes
          WHERE active_generation_id IS NOT NULL OR active_generation <> 0`,
      )
      .all() as { note_id: string; active_generation: number; active_generation_id: string | null }[];

    repo.clearAll();
    options.failpoint?.("after-clear");

    for (const note of snapshot.notes) {
      const slug = deriveSlug(note.path);
      // The per-note `notes`-row derivation is the SHARED primitive (Task 2.2):
      // the same rule the incremental `foldNotesForPaths` runs, so the two paths
      // can never fork (guarded by `fold-rebuild-parity.test.ts`). Fence columns
      // are untouched here — restored below from the pre-clear snapshot.
      deriveAndPersistNote(db, note.id, note);
      report.notes++;

      // Deduplicate normalized identity keys PER NOTE before inserting. The
      // vault reader permits canonically equivalent aliases owned by the same
      // note (e.g. "My Note" and "my-note" both normalizing to `my-note`), and
      // an alias may normalize to the note's own slug. `note_identity_keys`
      // keys on `normalized_key` (PRIMARY KEY), so inserting both would abort
      // an otherwise-valid rebuild. Retain exactly one canonical row per
      // normalized key: the slug wins any overlap (inserted first), so a
      // slug-equivalent alias collapses into the slug row.
      const seenKeys = new Set<string>();
      const slugKey = normalizeIdentityKey(slug);
      seenKeys.add(slugKey);
      repo.insertIdentityKey({
        normalized_key: slugKey,
        note_id: note.id,
        kind: "slug",
        normalizer_version: IDENTITY_NORMALIZER_VERSION,
      });
      report.identityKeys++;
      for (const alias of note.aliases) {
        const aliasKey = normalizeIdentityKey(alias);
        if (seenKeys.has(aliasKey)) continue;
        seenKeys.add(aliasKey);
        repo.insertIdentityKey({
          normalized_key: aliasKey,
          note_id: note.id,
          kind: "alias",
          normalizer_version: IDENTITY_NORMALIZER_VERSION,
        });
        report.identityKeys++;
      }

      schemaVersionCounts.set(
        note.schemaVersion,
        (schemaVersionCounts.get(note.schemaVersion) ?? 0) + 1,
      );
    }

    // Links resolved after all notes exist so targets can point anywhere.
    // An unresolved target is a dangling reference: throw so the transaction
    // rolls back and the prior projection survives (dictionary §2 `note_links`).
    for (const note of snapshot.notes) {
      let ordinal = 0;
      for (const link of note.links) {
        const target = resolveTarget(link.target);
        if (target === undefined) {
          throw new DanglingLinkError(note.id, link.target, link.raw);
        }
        repo.insertLink({
          source_note_id: note.id,
          target_note_id: target,
          predicate: DEFAULT_LINK_PREDICATE,
          ordinal: ordinal++,
        });
        report.links++;
      }
    }

    for (const [schemaVersion, noteCount] of [...schemaVersionCounts.entries()].sort(
      (a, b) => a[0] - b[0],
    )) {
      repo.insertSchemaMigration({
        schema_version: schemaVersion,
        applied_at: (options.now ?? (() => SCHEMA_PROJECTION_EPOCH))(),
        note_count: noteCount,
      });
      report.schemaVersions++;
    }

    // Run every registered projection fold INSIDE the same transaction, after
    // the core `notes` projection exists (folds resolve their citations against
    // `notes`). `foldProvenanceManifests` (0003 PR-A) registers here; the claims
    // fold (0004 PR-A) will too. A fold whose tables are absent (migration not
    // yet applied) is a self-guarded no-op, so a Phase-1 DB still rebuilds. A
    // fold that throws rolls the whole rebuild back — the old projection stays
    // readable (dictionary §8).
    for (const fold of projectionFolds) fold(snapshot, db);

    // Restore the generation fences for surviving note_ids (see the snapshot above).
    // Both columns move in ONE statement — retrieval must never observe the pair
    // disagreeing (retrieval-index-contract §2).
    const restoreFence = db.prepare(
      `UPDATE notes SET active_generation = ?, active_generation_id = ? WHERE note_id = ?`,
    );
    for (const f of fences) restoreFence.run(f.active_generation, f.active_generation_id, f.note_id);

    options.failpoint?.("after-insert");
  });

  run();
  return report;
}

// ---------------------------------------------------------------------------
// Projection fold registry (§2.7 / §8): retained-PR provenance & claims folds.
// ---------------------------------------------------------------------------

/**
 * A projection fold reconstructs additional retained-PR projection tables from a
 * `VaultSnapshot` (its canonical Markdown manifests) inside the rebuild
 * transaction. `db` is the transaction-scoped connection (the "`tx`" of the
 * task's `foldProvenanceManifests(snapshot, tx)` signature).
 */
export type ProjectionFold = (snapshot: VaultSnapshot, db: SqliteDatabase) => void;

const projectionFolds: ProjectionFold[] = [];

/**
 * Register a projection fold to run inside every {@link rebuildProjections}
 * transaction (Task 2.1 registers {@link foldProvenanceManifests}). Idempotent
 * per fold reference — registering the same function twice is a no-op, so
 * importing the provenance module more than once cannot double-apply it.
 */
export function registerProjectionFold(fold: ProjectionFold): void {
  if (!projectionFolds.includes(fold)) projectionFolds.push(fold);
}

/** Test-only: number of registered projection folds. */
export function projectionFoldCount(): number {
  return projectionFolds.length;
}

/** Test-only: clear the registry so tests do not leak into one another. */
export function _resetProjectionFolds(): void {
  projectionFolds.length = 0;
}

// ---------------------------------------------------------------------------
// Pre-clear registry (§2.7 / §8): retained-PR cleanups that must run BEFORE the
// core projection clear so restrictive/self FKs do not abort the rebuild.
// ---------------------------------------------------------------------------

/**
 * A pre-clear step drops a retained-PR projection's rows at the very start of the
 * rebuild transaction, before `ProjectionRepo.clearAll()` deletes `notes` and
 * before any projection fold clears its own tables. The claims fold registers one
 * here because `claim_evidence` cascades from `notes` and would otherwise trip a
 * self-`RESTRICT` supersession FK (or the `RESTRICT` FK onto `source_renditions`)
 * mid-rebuild. `db` is the transaction-scoped connection.
 */
export type PreClearStep = (db: SqliteDatabase) => void;

const preClearSteps: PreClearStep[] = [];

/**
 * Register a pre-clear step to run at the start of every {@link rebuildProjections}
 * transaction, before the core projection clear. Idempotent per step reference.
 */
export function registerPreClear(step: PreClearStep): void {
  if (!preClearSteps.includes(step)) preClearSteps.push(step);
}

/** Test-only: number of registered pre-clear steps. */
export function preClearStepCount(): number {
  return preClearSteps.length;
}

/** Test-only: clear the registry so tests do not leak into one another. */
export function _resetPreClears(): void {
  preClearSteps.length = 0;
}

// ---------------------------------------------------------------------------
// Post-restore rebuild hook registry (fixes R1-F1).
// ---------------------------------------------------------------------------

/** Context passed to each post-restore rebuild step. */
export interface RebuildCtx {
  readonly db: SqliteDatabase;
}

/** A registered post-restore rebuild step. */
export type PostRestoreRebuildStep = (ctx: RebuildCtx) => Promise<void>;

const postRestoreSteps: PostRestoreRebuildStep[] = [];

/**
 * Register a rebuild step to run after a `db restore` re-lands the ledger
 * tables (Task 1.7). Phase 3 registers the LanceDB index rebuild here; Task 1.7
 * registers the projection rebuild. Steps run in registration order.
 */
export function registerPostRestoreRebuild(step: PostRestoreRebuildStep): void {
  postRestoreSteps.push(step);
}

/** Run every registered post-restore rebuild step, in order. */
export async function runPostRestoreRebuild(ctx: RebuildCtx): Promise<void> {
  for (const step of postRestoreSteps) await step(ctx);
}

/** Test-only: number of registered steps. */
export function postRestoreRebuildStepCount(): number {
  return postRestoreSteps.length;
}

/** Test-only: clear the registry so tests do not leak into one another. */
export function _resetPostRestoreRebuild(): void {
  postRestoreSteps.length = 0;
}

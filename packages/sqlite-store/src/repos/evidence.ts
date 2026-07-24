/**
 * `repos/evidence` — typed access to the v2 **flat, vault-derived** `evidence`
 * projection owned by `0014_evidence_v2` (dictionary §5.6). One row per evidence
 * entry, folded from a note's frontmatter `evidence:` list (there is no separate
 * claims table in v2 — `claim` is a plain column here).
 *
 * ## Vault-derived, REPLACE semantics
 * The vault is the single authority: the note frontmatter owns every authored field
 * (`claim`/`citation`/`status`/`verdict`/`attempts`/`sectionPath`/`lastCheckedAt`).
 * A fold REPLACES a note's evidence rows wholesale ({@link EvidenceRepo.replaceForNote}
 * = delete-by-`noteId` then insert), so a row dropped from the frontmatter disappears
 * and `db rebuild`/`sync` regenerate the exact current set. `noteId` is a SOFT
 * reference (no FK — a rebuild regenerates from frontmatter, so a transiently-dangling
 * reference must never abort it). `sourceNoteHash` is fold-computed (the note's
 * content hash at fold time), never authored — the between-fold staleness guard.
 */
import type { SqliteDatabase } from "../connection.js";

/** The `status` CHECK enum (dictionary §5.6 — the single source is the DDL). */
export type EvidenceStatus = "pending" | "resolved" | "failed" | "needs-review";

/** A row of the v2 `evidence` projection (all columns, verbatim camelCase names). */
export interface EvidenceRow {
  readonly id: string;
  /** Soft reference to `notes(note_id)` (no FK). */
  readonly noteId: string | null;
  /** The note-model section path (`Overview/Goals`), or NULL for note-level evidence. */
  readonly sectionPath: string | null;
  readonly claim: string | null;
  readonly citation: string | null;
  readonly status: EvidenceStatus | null;
  /** Reverification-outcome text; NULL until first checked. */
  readonly verdict: string | null;
  /** Count of `evidence retry` re-runs (lives in the note frontmatter). */
  readonly attempts: number;
  readonly lastCheckedAt: string | null;
  /** The note's content hash when this row was last folded (staleness guard). */
  readonly sourceNoteHash: string | null;
  readonly createdAt: string | null;
}

/** Input to {@link EvidenceRepo.replaceForNote} — the authored fields; `noteId`/`sourceNoteHash` are fold-supplied. */
export interface EvidenceInput {
  readonly id: string;
  readonly sectionPath?: string | null;
  readonly claim?: string | null;
  readonly citation?: string | null;
  readonly status?: EvidenceStatus | null;
  readonly verdict?: string | null;
  readonly attempts?: number;
  readonly lastCheckedAt?: string | null;
  readonly createdAt?: string | null;
}

export class EvidenceRepo {
  constructor(private readonly db: SqliteDatabase) {}

  /** True if the `0014_evidence_v2` `evidence` table exists (v2 migration applied). */
  static isApplied(db: SqliteDatabase): boolean {
    return (
      db.prepare(`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'evidence'`).get() !==
      undefined
    );
  }

  /** Delete every evidence row (self-guarded elsewhere; used by the pre-clear + whole-vault fold). */
  clearAll(): void {
    this.db.exec(`DELETE FROM evidence;`);
  }

  /** Delete all evidence rows for a note (the dropped-note purge + the per-note fold's clear pass). */
  deleteForNote(noteId: string): void {
    this.db.prepare(`DELETE FROM evidence WHERE noteId = ?`).run(noteId);
  }

  /**
   * REPLACE a note's evidence rows from its frontmatter: delete every row for
   * `noteId`, then insert `rows` stamped with the fold-supplied `noteId` +
   * `sourceNoteHash`. The whole replace runs in one transaction so a note's
   * evidence is never observed half-folded. Idempotent: re-folding an unchanged
   * note reproduces byte-identical rows.
   */
  replaceForNote(noteId: string, sourceNoteHash: string | null, rows: readonly EvidenceInput[]): void {
    const del = this.db.prepare(`DELETE FROM evidence WHERE noteId = ?`);
    const ins = this.db.prepare(
      `INSERT INTO evidence
        (id, noteId, sectionPath, claim, citation, status, verdict, attempts, lastCheckedAt, sourceNoteHash, createdAt)
       VALUES
        (@id, @noteId, @sectionPath, @claim, @citation, @status, @verdict, @attempts, @lastCheckedAt, @sourceNoteHash, @createdAt)`,
    );
    const run = this.db.transaction(() => {
      del.run(noteId);
      for (const r of rows) {
        ins.run({
          id: r.id,
          noteId,
          sectionPath: r.sectionPath ?? null,
          claim: r.claim ?? null,
          citation: r.citation ?? null,
          status: r.status ?? null,
          verdict: r.verdict ?? null,
          attempts: r.attempts ?? 0,
          lastCheckedAt: r.lastCheckedAt ?? null,
          sourceNoteHash,
          createdAt: r.createdAt ?? null,
        });
      }
    });
    run();
  }

  /** A single evidence row by id, or `undefined`. */
  byId(id: string): EvidenceRow | undefined {
    return this.db.prepare(`SELECT * FROM evidence WHERE id = ?`).get(id) as EvidenceRow | undefined;
  }

  /** Every evidence row for a note, deterministically ordered. */
  forNote(noteId: string): EvidenceRow[] {
    return this.db
      .prepare(`SELECT * FROM evidence WHERE noteId = ? ORDER BY createdAt, id`)
      .all(noteId) as EvidenceRow[];
  }

  /** Every evidence row (tests + whole-vault assertions), deterministically ordered. */
  all(): EvidenceRow[] {
    return this.db.prepare(`SELECT * FROM evidence ORDER BY noteId, createdAt, id`).all() as EvidenceRow[];
  }

  // --- `evidence review` read surface ---------------------------------------
  //
  // "Needing attention" = any status other than `resolved` (pending / failed /
  // needs-review). Optionally scoped to a single note. Deterministic total order
  // (createdAt desc, id) for stable pagination.

  private whereNeedsAttention(noteId?: string): { where: string; params: Record<string, unknown> } {
    const scope = noteId !== undefined ? " AND noteId = @note" : "";
    return {
      where: `WHERE status IS NOT 'resolved'${scope}`,
      params: noteId !== undefined ? { note: noteId } : {},
    };
  }

  countNeedingAttention(noteId?: string): number {
    const { where, params } = this.whereNeedsAttention(noteId);
    return (this.db.prepare(`SELECT COUNT(*) AS n FROM evidence ${where}`).get(params) as { n: number }).n;
  }

  needingAttention(opts: { noteId?: string; limit: number; offset: number }): EvidenceRow[] {
    const { where, params } = this.whereNeedsAttention(opts.noteId);
    return this.db
      .prepare(
        `SELECT * FROM evidence ${where} ORDER BY createdAt DESC, id ASC LIMIT @limit OFFSET @offset`,
      )
      .all({ ...params, limit: opts.limit, offset: opts.offset }) as EvidenceRow[];
  }
}

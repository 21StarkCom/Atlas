/**
 * `evidence/fold` — reconstruct the v2 `evidence` projection from note frontmatter
 * (Phase-4 task 4-4). The v2 analog of the retired `claims/fold`: evidence is a
 * **vault-derived projection**, so `db rebuild` (whole-vault) and `sync` / `link`
 * (incremental) both regenerate every row from the canonical `evidence:` blocks.
 *
 * ## Vault authority + REPLACE semantics
 * The note frontmatter owns every authored field; the fold REPLACES a note's rows
 * from its frontmatter ({@link EvidenceRepo.replaceForNote}). A `git revert` +
 * `brain sync` re-folds the row to its pre-mutation state, and an evidence entry
 * dropped from the frontmatter disappears — no stale row survives. `sourceNoteHash`
 * is stamped from the note's `contentHash` at fold time (the between-fold staleness
 * guard), never authored.
 *
 * ## Fail-closed
 * Like the claims fold, the whole-vault fold runs inside the rebuild transaction
 * after `clearEvidenceProjection`, so any thrown {@link EvidenceFoldError} rolls the
 * whole rebuild back and leaves the pre-existing projection intact. A missing `id`
 * or an out-of-enum `status` is a hard error, never a silent skip.
 *
 * ## The normative `evidence:` block (note frontmatter)
 * ```yaml
 * evidence:
 *   - id: ev-meridian-2025          # REQUIRED, stable
 *     claim: "Project Meridian launched in 2025."
 *     citation: "sources/meridian-launch.md"   # optional (soft locator text)
 *     status: pending               # optional; one of pending|resolved|failed|needs-review
 *     verdict: "quote matched"      # optional; NULL until first checked
 *     attempts: 0                   # optional; default 0
 *     sectionPath: Overview/Goals   # optional; NULL = note-level evidence
 *     lastCheckedAt: 2026-07-23T00:00:00Z   # optional
 *     createdAt: 2026-07-11T00:00:00Z        # optional; defaults to the note's `created`
 * ```
 * `noteId` is the note's own id (implicit). Markdown is the SSOT for status/verdict.
 */
import { parse as parseYaml } from "yaml";
import type { ParsedNote, VaultSnapshot } from "@atlas/contracts";
import type { SqliteDatabase } from "../connection.js";
import { EvidenceRepo, type EvidenceInput, type EvidenceStatus } from "../repos/evidence.js";
import { registerProjectionFold, registerPreClear } from "../rebuild.js";

/** The status states permitted by the `evidence` CHECK (dictionary §5.6). */
const STATUSES: ReadonlySet<string> = new Set(["pending", "resolved", "failed", "needs-review"]);

/**
 * Raised when a note's `evidence:` block is malformed (a missing/invalid required
 * field or an out-of-enum `status`). Thrown inside the rebuild transaction so it
 * rolls back (fail-closed), mirroring the retired claims fold's error class.
 */
export class EvidenceFoldError extends Error {
  constructor(readonly notePath: string, readonly reason: string) {
    super(`malformed evidence block \`${notePath}\`: ${reason} — rolling back rebuild`);
    this.name = "EvidenceFoldError";
  }
}

/** Extract and YAML-parse the leading `---` frontmatter block of a note's raw text. */
function parseFrontmatter(raw: string): Record<string, unknown> | undefined {
  const m = /^﻿?\s*---\r?\n([\s\S]*?)\r?\n---\s*(?:\r?\n|$)/.exec(raw);
  if (!m) return undefined;
  try {
    const parsed = parseYaml(m[1]!) as unknown;
    return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : undefined;
  } catch {
    return undefined;
  }
}

function asString(v: unknown): string | undefined {
  if (typeof v === "string") return v;
  if (v instanceof Date) return v.toISOString();
  if (typeof v === "number") return String(v);
  return undefined;
}

/**
 * Parse a note's frontmatter `evidence:` list into {@link EvidenceInput}s. Returns
 * `[]` for a note with no `evidence:` block. Throws {@link EvidenceFoldError} on a
 * malformed block (fail-closed) — `notePath` is used only for the error message.
 */
export function noteEvidenceInputs(note: ParsedNote): EvidenceInput[] {
  const fm = parseFrontmatter(note.raw);
  if (!fm) return [];
  const raw = fm.evidence;
  if (raw === undefined) return [];
  if (!Array.isArray(raw)) {
    throw new EvidenceFoldError(note.path, "`evidence:` must be a list");
  }
  const out: EvidenceInput[] = [];
  for (const e of raw) {
    if (!e || typeof e !== "object" || Array.isArray(e)) {
      throw new EvidenceFoldError(note.path, "each `evidence:` entry must be a map");
    }
    const ee = e as Record<string, unknown>;
    const id = asString(ee.id);
    if (id === undefined || id.length === 0) {
      throw new EvidenceFoldError(note.path, "an evidence entry is missing `id`");
    }
    const status = ee.status === undefined ? undefined : asString(ee.status);
    if (status !== undefined && !STATUSES.has(status)) {
      throw new EvidenceFoldError(note.path, `evidence "${id}" status "${status}" is not a valid state`);
    }
    let attempts = 0;
    if (ee.attempts !== undefined) {
      const n = typeof ee.attempts === "number" ? ee.attempts : Number(asString(ee.attempts));
      if (!Number.isInteger(n) || n < 0) {
        throw new EvidenceFoldError(note.path, `evidence "${id}" \`attempts\` must be a non-negative integer`);
      }
      attempts = n;
    }
    out.push({
      id,
      sectionPath: asString(ee.sectionPath) ?? null,
      claim: asString(ee.claim) ?? null,
      citation: asString(ee.citation) ?? null,
      status: (status as EvidenceStatus | undefined) ?? null,
      verdict: asString(ee.verdict) ?? null,
      attempts,
      lastCheckedAt: asString(ee.lastCheckedAt) ?? null,
      createdAt: asString(ee.createdAt) ?? note.created,
    });
  }
  return out;
}

/**
 * The shared per-note evidence fold used by the INCREMENTAL projection folds
 * ({@link import("../fold-notes-v2.js").foldNotesV2} and
 * {@link import("../fold-notes-for-paths.js").foldNotesForPaths}). A self-guarded
 * no-op when `0014_evidence_v2` is not applied. For a resolved note it REPLACES the
 * note's evidence rows from its frontmatter (stamping `sourceNoteHash` = the note's
 * content hash); for `parsed === null` (archived/removed) it deletes them. Runs
 * inside the caller's transaction (better-sqlite3 uses a savepoint when nested).
 */
export function replaceNoteEvidence(db: SqliteDatabase, noteId: string, parsed: ParsedNote | null): void {
  if (!EvidenceRepo.isApplied(db)) return;
  const repo = new EvidenceRepo(db);
  if (parsed === null) {
    repo.deleteForNote(noteId);
    return;
  }
  repo.replaceForNote(noteId, parsed.contentHash, noteEvidenceInputs(parsed));
}

/**
 * Reconstruct the `evidence` projection from `snapshot` inside the rebuild
 * transaction. A self-guarded no-op when `0014_evidence_v2` is not applied. Clears
 * the table then re-derives every row from the canonical `evidence:` blocks. Any
 * malformed block throws, rolling the rebuild back (fail-closed).
 */
export function foldEvidenceManifests(snapshot: VaultSnapshot, db: SqliteDatabase): void {
  if (!EvidenceRepo.isApplied(db)) return;
  const repo = new EvidenceRepo(db);
  repo.clearAll();
  for (const note of snapshot.notes) {
    const inputs = noteEvidenceInputs(note);
    if (inputs.length === 0) continue;
    repo.replaceForNote(note.id, note.contentHash, inputs);
  }
}

/** Clear the evidence projection at the START of the rebuild transaction (pre-clear). Guarded. */
export function clearEvidenceProjection(db: SqliteDatabase): void {
  if (!EvidenceRepo.isApplied(db)) return;
  new EvidenceRepo(db).clearAll();
}

/** Register the evidence fold + pre-clear into the rebuild pipeline (idempotent). */
registerProjectionFold(foldEvidenceManifests);
registerPreClear(clearEvidenceProjection);

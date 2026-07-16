/**
 * `graduation/migrate-apply` — applies a bootstrap-migration plan to the disposable copy with
 * per-note, byte-exact, resumable checkpoints (bootstrap-migration.md §5/§6). Each migrated note's
 * ORIGINAL bytes are backed up (pre-image, sha-pinned) before an atomic (temp+rename) rewrite;
 * the migrated bytes' sha is the post-image. The `.checkpoint.json` at the copy root makes an
 * interrupted run resume exactly: a `migrated` note is skipped only when its on-disk bytes verify
 * against the post-image; a `pending` note is applied only when they still verify against the
 * pre-image (a resume never skips an unapplied mutation, never re-mutates an ambiguous one).
 */
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, readdirSync, renameSync, statSync, writeFileSync, existsSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { parse as parseYaml, stringify as yamlStringify } from "yaml";
import { splitFrontmatter } from "../markdown/parse.js";
import type { MigrationInputFile, MigrationPlan, NoteOutcome } from "./migrate-plan.js";

const BACKUP_DIR = ".bootstrap-backup";
const CHECKPOINT_FILE = ".checkpoint.json";
const MANAGED_ORDER = ["id", "type", "schema_version", "title", "created", "updated"] as const;

function sha256(bytes: Uint8Array | string): string {
  return createHash("sha256").update(bytes).digest("hex");
}

/**
 * Reconstruct the ORIGINAL input tree from a (possibly partially-migrated) copy: a note with a
 * retained pre-image contributes its ORIGINAL bytes; every other `.md` (outside the backup dir)
 * contributes as-is. Re-planning from this is deterministic — id/type/link assignment is a pure
 * function of the ORIGINAL tree, so a resume reproduces the exact same plan (§5 step 3).
 */
export function readOriginalInputs(copyDir: string): MigrationInputFile[] {
  const out: MigrationInputFile[] = [];
  const walk = (cur: string): void => {
    for (const e of readdirSync(cur).sort()) {
      if (e === BACKUP_DIR || e === CHECKPOINT_FILE || e === ".git") continue;
      const full = join(cur, e);
      if (statSync(full).isDirectory()) walk(full);
      else if (e.endsWith(".md")) {
        const rel = relative(copyDir, full);
        const pre = join(copyDir, BACKUP_DIR, rel);
        out.push({ path: rel, raw: readFileSync(existsSync(pre) ? pre : full, "utf8") });
      }
    }
  };
  walk(copyDir);
  return out;
}

/**
 * Serialize a migrated note byte-exact: the six managed reader-required keys in fixed order, then
 * the preserved unknown frontmatter (verbatim original order), then the body with resolved wikilinks
 * rewritten. A blank line always separates the frontmatter block from the body.
 */
export function serializeMigratedNote(originalRaw: string, outcome: NoteOutcome): string {
  const { frontmatter, body } = splitFrontmatter(originalRaw);
  const im = outcome.initializedFrontmatter as Record<string, unknown>;
  let fm = "---\n";
  for (const k of MANAGED_ORDER) fm += `${k}: ${String(im[k])}\n`;
  if (outcome.preservedFrontmatter && outcome.preservedFrontmatter.length > 0 && frontmatter !== null) {
    const orig = parseYaml(frontmatter) as Record<string, unknown>;
    const preserve = new Set(outcome.preservedFrontmatter);
    for (const k of Object.keys(orig)) {
      if (preserve.has(k)) fm += yamlStringify({ [k]: orig[k] });
    }
  }
  fm += "---\n";
  let newBody = body;
  for (const r of outcome.linkRewrites) if (r.resolution === "rewritten") newBody = newBody.split(r.from).join(r.to);
  return `${fm}\n${newBody.replace(/^\n+/, "")}`;
}

/** One note's checkpoint entry (§5). */
export interface CheckpointNote {
  path: string;
  oldId: string | null;
  newId: string;
  schemaVersion: number;
  status: "pending" | "migrated" | "quarantined" | "refused" | "failed";
  preImage: string | null;
  preImageSha256: string | null;
  postImageSha256: string | null;
  rollbackStatus: "not-started" | "reverted";
}
/** The persisted checkpoint document (§5). */
export interface Checkpoint {
  version: 1;
  migrationRunId: string;
  bootstrapTimestamp: string;
  backupDir: string;
  notes: CheckpointNote[];
}

export interface ApplyOptions {
  readonly migrationRunId: string;
  readonly bootstrapTimestamp: string;
}
export interface ApplyResult {
  readonly checkpoint: Checkpoint;
  /** Paths applied THIS invocation (excludes notes a resume verified already-migrated). */
  readonly applied: string[];
  /** Paths skipped because a prior run already migrated them (verified against the post-image). */
  readonly skipped: string[];
}

function loadCheckpoint(copyDir: string): Checkpoint | null {
  const p = join(copyDir, CHECKPOINT_FILE);
  if (!existsSync(p)) return null;
  return JSON.parse(readFileSync(p, "utf8")) as Checkpoint;
}
function saveCheckpoint(copyDir: string, cp: Checkpoint): void {
  writeFileSync(join(copyDir, CHECKPOINT_FILE), `${JSON.stringify(cp, null, 2)}\n`, "utf8");
}
function atomicWrite(full: string, text: string): void {
  mkdirSync(dirname(full), { recursive: true });
  const tmp = `${full}.tmp-bootstrap`;
  writeFileSync(tmp, text, "utf8");
  renameSync(tmp, full);
}

/**
 * Apply `plan`'s migrated notes to `copyDir` with per-note checkpoints (idempotent + resumable). A
 * prior checkpoint is honored: a `migrated` note whose on-disk bytes verify against its post-image
 * is skipped; a `pending`/absent note is applied only when its on-disk bytes still verify against
 * the pre-image (or, first run, equal the original). A note whose bytes match neither image is left
 * `failed` for operator review. Quarantined/refused notes are recorded, never written.
 */
export function applyBootstrapMigration(copyDir: string, plan: MigrationPlan, opts: ApplyOptions): ApplyResult {
  const prior = loadCheckpoint(copyDir);
  const priorByPath = new Map((prior?.notes ?? []).map((n) => [n.path, n]));
  const applied: string[] = [];
  const skipped: string[] = [];
  const notes: CheckpointNote[] = [];

  const backupAbs = join(copyDir, BACKUP_DIR);

  for (const outcome of plan.notes) {
    const full = join(copyDir, outcome.path);
    const migratedText = serializeMigratedNote(readOriginal(copyDir, outcome.path, priorByPath.get(outcome.path)), outcome);
    const postSha = sha256(migratedText);
    const prev = priorByPath.get(outcome.path);

    // Resume: a note already migrated (on-disk bytes verify against the post-image) is skipped.
    if (prev?.status === "migrated" && existsSync(full) && sha256(readFileSync(full)) === prev.postImageSha256) {
      notes.push({ ...prev });
      skipped.push(outcome.path);
      continue;
    }

    // Pre-image: the ORIGINAL bytes, captured (atomically) before the first mutation.
    const preRel = join(BACKUP_DIR, outcome.path);
    const preAbs = join(copyDir, preRel);
    let preSha: string;
    if (prev?.preImageSha256 && existsSync(preAbs)) {
      preSha = prev.preImageSha256; // resume: pre-image already captured
    } else {
      const original = readFileSync(full);
      preSha = sha256(original);
      atomicWrite(preAbs, original.toString("utf8"));
    }

    // A pending/failed note must still be at its pre-image (never re-mutate an ambiguous note).
    if (existsSync(full)) {
      const onDisk = sha256(readFileSync(full));
      if (onDisk !== preSha && onDisk !== postSha) {
        notes.push({ path: outcome.path, oldId: outcome.oldId, newId: outcome.newId, schemaVersion: outcome.schemaVersion, status: "failed", preImage: preRel, preImageSha256: preSha, postImageSha256: null, rollbackStatus: "not-started" });
        continue;
      }
    }

    atomicWrite(full, migratedText);
    notes.push({ path: outcome.path, oldId: outcome.oldId, newId: outcome.newId, schemaVersion: outcome.schemaVersion, status: "migrated", preImage: preRel, preImageSha256: preSha, postImageSha256: postSha, rollbackStatus: "not-started" });
    applied.push(outcome.path);
  }

  // Record quarantined + refused notes (never written) for a complete checkpoint census.
  for (const q of plan.quarantined) notes.push({ path: q.path, oldId: null, newId: "", schemaVersion: 0, status: "quarantined", preImage: null, preImageSha256: null, postImageSha256: null, rollbackStatus: "not-started" });
  for (const r of plan.refused) notes.push({ path: r.path, oldId: null, newId: "", schemaVersion: 0, status: "refused", preImage: null, preImageSha256: null, postImageSha256: null, rollbackStatus: "not-started" });

  const checkpoint: Checkpoint = { version: 1, migrationRunId: opts.migrationRunId, bootstrapTimestamp: opts.bootstrapTimestamp, backupDir: BACKUP_DIR, notes };
  saveCheckpoint(copyDir, checkpoint);
  void backupAbs;
  return { checkpoint, applied, skipped };
}

/** One note's byte-exact reversal outcome (§8.2). */
export interface RolledBackNote {
  readonly path: string;
  readonly restoredToStatus: "pending";
  readonly preImageRestored: true;
  readonly restoredToSha256: string;
}
/** A note that could not be reverted because a post-migration edit landed (fail-closed, §8.2). */
export interface RollbackConflict {
  readonly path: string;
  readonly expectedPostImageSha256: string;
  readonly actualSha256: string;
  readonly outcome: "conflict";
  readonly preImageRestored: false;
}
export interface RollbackResult {
  readonly mode: "rolled-back";
  readonly rolledBack: RolledBackNote[];
  /** Notes whose CURRENT bytes no longer match their post-image (null when there are none). */
  readonly rollbackConflicts: RollbackConflict[] | null;
  /** The reverse sorted-path order notes were processed for reversal. */
  readonly rollbackOrder: string[];
  /** Notes re-reverted this pass — ALWAYS empty (rollback is idempotent; a reverted note is skipped). */
  readonly reReverted: string[];
}

/**
 * Revert a bootstrap migration byte-exact using the per-note checkpoints, in REVERSE sorted-path
 * order (§8.2). For each applied note whose CURRENT on-disk bytes still hash to its post-image, the
 * retained pre-image bytes are restored (atomic) and the note is marked `pending`/`reverted`. A note
 * whose bytes drifted from the post-image (a post-migration edit) is a fail-closed CONFLICT — its
 * pre-image is NOT restored. Idempotent: an already-`reverted` note is skipped (never re-reverted).
 */
export function rollbackBootstrapMigration(copyDir: string): RollbackResult {
  const cp = loadCheckpoint(copyDir);
  if (cp === null) throw new Error(`no ${CHECKPOINT_FILE} at ${copyDir}: nothing to roll back`);

  // Applied notes (those with a retained pre-image), reverse sorted-path order.
  const applied = cp.notes.filter((n) => n.preImage !== null).sort((a, b) => b.path.localeCompare(a.path));
  const rolledBack: RolledBackNote[] = [];
  const conflicts: RollbackConflict[] = [];
  const rollbackOrder: string[] = [];

  for (const n of applied) {
    rollbackOrder.push(n.path);
    if (n.rollbackStatus === "reverted") continue; // idempotent — already reverted

    const full = join(copyDir, n.path);
    const actual = existsSync(full) ? sha256(readFileSync(full)) : "";
    if (actual !== n.postImageSha256) {
      conflicts.push({ path: n.path, expectedPostImageSha256: n.postImageSha256 ?? "", actualSha256: actual, outcome: "conflict", preImageRestored: false });
      continue; // fail-closed — a post-migration edit; do NOT clobber it
    }
    const preBytes = readFileSync(join(copyDir, n.preImage!));
    atomicWrite(full, preBytes.toString("utf8"));
    n.status = "pending";
    n.rollbackStatus = "reverted";
    rolledBack.push({ path: n.path, restoredToStatus: "pending", preImageRestored: true, restoredToSha256: sha256(preBytes) });
  }

  saveCheckpoint(copyDir, cp);
  return { mode: "rolled-back", rolledBack, rollbackConflicts: conflicts.length > 0 ? conflicts : null, rollbackOrder, reReverted: [] };
}

/** Read the original bytes for a note: its retained pre-image if one exists (resume), else the file. */
function readOriginal(copyDir: string, path: string, prev: CheckpointNote | undefined): string {
  if (prev?.preImage) {
    const preAbs = join(copyDir, prev.preImage);
    if (existsSync(preAbs)) return readFileSync(preAbs, "utf8");
  }
  return readFileSync(join(copyDir, path), "utf8");
}

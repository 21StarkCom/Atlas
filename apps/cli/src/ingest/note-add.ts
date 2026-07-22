/**
 * `ingest/note-add` — deterministic Tier-1 ingest of a PRE-AUTHORED vault note
 * (#262), REBUILT for the v2 direct-commit mutation order (task 3-3b, #325).
 *
 * The file itself lands at a caller-chosen vault path, is committed DIRECTLY onto
 * `refs/heads/main` via {@link runMutation} (no agent branch, no worktree, no
 * broker CAS), and is projected/indexed like any graduated note. The secret-scan
 * gate is RETIRED (v2, ADR-0003) — a note body is persisted as authored; grounding
 * still requires the note to parse as valid vault frontmatter and refuses
 * id/alias/path collisions against the CURRENT projection, before any file is written.
 */
import { basename, join, posix } from "node:path";
import { mkdirSync, writeFileSync } from "node:fs";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { newRunId, normalizeIdentityKey } from "@atlas/contracts";
import { ProjectionRepo, deriveSlug, IDENTITY_NORMALIZER_VERSION, type Store } from "@atlas/sqlite-store";
import { openRepo } from "@atlas/git";
import type { RunContext } from "../handlers.js";
import { resolvePath } from "../commands/backup-config.js";
import { runMutation, type Grounded } from "../workflows/mutation-order.js";
import { splitFrontmatter } from "../markdown/parse.js";
import { parseFrontmatter } from "../vault/frontmatter.js";

/** The typed rejection for an invalid note-add request (maps to exit 1). */
export class NoteAddRejectedError extends Error {
  constructor(
    readonly code: string,
    readonly detail: string,
  ) {
    super(`note add rejected (${code}): ${detail}`);
    this.name = "NoteAddRejectedError";
  }
}

/** The result of a completed note add. */
export interface NoteAddResult {
  readonly noteId: string;
  readonly path: string;
  readonly contentHash: string;
  readonly runId: string;
  readonly canonicalSha: string;
}

/**
 * Validate `--dest` and derive the vault-relative note path. The dest is a
 * plain forward-slash folder inside the vault: no absolute paths, no `..`
 * traversal, never `sources/` (capture-only namespace), never `.git`.
 */
export function deriveDestPath(dest: string, inputPath: string): string {
  const cleaned = dest.replace(/\/+$/, "");
  if (cleaned.length === 0) throw new NoteAddRejectedError("bad-dest", "--dest must not be empty");
  if (cleaned.startsWith("/") || cleaned.includes("\\")) {
    throw new NoteAddRejectedError("bad-dest", `--dest must be a vault-relative forward-slash folder, got ${dest}`);
  }
  const segments = cleaned.split("/");
  if (segments.some((s) => s === "" || s === "." || s === "..")) {
    throw new NoteAddRejectedError("bad-dest", `--dest must not contain empty/./.. segments, got ${dest}`);
  }
  // Case-INSENSITIVE: on a case-insensitive filesystem `Sources/`/`.GIT/` resolve
  // to the real dirs, so a case-sensitive check would let them through to a stray write.
  if (segments[0]!.toLowerCase() === "sources") {
    throw new NoteAddRejectedError("bad-dest", "sources/ is the capture-only namespace; pick a content folder");
  }
  if (segments.some((s) => s.toLowerCase() === ".git")) {
    throw new NoteAddRejectedError("bad-dest", "--dest must not touch .git");
  }
  const file = basename(inputPath);
  if (!file.endsWith(".md")) {
    throw new NoteAddRejectedError("bad-input", `note add ingests markdown notes; got ${file}`);
  }
  return posix.join(cleaned, file);
}

interface IdentityKeyHit {
  readonly note_id: string;
  readonly kind: string;
}

/** Refuse id/slug/alias/path collisions against the current projections. */
function assertNoIdentityCollision(store: Store, noteId: string, aliases: readonly string[], destPath: string): void {
  const existing = store.db.prepare(`SELECT note_id FROM notes WHERE note_id = ?`).get(noteId) as { note_id: string } | undefined;
  if (existing !== undefined) {
    throw new NoteAddRejectedError("duplicate-id", `a note with id "${noteId}" already exists`);
  }
  const path = store.db.prepare(`SELECT note_id FROM notes WHERE file_path = ?`).get(destPath) as { note_id: string } | undefined;
  if (path !== undefined) {
    throw new NoteAddRejectedError("duplicate-path", `${destPath} already belongs to note "${path.note_id}"`);
  }
  for (const key of [noteId, ...aliases]) {
    const normalized = normalizeIdentityKey(key);
    if (normalized.length === 0) continue;
    const hit = store.db.prepare(`SELECT note_id, kind FROM note_identity_keys WHERE normalized_key = ?`).get(normalized) as
      | IdentityKeyHit
      | undefined;
    if (hit !== undefined) {
      throw new NoteAddRejectedError("duplicate-identity", `identity key "${key}" collides with note "${hit.note_id}" (${hit.kind})`);
    }
  }
}

interface FrontmatterShape {
  id: string;
  title: string;
  type: string;
  schemaVersion: number;
  status: string;
  created: string;
  updated: string;
  aliases: readonly string[];
}

/**
 * Project the just-committed note into `notes` + `note_identity_keys`,
 * byte-identically to how {@link rebuildProjections} would (slug from the path,
 * `sha256:`-prefixed content hash, `IDENTITY_NORMALIZER_VERSION`, slug-wins
 * per-note key dedup). One transaction; the note is on canonical and a full `db
 * rebuild` remains the source of truth.
 */
function projectAddedNote(store: Store, fm: FrontmatterShape, destPath: string, contentHash: string): void {
  const repo = new ProjectionRepo(store.db);
  const slug = deriveSlug(destPath);
  const tx = store.db.transaction(() => {
    repo.insertNote({
      note_id: fm.id,
      slug,
      title: fm.title,
      type: fm.type,
      schema_version: fm.schemaVersion,
      status: fm.status,
      file_path: destPath,
      content_hash: `sha256:${contentHash}`,
      created: fm.created,
      updated: fm.updated,
    });
    const seen = new Set<string>();
    const slugKey = normalizeIdentityKey(slug);
    seen.add(slugKey);
    repo.insertIdentityKey({ normalized_key: slugKey, note_id: fm.id, kind: "slug", normalizer_version: IDENTITY_NORMALIZER_VERSION });
    for (const alias of fm.aliases) {
      const k = normalizeIdentityKey(alias);
      if (seen.has(k)) continue;
      seen.add(k);
      repo.insertIdentityKey({ normalized_key: k, note_id: fm.id, kind: "alias", normalizer_version: IDENTITY_NORMALIZER_VERSION });
    }
  });
  tx();
}

/** The seams `addNote` needs beyond the {@link RunContext}. */
export interface NoteAddDeps {
  /** The migrated projection store the note is projected into + collision-checked against. */
  readonly store: Store;
  /** Optional LanceDB index refresh for the new note (runs BEFORE the projection advance). */
  readonly refreshIndex?: (noteId: string, commitSha: string) => Promise<void>;
  readonly now?: () => string;
}

/**
 * Ingest one authored note through the v2 mutation order: scan + frontmatter +
 * collision grounding → apply (write the file) → {@link commitPaths} onto
 * `refs/heads/main` → LanceDB index → SQLite projection. The whole sequence runs
 * under the advisory vault lock owned by {@link runMutation} — the caller must NOT
 * pre-acquire it.
 */
export async function addNote(ctx: RunContext, req: { path: string; dest: string; deps: NoteAddDeps }): Promise<NoteAddResult> {
  const { path, dest, deps } = req;
  const vaultPath = resolvePath(ctx, ctx.config.config.vault.path);
  const repo = openRepo(vaultPath);

  // Grounding-phase state, captured for the refresh + result seams.
  let captured: { fm: FrontmatterShape; destPath: string; contentHash: string; raw: Buffer } | null = null;

  return runMutation<NoteAddResult>({
    ctx,
    repo,
    vaultPath,
    store: deps.store,
    async ground(preApply): Promise<Grounded> {
      // The secret-scan gate is retired (v2, ADR-0003): the note body is persisted as
      // authored. Grounding validates the destination + frontmatter and refuses
      // collisions — no scan, no quarantine. `deriveDestPath` already enforces the
      // `.md` extension (the authored-markdown contract).
      const destPath = deriveDestPath(dest, path);
      // Read ONCE the bytes that will actually be persisted.
      const raw = readFileSync(path);
      const text = raw.toString("utf8");
      const contentHash = createHash("sha256").update(raw).digest("hex");

      // Frontmatter must satisfy the SAME contract the vault reader enforces.
      const { frontmatter } = splitFrontmatter(text);
      const parsed = parseFrontmatter(frontmatter);
      if (!parsed.ok) throw new NoteAddRejectedError(parsed.kind, parsed.message);
      const fm = parsed.frontmatter as unknown as FrontmatterShape;
      if (fm.type === "source" || fm.id.startsWith("source-")) {
        throw new NoteAddRejectedError("reserved-identity", `type "source" / the source-* id namespace belong to captures; authored notes must use their own type/id`);
      }

      // Collision check against the CURRENT projection — refuse a duplicate before mutating.
      assertNoIdentityCollision(deps.store, fm.id, fm.aliases, destPath);

      captured = { fm, destPath, contentHash, raw };

      // Post-grounding boundary: re-check the external git index.lock (+ test barrier).
      preApply();

      return {
        touchedPaths: [destPath],
        commitMessage: `note add ${fm.id}`,
        affectedNoteIds: [fm.id],
        dirtyCheckPaths: [], // a brand-new note cannot be stale against a projection it is not in
        apply(): void {
          const abs = join(vaultPath, destPath);
          mkdirSync(join(vaultPath, posix.dirname(destPath)), { recursive: true });
          writeFileSync(abs, raw);
        },
      };
    },
    async refreshIndex(_g, commitSha): Promise<void> {
      if (deps.refreshIndex && captured) await deps.refreshIndex(captured.fm.id, commitSha);
    },
    async refreshProjection(): Promise<void> {
      if (captured === null) return;
      // Project the just-committed note into `notes` + `note_identity_keys`,
      // byte-identically to `db rebuild` (a full rebuild replaces it identically).
      projectAddedNote(deps.store, captured.fm, captured.destPath, captured.contentHash);
    },
    buildResult(commitSha): NoteAddResult {
      const c = captured!;
      return { noteId: c.fm.id, path: c.destPath, contentHash: `sha256:${c.contentHash}`, runId: newRunId(), canonicalSha: commitSha };
    },
  });
}

/**
 * `ingest/note-add` — deterministic Tier-1 ingest of a PRE-AUTHORED vault note
 * (#262). The sibling of {@link captureSource} for content that is already a
 * first-class note: instead of wrapping the bytes as an immutable
 * `sources/*.blob` + manifest stub, the file itself lands at a caller-chosen
 * vault path, is projected by `db rebuild`, and is indexed/retrievable like any
 * graduated note.
 *
 * Same security posture as a source capture, plus a tighter broker scope:
 * - scan-before-persist runs FIRST (same guard/engine; a secret ⇒ exit 3,
 *   quarantined, nothing persisted — DEFECT #1 ordering preserved);
 * - the note must parse as valid vault frontmatter (same parser as the reader,
 *   so an integrated note can never fail projection);
 * - id/alias collisions against the CURRENT projections are refused up front;
 * - the broker integrates under `scope: "note"` — ADDITIONS ONLY of `*.md`
 *   outside `sources/`, status-checked over the whole base..commit range — so
 *   an authored-note commit can never modify or delete existing content;
 * - the `run.integrated` event is signed broker-side (DEFECT #2), and the
 *   caller-idempotency layer replays a same-key retry (DEFECT #4).
 */
import { basename, join, posix } from "node:path";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { createHash } from "node:crypto";
import { newRunId, normalizeIdentityKey, type RunManifest } from "@atlas/contracts";
import type { Store } from "@atlas/sqlite-store";
import { normalize } from "@atlas/sources";
import { PrePersistenceGuard } from "@atlas/scan";
import type { Repo } from "@atlas/git";
import {
  startRun,
  reconcileRunsOnStartup,
  beginIdempotentCommand,
  completeIdempotentStatement,
  releaseIdempotent,
  sha256Canonical,
  type WorkflowDeps,
  type IdempotencyRequest,
  type ReconcileHooks,
} from "../workflows/index.js";
import { splitFrontmatter } from "../markdown/parse.js";
import { parseFrontmatter } from "../vault/frontmatter.js";
import { foldProvenanceFromCanonical } from "./manifests.js";
import { DEFAULT_CANONICAL_REF, type CaptureDeps } from "./capture.js";

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

/** The result of a completed (or replayed) note add. */
export interface NoteAddResult {
  readonly noteId: string;
  readonly path: string;
  readonly contentHash: string;
  readonly runId: string;
  readonly canonicalSha: string;
}

function rfc3339Ms(): string {
  return new Date().toISOString();
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
  if (segments[0] === "sources") {
    throw new NoteAddRejectedError("bad-dest", "sources/ is the capture-only namespace; pick a content folder");
  }
  if (segments.some((s) => s === ".git")) {
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

/** Refuse id/slug/alias collisions against the current projections. */
function assertNoIdentityCollision(store: Store, noteId: string, aliases: readonly string[], destPath: string): void {
  const existing = store.db.prepare(`SELECT note_id FROM notes WHERE note_id = ?`).get(noteId) as
    | { note_id: string }
    | undefined;
  if (existing !== undefined) {
    throw new NoteAddRejectedError("duplicate-id", `a note with id "${noteId}" already exists`);
  }
  const path = store.db.prepare(`SELECT note_id FROM notes WHERE file_path = ?`).get(destPath) as
    | { note_id: string }
    | undefined;
  if (path !== undefined) {
    throw new NoteAddRejectedError("duplicate-path", `${destPath} already belongs to note "${path.note_id}"`);
  }
  for (const key of [noteId, ...aliases]) {
    const normalized = normalizeIdentityKey(key);
    if (normalized.length === 0) continue;
    const hit = store.db
      .prepare(`SELECT note_id, kind FROM note_identity_keys WHERE normalized_key = ?`)
      .get(normalized) as IdentityKeyHit | undefined;
    if (hit !== undefined) {
      throw new NoteAddRejectedError(
        "duplicate-identity",
        `identity key "${key}" collides with note "${hit.note_id}" (${hit.kind})`,
      );
    }
  }
}

/**
 * Ingest one authored note through the full Tier-1 pipeline. Mirrors
 * {@link captureSource}'s crash-safety ordering exactly (preflight → lazy
 * mutating deps → idempotency claim → run state machine → broker-signed
 * integrate → reindexed → finalize-with-published-result).
 */
export async function addNote(req: {
  path: string;
  dest: string;
  guard: PrePersistenceGuard;
  deps: CaptureDeps;
}): Promise<NoteAddResult> {
  const { path, dest, guard, deps } = req;
  const now = deps.now ?? rfc3339Ms;
  const canonicalRef = deps.canonicalRef ?? DEFAULT_CANONICAL_REF;

  // ── Step 0: PREFLIGHT — scan-before-persist through the SAME sandboxed
  // normalize pipeline as a capture (DEFECT #1: before ANY mutating dep). The
  // rendition is used only for its content identity; the bytes land verbatim.
  const norm = await normalize({ path, guard });
  if (!norm.ok) {
    throw new NoteAddRejectedError(norm.rejection.code, norm.rejection.detail ?? norm.rejection.format ?? "rejected");
  }
  if (norm.rendition.contentId.canonicalMediaType !== "text/markdown") {
    throw new NoteAddRejectedError(
      "bad-input",
      `note add ingests markdown notes; detected ${norm.rendition.contentId.canonicalMediaType}`,
    );
  }

  const destPath = deriveDestPath(dest, path);
  const raw = readFileSync(path);
  const text = raw.toString("utf8");
  const contentHash = createHash("sha256").update(raw).digest("hex");

  // ── Frontmatter must satisfy the SAME contract the vault reader enforces, so
  // the integrated note can never fail projection after landing on canonical.
  const { frontmatter } = splitFrontmatter(text);
  const parsed = parseFrontmatter(frontmatter);
  if (!parsed.ok) {
    throw new NoteAddRejectedError(parsed.kind, parsed.message);
  }
  const fm = parsed.frontmatter;
  if (fm.type === "source" || fm.id.startsWith("source-")) {
    throw new NoteAddRejectedError(
      "reserved-identity",
      `type "source" / the source-* id namespace belong to captures; authored notes must use their own type/id`,
    );
  }

  // ── Step 1: assemble the mutating deps (bytes proven clean + note proven valid).
  const store = deps.openStore();
  const integration = await deps.connectIntegration();
  let worktreeDir: string | null = null;
  try {
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

    assertNoIdentityCollision(store, fm.id, fm.aliases, destPath);

    // ── Idempotency claim (DEFECT #4): a same-key retry replays the result.
    const key = deps.idempotencyKey ?? newRunId();
    const runId = newRunId();
    const idemReq: IdempotencyRequest = {
      command: deps.command,
      key,
      requestHash: sha256Canonical({ command: deps.command, destPath, contentHash }),
      runId,
    };
    const start = beginIdempotentCommand<NoteAddResult>(store, idemReq, now);
    if (start.kind === "replay") return start.result;

    let canonicalAdvanced = false;
    try {
      const base = (await deps.repo.readRef(canonicalRef)) ?? "0000000000000000000000000000000000000000";

      const wdeps: WorkflowDeps = { store, broker: integration.broker, backup: deps.backup, repo: deps.repo, now };
      const handle = await startRun(wdeps, {
        operation: "note-add",
        runId,
        targetNoteId: fm.id,
        canonicalCommit: base,
      });

      const planHash = sha256Canonical({ noteId: fm.id, destPath, contentHash });
      await handle.checkpoint("planned", {
        planId: `${runId}-plan`,
        tier: 1,
        confidence: 1,
        summary: `note add ${fm.id}`,
        planHash,
        canonicalRef,
        baseRef: base,
      });

      const agentRef = await deps.repo.createAgentBranch(runId, canonicalRef);
      worktreeDir = await mkdtemp(
        join(deps.worktreesPath && existsSync(deps.worktreesPath) ? deps.worktreesPath : tmpdir(), `atlas-note-${runId}-`),
      );
      const worktree = await deps.repo.addWorktree(agentRef, worktreeDir);

      // The dest file must be NEW on the base tree (the broker's additions-only
      // scope is the backstop; failing here gives the caller a typed error).
      const target = join(worktreeDir, destPath);
      if (existsSync(target)) {
        throw new NoteAddRejectedError("duplicate-path", `${destPath} already exists on canonical`);
      }
      await mkdir(join(worktreeDir, posix.dirname(destPath)), { recursive: true });
      await writeFile(target, raw);

      const patchHash = sha256Canonical({ noteId: fm.id, destPath, contentHash });
      await handle.checkpoint("patched", {
        patchId: `${runId}-patch`,
        planId: `${runId}-plan`,
        noteId: fm.id,
        changedLines: text.split("\n").length,
        changedSections: 1,
        patchHash,
        planHash,
      });

      // Persist the applied-tree evidence BEFORE the commit (DEFECT #5). The
      // note-add tree is exactly one added file, hashed deterministically.
      const treeHash = sha256Canonical({ destPath, contentHash });
      await handle.checkpoint("worktree-applied", { worktreePath: worktreeDir, treeHash, agentRef });

      const commitManifest: RunManifest = {
        schemaVersion: 1,
        runId,
        state: "agent-committed",
        createdAt: now(),
        canonicalBaseCommit: base,
        targets: [fm.id],
      };
      const commitSha = await worktree.commit(`note add ${fm.id}`, commitManifest);
      await handle.checkpoint("agent-committed", { commitSha, treeHash, agentRef, tier: 1 });

      // ── Integrate via broker Tier-1 CAS under scope "note" (DEFECT #2:
      // signing broker-side; the scope rides deps.connectIntegration's wiring).
      const integrated = await handle.integrate(integration.integrate);
      canonicalAdvanced = true;

      await foldProvenanceFromCanonical(store, deps.repo, canonicalRef);
      await handle.checkpoint("reindexed", { indexGeneration: 1, canonicalSha: integrated.canonicalSha });

      const result: NoteAddResult = {
        noteId: fm.id,
        path: destPath,
        contentHash: `sha256:${contentHash}`,
        runId,
        canonicalSha: integrated.canonicalSha,
      };
      await handle.finalize(completeIdempotentStatement(idemReq, JSON.stringify(result), now()));

      await cleanupWorktree(deps.repo, worktreeDir);
      worktreeDir = null;
      return result;
    } catch (e) {
      // Release the idempotency key ONLY if canonical did NOT advance (DEFECT #3).
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
    /* best-effort — the reconciler sweeps leftovers */
  }
}

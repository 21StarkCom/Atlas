/**
 * `workflows/mutation-order` — the v2 canonical mutation sequence (task 3-3b, #325).
 *
 * The ONE machinery every mutating handler wraps. It fixes the binding order so a
 * mutation can never precede validation + grounding, commits the touched paths
 * DIRECTLY onto `refs/heads/main` (v2 has no privilege boundary, no agent
 * branch/worktree, no broker CAS — {@link commitPaths} is the whole install), and
 * refreshes the derived stores in the order that keeps a failed index write from
 * stranding a stale projection cursor. The binding sequence (built on
 * {@link withVaultMutation}, which owns the advisory vault lock + external
 * `index.lock` preflight — never double-acquired here):
 *
 *   vault lock
 *   -> assert HEAD == refs/heads/main   (feature-branch / detached HEAD => exit 2, no mutation)
 *   -> validate                          (structural refusal => exit 1)
 *   -> ground                            (retrieval / normalize / plan)
 *   -> dirty-vault grounding             (a dirty target/source note => exit 1)
 *   -> preApply                          (external index.lock recheck, every retry)
 *   -> CAPTURE touched-path preimage     (working-tree bytes, BEFORE apply)
 *   -> apply                             (write files to the working tree)
 *   -> commitPaths                       (a catchable apply/commit failure restores the preimage)
 *   -> refresh LanceDB index             (a failed index write ABORTS before contentHash advances)
 *   -> refresh SQLite projection         (advances notes.content_hash)
 *   -> release
 *
 * A hard crash between apply and commit leaves an uncommitted partial the NEXT run's
 * dirty-vault preflight catches at exit 1; a crash after commit but before the index
 * refresh leaves `notes.content_hash` stale, which the next `brain sync` heals.
 *
 * Dirty-vault doctrine: reads + `sync` treat dirt as normal; a mutating command
 * tolerates UNRELATED working-tree dirt but fails grounding (exit 1) if any note it
 * edits/names is dirty — dirty being (on-disk hash != projection `content_hash`) OR
 * (an uncommitted git diff vs `HEAD`).
 */
import { createHash } from "node:crypto";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join } from "node:path";
import { mkdirSync } from "node:fs";
import { commitPaths, type Repo } from "@atlas/git";
import type { Store } from "@atlas/sqlite-store";
import { CliError, EXIT } from "../errors/envelope.js";
import type { RunContext } from "../handlers.js";
import type { LockScope } from "../locks/manager.js";
import { withVaultMutation } from "../locks/mutation-guard.js";

/** The one branch v2 commits onto — canonical IS `refs/heads/main` (no indirection). */
export const CANONICAL_BRANCH = "refs/heads/main";

/** The grounded plan a mutation produces: what to write, commit, and re-derive. */
export interface Grounded {
  /** The repo-relative paths the mutation touches (created / edited / deleted). */
  readonly touchedPaths: readonly string[];
  /** The commit subject for the direct commit onto `refs/heads/main`. */
  readonly commitMessage: string;
  /** The note ids whose derived-store rows the refresh re-derives. */
  readonly affectedNoteIds: readonly string[];
  /**
   * Repo-relative paths of EXISTING notes this mutation edits/names — the
   * dirty-vault gate refuses (exit 1) if any is dirty. A brand-new note (note
   * add) contributes none: it cannot be stale against a projection it is not in.
   */
  readonly dirtyCheckPaths?: readonly string[];
  /** Write the touched files to the working tree. Throwing restores the preimage. */
  apply(): Promise<void> | void;
}

/** The mutation the wrapper drives. Callers implement the grounding + refresh seams. */
export interface MutationOrder<T> {
  readonly ctx: RunContext;
  readonly repo: Repo;
  /** Absolute vault working-tree path (the git repo root). */
  readonly vaultPath: string;
  /** The projection store, for the dirty-vault `content_hash` comparison. Omit to skip it. */
  readonly store?: Store;
  /** Lock scope; defaults to the broadest `vault-maintenance` (see {@link withVaultMutation}). */
  readonly scope?: LockScope;
  /** Pure structural validation before grounding; throw a `CliError` (exit 1) to refuse. */
  validate?(): void | Promise<void>;
  /** Retrieval / normalize / plan → the {@link Grounded} apply spec. */
  ground(preApply: () => void): Grounded | Promise<Grounded>;
  /**
   * Refresh the LanceDB retrieval index for the affected notes. Runs BEFORE the
   * projection refresh — throwing here aborts the sequence with `notes.content_hash`
   * left stale, so the next `brain sync` re-derives and heals. Omit for a mutation
   * with no retrieval surface (the projection still refreshes).
   */
  refreshIndex?(grounded: Grounded, commitSha: string): Promise<void>;
  /** Refresh the SQLite projection (advances `notes.content_hash`). */
  refreshProjection?(grounded: Grounded, commitSha: string): Promise<void>;
  /** Build the handler's result once the commit + refresh have landed. */
  buildResult(commitSha: string, grounded: Grounded): T;
}

/** The `sha256:`-prefixed content hash the vault reader stamps on a note (parseNote). */
function onDiskContentHash(absPath: string): string {
  return `sha256:${createHash("sha256").update(readFileSync(absPath, "utf8"), "utf8").digest("hex")}`;
}

/** Resolve a repo-relative path to an absolute working-tree path. */
function absOf(vaultPath: string, rel: string): string {
  return isAbsolute(rel) ? rel : join(vaultPath, rel);
}

/** What the dirty-vault gate needs to inspect a set of note paths (a structural
 * subset of {@link MutationOrder}, so the wrapper passes its order straight in;
 * a handler needing the SAME gate before its own noop classification — `link`'s
 * "noop only for grounded, clean notes" rule — builds one directly). */
export interface DirtyCheckDeps {
  readonly repo: Repo;
  /** Absolute vault working-tree path (the git repo root). */
  readonly vaultPath: string;
  /** The projection store, for the `content_hash` comparison. Omit to skip it. */
  readonly store?: Store;
}

/**
 * The dirty-vault grounding gate. For each note path the mutation edits/names,
 * refuse (exit 1) when the on-disk state diverges from the committed projection —
 * either an uncommitted git diff vs `HEAD`, or an on-disk hash that no longer
 * matches the note's projected `content_hash`. Unrelated dirt elsewhere in the
 * vault is untouched (only these paths are inspected).
 */
export async function assertNotDirty(order: DirtyCheckDeps, paths: readonly string[]): Promise<void> {
  if (paths.length === 0) return;
  // (1) Uncommitted working-tree diff vs HEAD for any of the paths.
  const status = await order.repo.worktreeStatus(paths);
  if (status.length > 0) {
    const first = status[0]!;
    throw new CliError({
      code: "dirty-vault",
      message: `note "${first.path}" has uncommitted changes (git status ${JSON.stringify(first.code)})`,
      hint: "Commit or discard the working-tree changes to the note before mutating it; the mutation order refuses to build on a dirty note.",
      exitCode: EXIT.VALIDATION,
      details: { path: first.path, code: first.code, kind: "working-tree" },
    });
  }
  // (2) On-disk hash != the projected content_hash (a git-only revert / stale
  // projection leaves the derived store ahead of or behind the file).
  if (order.store !== undefined) {
    for (const rel of paths) {
      const abs = absOf(order.vaultPath, rel);
      if (!existsSync(abs)) continue; // a delete has no on-disk hash to compare
      const row = order.store.db
        .prepare(`SELECT content_hash FROM notes WHERE file_path = ?`)
        .get(rel) as { content_hash: string } | undefined;
      if (row === undefined) continue; // not yet projected ⇒ nothing to be stale against
      const disk = onDiskContentHash(abs);
      if (disk !== row.content_hash) {
        throw new CliError({
          code: "dirty-vault",
          message: `note "${rel}" is out of sync: on-disk hash ${disk} != projection content_hash ${row.content_hash}`,
          hint: "The projection is stale for this note; run `brain sync` to re-derive it before mutating.",
          exitCode: EXIT.VALIDATION,
          details: { path: rel, disk, projection: row.content_hash, kind: "projection-drift" },
        });
      }
    }
  }
}

/** Assert `HEAD` is attached to `refs/heads/main`; a feature-branch/detached HEAD ⇒ exit 2. */
async function assertHeadOnMain(repo: Repo): Promise<void> {
  const head = await repo.headRef();
  if (head !== CANONICAL_BRANCH) {
    throw new CliError({
      code: "head-not-canonical",
      message: `HEAD is ${head === null ? "detached" : `on ${head}`}, not ${CANONICAL_BRANCH}`,
      hint: `Atlas mutations commit directly onto ${CANONICAL_BRANCH}; check out main (\`git switch main\`) before mutating.`,
      exitCode: EXIT.CONFIG,
      details: { head, expected: CANONICAL_BRANCH, kind: "head-guard" },
    });
  }
}

/** A touched path's pre-apply working-tree state: its bytes, or absence. */
interface PreimageEntry {
  readonly rel: string;
  readonly abs: string;
  readonly existed: boolean;
  readonly bytes: Buffer | null;
}

/** Snapshot the touched paths' working-tree bytes BEFORE apply, for rollback. */
function capturePreimage(vaultPath: string, paths: readonly string[]): PreimageEntry[] {
  return paths.map((rel) => {
    const abs = absOf(vaultPath, rel);
    const existed = existsSync(abs);
    return { rel, abs, existed, bytes: existed ? readFileSync(abs) : null };
  });
}

/** Restore the working tree to the captured preimage (best-effort, on apply/commit failure). */
function restorePreimage(preimage: readonly PreimageEntry[]): void {
  for (const e of preimage) {
    try {
      if (e.existed && e.bytes !== null) {
        mkdirSync(dirname(e.abs), { recursive: true });
        writeFileSync(e.abs, e.bytes);
      } else if (existsSync(e.abs)) {
        rmSync(e.abs, { force: true });
      }
    } catch {
      /* best-effort — the next run's dirty-vault preflight catches any residue */
    }
  }
}

/**
 * Run a mutation through the binding order (see the module doc). The advisory vault
 * lock + external-`index.lock` preflight come from {@link withVaultMutation}; this
 * adds the HEAD guard, dirty-vault gate, preimage capture/restore, the direct
 * {@link commitPaths} install, and the index-then-projection refresh.
 */
export async function runMutation<T>(order: MutationOrder<T>): Promise<T> {
  return withVaultMutation(
    order.ctx,
    order.vaultPath,
    async (preApply) => {
      // HEAD must be main BEFORE anything mutates — a feature-branch/detached
      // checkout must never be written (exit 2, no mutation).
      await assertHeadOnMain(order.repo);

      // Validate (structural) then ground (retrieval/normalize/plan). No mutation
      // has happened yet; a refusal in either is a clean exit before any side effect.
      if (order.validate) await order.validate();
      const grounded = await order.ground(preApply);

      // Dirty-vault grounding: refuse to build on a dirty target/source note.
      await assertNotDirty(order, grounded.dirtyCheckPaths ?? []);

      if (grounded.touchedPaths.length === 0) {
        throw new CliError({
          code: "mutation-touched-nothing",
          message: "the grounded mutation declared no touched paths — refusing to commit nothing",
          hint: "A mutation must name the vault paths it writes; an empty set is a grounding bug.",
          exitCode: EXIT.INTERNAL,
        });
      }

      // CAPTURE the preimage BEFORE apply (working-tree bytes of the touched paths).
      const preimage = capturePreimage(order.vaultPath, grounded.touchedPaths);

      // apply -> commitPaths. A throw in EITHER restores the preimage (commitPaths
      // additionally rolls back its own index staging on a commit failure).
      let commitSha: string;
      try {
        await grounded.apply();
        // TEST-ONLY apply→commit failpoint (a no-op unless armed): throw AFTER the
        // working-tree write, BEFORE the commit, so the restoration test can prove
        // the preimage is restored (the just-written file reverts, no commit lands).
        if (order.ctx.env.ATLAS_TEST_MUTATION_APPLY_FAIL === "1") {
          throw new CliError({
            code: "apply-failed",
            message: "TEST-ONLY: forced apply→commit failure",
            exitCode: EXIT.INTERNAL,
          });
        }
        commitSha = await commitPaths(order.repo, grounded.touchedPaths, grounded.commitMessage);
      } catch (err) {
        restorePreimage(preimage);
        throw err;
      }

      // Refresh derived stores: LanceDB index FIRST (a failed write aborts here,
      // leaving content_hash stale for the next sync to heal), THEN the SQLite
      // projection (which advances content_hash).
      // TEST-ONLY index-write failpoint (a no-op unless armed — same discipline as
      // the mutation barrier). Fires AFTER the commit landed, BEFORE any projection
      // advance, so the restoration test can prove a failed index write leaves
      // `notes.content_hash` stale for the next `brain sync` to heal.
      if (order.ctx.env.ATLAS_TEST_INDEX_WRITE_FAIL === "1") {
        throw new CliError({
          code: "index-write-failed",
          message: "TEST-ONLY: forced LanceDB index-write failure before the projection refresh",
          exitCode: EXIT.INTERNAL,
          retryable: true,
        });
      }
      if (order.refreshIndex) await order.refreshIndex(grounded, commitSha);
      if (order.refreshProjection) await order.refreshProjection(grounded, commitSha);

      return order.buildResult(commitSha, grounded);
    },
    order.scope ?? "vault-maintenance",
  );
}

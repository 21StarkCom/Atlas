/**
 * `brain git status` (Task 2.9 / #35) — paginated OPEN-run status over the
 * workflow state machine (`agent_runs`, plan §2.5 / recovery-state-machine). Lists
 * every non-terminal run with its state, agent branch, proposed risk tier,
 * validation status, base commit, and worktree presence. Read-only: no branch/
 * worktree/ref/ledger mutation. Terminal runs are excluded — prune them with
 * `git cleanup`.
 *
 * Ordering is `(updatedAt DESC, runId ASC)`. `runId` (a ULID) is unique, so the
 * total order is fully resolved and offset pagination is deterministic under
 * concurrent inserts (best-effort under concurrency, plan §2.5).
 */
import { existsSync, lstatSync, realpathSync } from "node:fs";

/**
 * True when a `.git` ENTRY exists at `vaultPath` — even a dangling symlink or a broken
 * inode. `existsSync` follows symlinks and returns false for a dangling `.git` symlink,
 * which would let corrupt repository metadata fall into the benign "no repository" path
 * (exit 0). `lstat` inspects the entry itself: only a true `ENOENT` means genuinely absent;
 * any other error (a present-but-broken entry) is treated as present so the caller
 * propagates `internal` rather than falsely reporting "no worktrees".
 */
function gitEntryPresent(vaultPath: string): boolean {
  try {
    lstatSync(join(vaultPath, ".git"));
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code !== "ENOENT";
  }
}
import { join } from "node:path";
import { openRepo, GitError, type WorktreeEntry } from "@atlas/git";
import { type SqliteDatabase } from "@atlas/sqlite-store";
import { CliError, EXIT, emitJson } from "../errors/envelope.js";
import { registerCommand, type RunContext } from "../handlers.js";
import { openMigratedStore } from "./store-open.js";
import { resolvePath } from "./backup-config.js";
import {
  DEFAULT_LIMIT,
  assertOffsetInRange,
  buildPagination,
  parseLimit,
  parseOffset,
  type PageRequest,
} from "./pagination.js";

/**
 * The genuinely OPEN workflow states (Task 2.9). `git status` lists exactly these;
 * every terminal state (integrated/reindexed/finalized/rejected/rolled-back/
 * failed/cancelled) is excluded. Kept in sync with the `git-status.schema.json`
 * `state` enum.
 */
export const OPEN_RUN_STATES = [
  "planned",
  "patched",
  "worktree-applied",
  "agent-committed",
  "review-pending",
] as const;

const OPEN_STATES_SQL = OPEN_RUN_STATES.map((s) => `'${s}'`).join(", ");

function parseArgs(argv: string[]): PageRequest {
  let limit = DEFAULT_LIMIT;
  let offset = 0;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    const need = (): string => {
      const v = argv[++i];
      if (v === undefined) throw CliError.usage(`\`git status\`: ${a} requires a value`);
      return v;
    };
    if (a === "--limit") limit = parseLimit("git status", need());
    else if (a.startsWith("--limit=")) limit = parseLimit("git status", a.slice("--limit=".length));
    else if (a === "--offset") offset = parseOffset("git status", need());
    else if (a.startsWith("--offset=")) offset = parseOffset("git status", a.slice("--offset=".length));
    else throw CliError.usage(`\`git status\`: unknown flag/argument ${a}`);
  }
  return { limit, offset };
}

/** A raw open-run row (agent_runs). */
interface OpenRunRow {
  readonly run_id: string;
  readonly status: string;
  readonly tier: number | null;
  readonly updated_at: string;
}

/**
 * Query one page of open runs, ordered by the contract sort key
 * `(updatedAt DESC, runId ASC)`. Exported for the pagination contract test.
 */
export function queryOpenRuns(
  db: SqliteDatabase,
  req: PageRequest,
): { rows: OpenRunRow[]; total: number } {
  const total = (db
    .prepare(`SELECT COUNT(*) AS c FROM agent_runs WHERE status IN (${OPEN_STATES_SQL})`)
    .get() as { c: number }).c;
  const rows = db
    .prepare(
      `SELECT run_id, status, tier, updated_at
         FROM agent_runs
        WHERE status IN (${OPEN_STATES_SQL})
        ORDER BY updated_at DESC, run_id ASC
        LIMIT ? OFFSET ?`,
    )
    .all(req.limit, req.offset) as OpenRunRow[];
  return { rows, total };
}

/** `tier` (1|2|3) → the contract `risk` enum. Open runs are planned+, so tier is set. */
function riskOf(tier: number | null): "tier-1" | "tier-2" | "tier-3" {
  return tier === 1 ? "tier-1" : tier === 2 ? "tier-2" : "tier-3";
}

/**
 * Derive validation status from `validation_results`: none ⇒ pending; else the
 * LATEST result PER `check_name` decides — any latest `fail` ⇒ failed, else passed
 * (`warn` is non-blocking). Considering only the latest result per check (not every
 * historical row) means a later successful revalidation supersedes an earlier
 * failure — and vice-versa (finding W5). "Latest" is a total order:
 * `(created_at DESC, validation_id DESC)`; `validation_id` (the unique PK) is the
 * deterministic tie-breaker so results sharing a timestamp still resolve stably.
 */
function validationOf(db: SqliteDatabase, runId: string): "pending" | "passed" | "failed" {
  const outcomes = (db
    .prepare(
      `SELECT vr.outcome FROM validation_results vr
        WHERE vr.run_id = ?
          AND NOT EXISTS (
            SELECT 1 FROM validation_results v2
             WHERE v2.run_id = vr.run_id
               AND v2.check_name = vr.check_name
               AND (v2.created_at > vr.created_at
                    OR (v2.created_at = vr.created_at AND v2.validation_id > vr.validation_id)))`,
    )
    .all(runId) as { outcome: string }[]).map((r) => r.outcome);
  if (outcomes.length === 0) return "pending";
  return outcomes.includes("fail") ? "failed" : "passed";
}

/** The base commit recorded at `planned` (git_operations op_type='base'), or the zero placeholder. */
function baseCommitOf(db: SqliteDatabase, runId: string): string {
  const row = db
    .prepare(`SELECT commit_sha FROM git_operations WHERE run_id = ? AND op_type = 'base'`)
    .get(runId) as { commit_sha: string | null } | undefined;
  return row?.commit_sha ?? "0".repeat(40);
}

/**
 * True iff git reports a worktree registered at this run's recorded path whose HEAD
 * is bound to the run's OWN `refs/agent/<runId>`. A bare `existsSync` on the ledger
 * `ref_name` (the prior implementation) reports ANY ordinary, reassigned, or reused
 * directory — or another run's worktree at a stale path — as this run's worktree, and
 * never actually inspects git despite this being a git-status surface. We instead
 * verify against git's own registered worktree/ref binding ({@link WorktreeEntry}),
 * read ONCE for the whole page. `worktrees` is `[]` when the vault is not a git repo,
 * so a non-git vault reports every run as having no worktree rather than crashing.
 */
function hasWorktreeOf(
  db: SqliteDatabase,
  worktrees: readonly WorktreeEntry[],
  runId: string,
): boolean {
  const row = db
    .prepare(`SELECT ref_name FROM git_operations WHERE run_id = ? AND op_type = 'worktree-applied'`)
    .get(runId) as { ref_name: string } | undefined;
  if (row === undefined || !existsSync(row.ref_name)) return false;
  // `git worktree list` reports symlink-resolved absolute paths, so canonicalize the
  // recorded path before matching (e.g. /tmp → /private/tmp on macOS).
  const abs = realpathSync(row.ref_name);
  const ref = `refs/agent/${runId}`;
  return worktrees.some((w) => w.path === abs && w.branch === ref);
}

/**
 * True iff a {@link GitError} is git's "this is an ORDINARY directory, no repository
 * here" signal — the ONLY git failure `git status` degrades to "no worktrees". `git
 * worktree list` in a directory that was never `git init`ed exits 128 with the
 * distinctive stderr `fatal: not a git repository (or any of the parent
 * directories): .git`; that parenthetical is git's marker for "searched upward and
 * found no repo" — the sole benign case (a vault with no initialized repo simply has
 * no agent worktrees).
 *
 * Matching the bare substring `not a git repository` (an even earlier implementation)
 * was TOO BROAD: a MALFORMED `.git` FILE pointing at a missing gitdir fails with
 * `fatal: not a git repository: (null)` (or a bad path) — that ALSO contains the
 * substring but is CORRUPT repository metadata, not an uninitialized vault, and must
 * PROPAGATE as an operational error rather than be swallowed as "no worktrees".
 *
 * But the parenthetical message ALONE is ALSO insufficient (round-3 finding): an EMPTY
 * or unreadable `.git` DIRECTORY makes git emit the SAME `not a git repository (or any
 * of the parent directories): .git` — yet that is corrupt/inaccessible repository
 * metadata, not a vault that was simply never `git init`ed. Distinguishing the two from
 * stderr is impossible, so the caller ALSO requires a VERIFIED-ABSENT vault-root `.git`
 * entry before degrading; a present `.git` (empty, corrupt, or unreadable) propagates as
 * `internal`. A broken gitfile (`invalid gitfile format`), permission denial, and exec
 * failures never carry the parenthetical and so propagate regardless.
 */
function isNotARepository(e: GitError): boolean {
  return /not a git repository \(or any of the parent directories\)/i.test(e.stderr);
}

/**
 * git's registered worktrees for the vault, or `[]` when the vault is not a git
 * repo. `git status` is a read surface over the DB projection, so a vault without
 * an initialized repo simply has no agent worktrees and degrades to "none".
 *
 * But ONLY that genuine non-repository case degrades: a bare `catch → return []`
 * (the prior implementation) swallowed EVERY GitError — permission failure, repo
 * corruption, a broken gitfile, exec failure — into an empty worktree list + exit
 * 0, falsely reporting `hasWorktree = false` and contradicting the git-status
 * contract's error paths. Every other operational git failure propagates as
 * `internal` (exit 4) per that contract so worktree presence is never silently
 * mis-reported. Worktree enrichment is best-effort ONLY against the missing-repo
 * case — not against real failures.
 *
 * The non-repository case additionally requires a VERIFIED-ABSENT vault-root `.git`
 * entry (round-3 finding): an empty/corrupt/unreadable `.git` DIRECTORY emits the same
 * parenthetical message as an uninitialized vault, so degrading on the message alone
 * would swallow corrupt repository metadata. If `.git` exists, we propagate `internal`
 * rather than falsely report "no worktrees".
 */
async function listWorktreesSafe(vaultPath: string): Promise<WorktreeEntry[]> {
  try {
    return await openRepo(vaultPath).listWorktrees();
  } catch (e) {
    if (e instanceof GitError && isNotARepository(e) && !gitEntryPresent(vaultPath)) return [];
    if (e instanceof GitError) {
      throw new CliError({
        code: "internal",
        message: `\`git status\`: reading git worktrees failed: ${e.message}`,
        hint: "Check the vault repository's integrity and permissions, then retry.",
        exitCode: EXIT.INTERNAL,
        cause: e,
      });
    }
    throw e;
  }
}

async function gitStatus(ctx: RunContext): Promise<number> {
  const req = parseArgs(ctx.argv);
  const vaultPath = resolvePath(ctx, ctx.config.config.vault.path);
  if (!existsSync(vaultPath)) {
    throw new CliError({
      code: "vault-error",
      message: `\`git status\`: the vault repo at ${vaultPath} is missing or unreadable`,
      hint: "Check vault.path in brain.config.yaml.",
      exitCode: EXIT.CONFIG,
    });
  }
  const store = openMigratedStore(ctx);
  try {
    const { rows, total } = queryOpenRuns(store.db, req);
    assertOffsetInRange("git status", req.offset, total);
    // git's registered worktree/ref bindings, read ONCE for the page — the ground
    // truth each run's recorded worktree path is verified against.
    const worktrees = await listWorktreesSafe(vaultPath);
    const runs = rows.map((r) => ({
      runId: r.run_id,
      state: r.status,
      branch: `refs/agent/${r.run_id}`,
      risk: riskOf(r.tier),
      validation: validationOf(store.db, r.run_id),
      baseCommit: baseCommitOf(store.db, r.run_id),
      hasWorktree: hasWorktreeOf(store.db, worktrees, r.run_id),
      updatedAt: r.updated_at,
    }));
    const out = {
      command: "git status",
      runs,
      pagination: buildPagination(req, total, rows.length),
    };
    if (ctx.output.mode === "json") emitJson(out);
    else ctx.render(`open runs: ${runs.length} of ${total}`);
    return EXIT.OK;
  } finally {
    store.close();
  }
}

registerCommand("git status", gitStatus);

export { gitStatus };

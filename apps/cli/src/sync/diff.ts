/**
 * `sync/diff` — the OQ#5 pre-diff divergence guard + behind-by counting
 * (60-B Task 4.3; plan §0 is the normative policy).
 *
 * The whole delta model assumes the upstream head is a DESCENDANT of the
 * cursor. main-vault has three uncoordinated writers that can rebase or
 * force-push, and an upstream `git gc` can make the cursor OID unresolvable —
 * `git diff cursor..head`, `behindBy`, and continuation are all UNDEFINED on
 * divergence. So the guard runs at cycle step 2, BEFORE any diff or count, and
 * on a non-`ok` state the cycle halts REJECT (exit 2, error envelope, cursor
 * unadvanced, no run, no ledger write, no audit append). Re-convergence is
 * never automatic — it requires the operator-authorized `sync reset` (Phase 5).
 *
 * A `null` cursor is the adoption zero-state (first absorb against the empty
 * tree), NOT divergence.
 */
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { Repo } from "@atlas/git";

const execFileAsync = promisify(execFile);

// ===========================================================================
// v2 reconciliation routine (#329, Phase-3 task 5) — the ONE SSOT differ.
// ===========================================================================
//
// v2 retires the absorb-cycle's HEAD cursor: the SQLite projection's per-note
// `content_hash` IS the cursor. `reconcile` classifies the vault working tree
// against that projection, matched by the note's STABLE frontmatter `id` (never
// its path — a rename keeps the id and moves the path). Both `sync` (to act) and
// `status` (read-only, for the pending counts) consume this exact function, so
// the two can never disagree about the pending set.
//
// The four buckets are DISJOINT and a content change ALWAYS wins:
//   - **new**     — a vault id absent from the projection.
//   - **dropped** — a projection id absent from the vault (purged, not archived).
//   - **moved**   — same id, IDENTICAL content hash, different path. Path-only ⇒
//                   no re-embed; the handler updates `file_path` in place.
//   - **changed** — same id, DIFFERENT content hash. Carries the (possibly new)
//                   path. A rename-plus-edit (new path AND new hash) is `changed`
//                   (never `moved`): the handler updates `file_path` AND
//                   re-embeds exactly once.
// A vault note whose id, hash, AND path all match the projection is UNCHANGED —
// it appears in no bucket. An empty result set is a structural noop.

/** A vault ↔ projection note keyed by its stable frontmatter id. */
export interface ReconcileNote {
  readonly noteId: string;
  readonly path: string;
  readonly contentHash: string;
}

/** A pure move: same id + identical content, path relocated. No re-embed. */
export interface ReconcileMove {
  readonly noteId: string;
  readonly fromPath: string;
  readonly toPath: string;
  /** The (unchanged) content hash shared by both sides — proof it is path-only. */
  readonly contentHash: string;
}

/** The classification result. `reindexed = changed + new` is DERIVABLE (consumers sum) — not stored. */
export interface ReconcileResult {
  /** Content changed (carries the current path — possibly relocated too). Re-embedded. */
  readonly changed: readonly ReconcileNote[];
  /** Present in the vault, absent from the projection. Indexed fresh. */
  readonly new: readonly ReconcileNote[];
  /** Present in the projection, absent from the vault. Purged cross-store. */
  readonly dropped: readonly ReconcileNote[];
  /** Same id + identical content, relocated. Path updated in place; no re-embed. */
  readonly moved: readonly ReconcileMove[];
}

/**
 * Classify the vault working tree against the SQLite projection by stable id.
 * Pure and deterministic; every bucket is sorted by `noteId` for a stable
 * envelope. `vault` is every successfully-parsed working-tree note; `projection`
 * is every `notes` row. A duplicate id in either input is a caller error (the
 * vault reader surfaces duplicate ids as a fatal error before `sync` reconciles);
 * here the LAST occurrence wins, deterministically.
 */
export function reconcile(
  vault: readonly ReconcileNote[],
  projection: readonly ReconcileNote[],
): ReconcileResult {
  const proj = new Map<string, ReconcileNote>();
  for (const p of projection) proj.set(p.noteId, p);
  const vaultById = new Map<string, ReconcileNote>();
  for (const v of vault) vaultById.set(v.noteId, v);

  const changed: ReconcileNote[] = [];
  const created: ReconcileNote[] = [];
  const moved: ReconcileMove[] = [];

  for (const v of vaultById.values()) {
    const p = proj.get(v.noteId);
    if (p === undefined) {
      created.push(v);
      continue;
    }
    if (p.contentHash !== v.contentHash) {
      // Content-change WINS — even if the path also moved (rename-plus-edit),
      // this is `changed` carrying the current path, never `moved`.
      changed.push(v);
      continue;
    }
    // Identical content hash from here.
    if (p.path !== v.path) {
      moved.push({ noteId: v.noteId, fromPath: p.path, toPath: v.path, contentHash: v.contentHash });
    }
    // else: id + hash + path all match ⇒ unchanged ⇒ no bucket.
  }

  const dropped: ReconcileNote[] = [];
  for (const p of proj.values()) {
    if (!vaultById.has(p.noteId)) dropped.push(p);
  }

  const byId = (a: { noteId: string }, b: { noteId: string }): number =>
    a.noteId < b.noteId ? -1 : a.noteId > b.noteId ? 1 : 0;
  changed.sort(byId);
  created.sort(byId);
  dropped.sort(byId);
  moved.sort(byId);
  return { changed, new: created, dropped, moved };
}

export type Divergence =
  | { readonly state: "ok" }
  | { readonly state: "non-ancestral"; readonly cursorOid: string; readonly upstreamHead: string }
  | { readonly state: "cursor-unreachable"; readonly cursorOid: string; readonly upstreamHead: string };

/**
 * Classify the cursor↔head relation. `readRef(lastOid)` treats the OID as a
 * commitish (`rev-parse --verify --quiet <oid>^{commit}`): `null` ⇒ the commit
 * is gone from the object store (upstream gc) ⇒ `cursor-unreachable`. A
 * resolvable cursor that is not an ancestor of the head (force-push/rewrite) ⇒
 * `non-ancestral`. Operational git failures propagate (never classified).
 */
export async function detectDivergence(
  repo: Repo,
  lastOid: string | null,
  upstreamHead: string,
): Promise<Divergence> {
  if (lastOid === null) return { state: "ok" };
  const resolved = await repo.readRef(lastOid);
  if (resolved === null) return { state: "cursor-unreachable", cursorOid: lastOid, upstreamHead };
  if (!(await repo.isAncestor(lastOid, upstreamHead))) {
    return { state: "non-ancestral", cursorOid: lastOid, upstreamHead };
  }
  // FIRST-PARENT ANCHORING (#289 review: MAJOR). `isAncestor` accepts ANY-parent
  // ancestry, but the whole delta model — countBehind and commitsInRange — walks
  // the FIRST-PARENT chain. First-parent diffs compose to tree(anchor)→tree(head)
  // and equal tree(cursor)→tree(head) ONLY when the cursor lies ON upstreamHead's
  // first-parent chain. A cursor reachable only through a second parent (an
  // `ours`-merge revert, or a pull-merge whose conflict resolution discards the
  // absorbed side) passes isAncestor but the walked diffs miss the divergent
  // paths — the cycle would absorb an empty/broken delta and advance the cursor,
  // silently diverging canonical from upstream forever with NO signal. That is
  // exactly the silent-RESET outcome plan §0's OQ#5 REJECT policy forbids. So we
  // additionally require the cursor to sit on the first-parent chain: the commit
  // `behindBy` first-parent steps back from head (git `~N` follows first parents)
  // must BE the cursor. A mismatch is a divergence → REJECT (recover via `sync
  // reset`), never a silent absorb.
  const behind = await countBehind(repo, lastOid, upstreamHead);
  const firstParentAnchor = await repo.readRef(`${upstreamHead}~${behind}`);
  if (firstParentAnchor !== resolved) {
    return { state: "non-ancestral", cursorOid: lastOid, upstreamHead };
  }
  return { state: "ok" };
}

/**
 * First-parent commit count `lastOid..upstreamHead` (the `behindBy` surface).
 * Zero-state (`null` cursor) counts the full first-parent chain to the root.
 * MUST only be called after `detectDivergence` returned `ok` — the count is
 * undefined across a divergence (`sync status` reports `behindBy: null` there).
 *
 * Shells `git rev-list --count --first-parent` directly (the same pattern as
 * `sync/resolve-at-ref.ts`): `Repo` exposes no count primitive, and the walk
 * matches `commitsInRange`'s first-parent semantics so `behindBy` and the
 * dispatch always agree on the same chain.
 */
export async function countBehind(repo: Repo, lastOid: string | null, upstreamHead: string): Promise<number> {
  const range = lastOid === null ? upstreamHead : `${lastOid}..${upstreamHead}`;
  const { stdout } = await execFileAsync(
    "git",
    ["-C", repo.dir, "rev-list", "--count", "--first-parent", range],
    { encoding: "utf8" },
  );
  const n = Number.parseInt(stdout.trim(), 10);
  if (!Number.isInteger(n) || n < 0) {
    throw new Error(`countBehind: unparseable rev-list --count output "${stdout.trim()}"`);
  }
  return n;
}

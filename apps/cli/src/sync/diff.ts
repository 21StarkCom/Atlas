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

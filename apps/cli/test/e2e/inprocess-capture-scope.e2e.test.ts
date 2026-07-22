/**
 * `inprocess-capture-scope.e2e` (phase-2 in-process cutover, task 2.2, ADR-0003) —
 * the capture-commit SCOPE policy is PRESERVED in-process. The retired broker used to
 * enforce, per `CaptureScope`, that a capture commit touched only its permitted
 * paths/statuses over the whole `base..commit` range; the in-process client
 * re-enforces the SAME policy before any FF advance, so a capture seam can never
 * advance an arbitrary commit even though there is no daemon.
 *
 * Driven through the PRODUCTION `buildCaptureDeps` → `connectIntegration` wiring (not
 * a duplicated adapter), one scope per case, asserting forbidden PATHS and forbidden
 * STATUSES are refused `broker.capture_scope_violation` and canonical stays put — and
 * one in-scope commit still advances (the gate is not vacuously always-throwing).
 */
import { mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { newRunId, type AuditEvent } from "@atlas/contracts";
import type { CaptureScope } from "@atlas/broker";
import { buildCaptureDeps } from "../../src/ingest/wiring.js";
import { makePhase2Harness, CANONICAL_REF, type Phase2Harness } from "./phase2-support.js";

const FIXED_NOW = "2026-07-14T00:00:00.000Z";

/** Write `rel` (creating parent dirs) inside worktree `wt`. */
function put(wt: string, rel: string, content: string): void {
  const full = join(wt, rel);
  mkdirSync(dirname(full), { recursive: true });
  writeFileSync(full, content, "utf8");
}

/** Build a candidate commit off canonical via `mutate`, in a throwaway worktree; returns its sha. */
function buildCandidate(h: Phase2Harness, mutate: (wtDir: string) => void): string {
  const branch = `cand-${newRunId()}`;
  const wtDir = join(h.worktreesPath, branch);
  h.git(["worktree", "add", "-q", "-b", branch, wtDir, CANONICAL_REF]);
  try {
    mutate(wtDir);
    h.gitIn(wtDir, ["add", "-A"]);
    h.gitIn(wtDir, ["commit", "-q", "-m", "candidate"]);
    return h.gitIn(wtDir, ["rev-parse", "HEAD"]);
  } finally {
    h.git(["worktree", "remove", "--force", wtDir]);
    try {
      h.git(["branch", "-D", branch]);
    } catch {
      /* best-effort */
    }
  }
}

/**
 * Build a MERGE commit off canonical whose first-parent line is clean but whose
 * MERGED SIDE BRANCH introduced (and reverted) a forbidden change — the exact hole
 * a first-parent-only walk (`commitsInRange`) misses and an all-reachable `-m` walk
 * (`changedStatusesInRange`, matching the broker) catches. Returns the merge sha.
 *
 * Shape: canonical → [main line] adds `good.md` (sync-allowed); [side line] adds then
 * DELETES `sources/smuggled.md` (net-nothing, so the merge's net tree == main line's).
 * The merge's first parent is the main line, so a first-parent diff sees only `good.md`
 * — but every commit in `base..merge` inspected with `-m` reveals the `A`/`D` of
 * `sources/smuggled.md`, which the scope gate must refuse.
 */
function buildMergeSmugglingCandidate(h: Phase2Harness): string {
  const mainBranch = `mainline-${newRunId()}`;
  const sideBranch = `side-${newRunId()}`;
  const mainWt = join(h.worktreesPath, mainBranch);
  const sideWt = join(h.worktreesPath, sideBranch);
  h.git(["worktree", "add", "-q", "-b", mainBranch, mainWt, CANONICAL_REF]);
  h.git(["worktree", "add", "-q", "-b", sideBranch, sideWt, CANONICAL_REF]);
  try {
    // Main line: a single legit sync-allowed addition.
    put(mainWt, "good.md", "# good\n");
    h.gitIn(mainWt, ["add", "-A"]);
    h.gitIn(mainWt, ["commit", "-q", "-m", "mainline good"]);
    // Side line: add a forbidden capture-namespace note, then revert it (net-nothing).
    put(sideWt, "sources/smuggled.md", "# smuggled\n");
    h.gitIn(sideWt, ["add", "-A"]);
    h.gitIn(sideWt, ["commit", "-q", "-m", "side add (forbidden)"]);
    rmSync(join(sideWt, "sources", "smuggled.md"));
    h.gitIn(sideWt, ["add", "-A"]);
    h.gitIn(sideWt, ["commit", "-q", "-m", "side revert"]);
    const sideSha = h.gitIn(sideWt, ["rev-parse", "HEAD"]);
    // Merge the side line into the main line (first parent = main line → tip clean).
    h.gitIn(mainWt, ["merge", "--no-ff", "-q", "-m", "merge side", sideSha]);
    return h.gitIn(mainWt, ["rev-parse", "HEAD"]);
  } finally {
    h.git(["worktree", "remove", "--force", mainWt]);
    h.git(["worktree", "remove", "--force", sideWt]);
    for (const b of [mainBranch, sideBranch]) {
      try {
        h.git(["branch", "-D", b]);
      } catch {
        /* best-effort */
      }
    }
  }
}

/** An UNSIGNED `run.integrated` event for the integrate seam (the scope check runs before seq matters). */
function unsignedEvent(runId: string, canonicalCommit: string, base: string): Omit<AuditEvent, "prevAuditHead"> {
  return { schemaVersion: 1, eventId: newRunId(), kind: "run.integrated", seq: 0, occurredAt: FIXED_NOW, runId, subjects: [], canonicalCommit, detail: { baseRef: base } };
}

/** Drive the PRODUCTION capture-integration seam for `scope` against `candidate`. */
async function integrateThroughProduction(h: Phase2Harness, scope: CaptureScope, candidate: string): Promise<void> {
  const base = h.git(["rev-parse", CANONICAL_REF]);
  const deps = buildCaptureDeps(h.runContext(), "ingest", undefined, scope);
  const integration = await deps.connectIntegration();
  try {
    const runId = newRunId();
    await integration.integrate({ runId, commitSha: candidate, canonicalRef: CANONICAL_REF, baseRef: base, event: unsignedEvent(runId, candidate, base) });
  } finally {
    integration.close();
  }
}

describe("in-process capture scope (phase-2 cutover, ADR-0003) — forbidden paths/statuses refused through production CaptureDeps", () => {
  let h: Phase2Harness;
  beforeEach(async () => { h = await makePhase2Harness(); });
  afterEach(async () => { await h.cleanup(); });

  it('"sources" refuses a commit touching a non-sources / non-manifest path', async () => {
    const before = h.git(["rev-parse", CANONICAL_REF]);
    const candidate = buildCandidate(h, (wt) => put(wt, "loose-note.md", "# loose\n"));
    await expect(integrateThroughProduction(h, "sources", candidate)).rejects.toMatchObject({ code: "broker.capture_scope_violation" });
    expect(h.git(["rev-parse", CANONICAL_REF])).toBe(before); // canonical unmoved
  });

  it('"sources" accepts an in-scope sources/** commit (the gate is not vacuously always-throwing)', async () => {
    const before = h.git(["rev-parse", CANONICAL_REF]);
    const candidate = buildCandidate(h, (wt) => put(wt, "sources/blob.txt", "captured bytes\n"));
    await integrateThroughProduction(h, "sources", candidate);
    const after = h.git(["rev-parse", CANONICAL_REF]);
    expect(after).toBe(candidate);
    expect(after).not.toBe(before);
  });

  it('"note" refuses a MODIFY status (additions-only): an edit to an existing note', async () => {
    const before = h.git(["rev-parse", CANONICAL_REF]);
    const candidate = buildCandidate(h, (wt) => put(wt, "note-alpha.md", "edited\n"));
    await expect(integrateThroughProduction(h, "note", candidate)).rejects.toMatchObject({ code: "broker.capture_scope_violation" });
    expect(h.git(["rev-parse", CANONICAL_REF])).toBe(before);
  });

  it('"note" refuses an addition INTO the sources/ capture namespace', async () => {
    const before = h.git(["rev-parse", CANONICAL_REF]);
    const candidate = buildCandidate(h, (wt) => put(wt, "sources/n.md", "# n\n"));
    await expect(integrateThroughProduction(h, "note", candidate)).rejects.toMatchObject({ code: "broker.capture_scope_violation" });
    expect(h.git(["rev-parse", CANONICAL_REF])).toBe(before);
  });

  it('"sync" refuses a change into the sources/ capture namespace', async () => {
    const before = h.git(["rev-parse", CANONICAL_REF]);
    const candidate = buildCandidate(h, (wt) => put(wt, "sources/s.md", "# s\n"));
    await expect(integrateThroughProduction(h, "sync", candidate)).rejects.toMatchObject({ code: "broker.capture_scope_violation" });
    expect(h.git(["rev-parse", CANONICAL_REF])).toBe(before);
  });

  it('"sync" refuses a non-markdown path', async () => {
    const before = h.git(["rev-parse", CANONICAL_REF]);
    const candidate = buildCandidate(h, (wt) => put(wt, "notes.txt", "not markdown\n"));
    await expect(integrateThroughProduction(h, "sync", candidate)).rejects.toMatchObject({ code: "broker.capture_scope_violation" });
    expect(h.git(["rev-parse", CANONICAL_REF])).toBe(before);
  });

  it('"sync" refuses a TYPECHANGE (T): a note replaced by a symlink is not folded to M', async () => {
    // note-alpha.md exists at canonical (seeded). Replace it with a symlink → git
    // reports a `T` typechange. The normalizing walk would fold T→M (an allowed sync
    // status) and WRONGLY pass; the raw all-reachable inspection keeps T and refuses.
    const before = h.git(["rev-parse", CANONICAL_REF]);
    const candidate = buildCandidate(h, (wt) => {
      rmSync(join(wt, "note-alpha.md"));
      symlinkSync("note-beta.md", join(wt, "note-alpha.md"));
    });
    await expect(integrateThroughProduction(h, "sync", candidate)).rejects.toMatchObject({ code: "broker.capture_scope_violation" });
    expect(h.git(["rev-parse", CANONICAL_REF])).toBe(before);
  });

  it('"sync" refuses a MERGE that smuggles a forbidden change on a reverted side branch (all-reachable, not first-parent)', async () => {
    // The first-parent tip is clean (only `good.md`); the forbidden `sources/smuggled.md`
    // was added and reverted on the merged side branch. A first-parent walk misses it;
    // the broker-equivalent `-m` all-reachable walk catches it and refuses.
    const before = h.git(["rev-parse", CANONICAL_REF]);
    const candidate = buildMergeSmugglingCandidate(h);
    await expect(integrateThroughProduction(h, "sync", candidate)).rejects.toMatchObject({ code: "broker.capture_scope_violation" });
    expect(h.git(["rev-parse", CANONICAL_REF])).toBe(before);
  });
});

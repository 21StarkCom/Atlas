/**
 * `agentic.e2e` (#342, Phase-4 task 4-6) — the model-authored ChangePlan APPLY matrix,
 * driven through the DETERMINISTIC in-process Gemini double (`ATLAS_TEST_MODE=1` +
 * `ATLAS_FAKE_PROVIDER=1`, steered per case by `ATLAS_FAKE_PROVIDER_MODE`), over a REAL
 * git vault + a REAL migrated store.
 *
 * The synthesis apply path (`applySynthesis`, the engine `enrich --apply` drives) runs the
 * v2 mutation order `plan (retrieval-first) → validate → ground → apply → commitPaths(main)
 * → refresh`. The `generatePlan` seam is the PRODUCTION `makeModelPlanGenerator` backed by a
 * REAL `ModelsClient` over `createInProcessInvoker` — so every ChangePlan genuinely comes
 * from the fake `generateObject`, not an injected stub. Retrieval is injected non-empty
 * (legitimate grounding) so the matrix needs no LanceDB index; the model boundary is the
 * surface under test.
 *
 * Exit codes are asserted through the CLI's OWN mapping (`isCliError(e) ? e.exitCode :
 * EXIT.INTERNAL` — byte-for-byte what `runCli`'s `fail()` computes), so `exitCodeFor(err)`
 * is the exact process code the command would return.
 *
 * The FIVE cases (each failure asserts the no-forbidden-mutation trinity — HEAD sha
 * byte-unchanged, commit count unchanged, projection row unchanged, refresh seam never
 * invoked):
 *   1. VALID grounded plan          ⇒ exactly ONE touched-paths-only commit, HEAD advanced,
 *                                      projection-refresh ran, exit 0.
 *   2. MALFORMED provider response  ⇒ ProviderCallError (unparseable) ⇒ exit 4, NO mutation.
 *   3. SCHEMA-INVALID plan          ⇒ Zod-valid, validator-rejected (reserved op) ⇒ exit 1.
 *   4. GROUNDING-FAILED plan        ⇒ unknown target, grounding rejects ⇒ exit 1, NO mutation.
 *   5. PROVIDER error/timeout       ⇒ ProviderCallError from transmit ⇒ exit 4, NO commit.
 *
 * Together they prove mutation NEVER precedes validation + grounding and NEVER follows a
 * provider failure.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { openStore, type Store } from "@atlas/sqlite-store";
import { openRepo, type Repo } from "@atlas/git";
import { ModelsClient, createInProcessInvoker, type ModelCallReceipt } from "@atlas/models";
import { newRunId, type ParsedNote } from "@atlas/contracts";
import { isCliError, EXIT } from "../src/errors/envelope.js";
import { splitFrontmatter } from "../src/markdown/parse.js";
import { buildSectionTree } from "../src/markdown/sections.js";
import type { ValidationVault } from "../src/validation/index.js";
import { applySynthesis, type SynthesisApplyDeps } from "../src/workflows/synthesis.js";
import { makeModelPlanGenerator, PLAN_GENERATION_MAX_TOKENS } from "../src/workflows/model-plan-generator.js";
import type { RetrievalResult } from "../src/retrieval/layers.js";
import type { RunContext } from "../src/handlers.js";

const gitEnv = (): NodeJS.ProcessEnv => ({
  ...process.env,
  GIT_AUTHOR_NAME: "Aryeh Stark",
  GIT_AUTHOR_EMAIL: "aryeh@21stark.com",
  GIT_COMMITTER_NAME: "Aryeh Stark",
  GIT_COMMITTER_EMAIL: "aryeh@21stark.com",
});

const ALPHA_PATH = "note-alpha.md";
const ALPHA_ID = "concept-alpha";
const ALPHA_RAW = [
  "---",
  "id: concept-alpha",
  "title: Alpha",
  "type: concept",
  "status: active",
  "schema_version: 1",
  "created: 2026-07-14",
  "updated: 2026-07-14",
  "---",
  "# Alpha",
  "The alpha note.",
  "",
].join("\n");
/** The `sha256:`-prefixed content hash the mutation order's dirty-check computes (bytes of the file). */
const ALPHA_HASH = `sha256:${createHash("sha256").update(ALPHA_RAW, "utf8").digest("hex")}`;

/** The env that activates the gated in-process fake double, steered to `mode`. */
function fakeEnv(mode: "valid" | "malformed" | "schema-invalid" | "error"): NodeJS.ProcessEnv {
  return { ATLAS_TEST_MODE: "1", ATLAS_FAKE_PROVIDER: "1", ATLAS_FAKE_PROVIDER_MODE: mode };
}

/** The exact process exit code `runCli`'s `fail()` maps a thrown error to. */
function exitCodeFor(e: unknown): number {
  return isCliError(e) ? e.exitCode : EXIT.INTERNAL;
}

function alphaNote(raw: string): ParsedNote {
  const { body } = splitFrontmatter(raw);
  return {
    id: ALPHA_ID, path: ALPHA_PATH, type: "concept", schemaVersion: 1, title: "Alpha", status: "active",
    created: "2026-07-14", updated: "2026-07-14", aliases: [], sources: [], declaredSensitivity: "internal",
    links: [], relationships: [], sections: buildSectionTree(body), contentHash: ALPHA_HASH, raw,
  };
}

function retrievalResult(): RetrievalResult {
  const item = {
    noteId: ALPHA_ID, sectionPath: "Alpha", score: 1,
    contributions: [{ layer: "vector", rank: 0, weightedContribution: 1 }],
    sensitivity: "internal", trust: "verified", sections: [{ sectionPath: "Alpha", text: "The alpha note." }],
  } as RetrievalResult["items"][number];
  // A REAL ULID: the model invoker validates `runId` at its boundary (the plan generator
  // binds the transmission to this retrieval id), so a non-ULID would be rejected as a
  // `validation` error BEFORE the per-case steering runs.
  return { items: [item], layersUsed: ["vector"], retrievalRunId: newRunId(), mode: "vector", degraded: false };
}

/** hasNoteId is fail-closed on identity here: only ALPHA_ID exists (drives case 4). */
function vault(): ValidationVault {
  return { hasNoteId: (id) => id === ALPHA_ID, identityOwners: () => [], hasSourceRef: () => true };
}

interface Fix {
  dir: string;
  repo: Repo;
  store: Store;
  ctx: RunContext;
  git(args: string[]): string;
  head(): string;
  commitCount(): number;
  changedFiles(): string[];
  projectionHash(): string | undefined;
  refreshed: { index: string[]; projection: string[] };
}

let fix: Fix;

beforeEach(() => {
  const dir = mkdtempSync(join("/tmp", "atlas-agentic-e2e-"));
  const git = (args: string[]): string => execFileSync("git", args, { cwd: dir, encoding: "utf8", env: gitEnv() }).trim();
  git(["init", "-q", "-b", "main"]);
  git(["config", "commit.gpgsign", "false"]);
  writeFileSync(join(dir, ALPHA_PATH), ALPHA_RAW, "utf8");
  git(["add", "-A"]);
  git(["commit", "-q", "-m", "seed"]);

  const store = openStore({ path: ":memory:" });
  store.migrate();
  // Seed a projection row for the target so "no projection row change" is a REAL
  // assertion on the failure paths (its content_hash must stay byte-identical).
  store.projections.insertNote({
    note_id: ALPHA_ID, slug: "note-alpha", title: "Alpha", type: "concept", schema_version: 1,
    status: "active", file_path: ALPHA_PATH, content_hash: ALPHA_HASH, created: "2026-07-14", updated: "2026-07-14",
  });

  const ctx = { env: {}, withLock: (_s: unknown, fn: () => unknown) => fn() } as unknown as RunContext;
  const refreshed = { index: [] as string[], projection: [] as string[] };
  fix = {
    dir, repo: openRepo(dir), store, ctx, git, refreshed,
    head: () => git(["rev-parse", "HEAD"]),
    commitCount: () => Number(git(["rev-list", "--count", "HEAD"])),
    changedFiles: () => git(["diff-tree", "--no-commit-id", "--name-only", "-r", "HEAD"]).split("\n").filter(Boolean),
    projectionHash: () => store.projections.getNote(ALPHA_ID)?.content_hash,
  };
});

afterEach(() => {
  try { fix.store.close(); } catch { /* ignore */ }
  rmSync(fix.dir, { recursive: true, force: true });
});

/**
 * Build the synthesis apply deps with `generatePlan` backed by the REAL model client
 * over the steered in-process fake double. `target` is the workflow target (an unknown
 * id drives the grounding-failed case). Records refresh-seam invocations.
 */
function applyDeps(
  mode: "valid" | "malformed" | "schema-invalid" | "error",
  receipts: ModelCallReceipt[],
): SynthesisApplyDeps {
  const models = new ModelsClient(createInProcessInvoker({ env: fakeEnv(mode) }), (r) => { receipts.push(r); });
  const generatePlan = makeModelPlanGenerator({ models, model: "gemini-3.5-flash", maxTokens: PLAN_GENERATION_MAX_TOKENS });
  return {
    retrieve: async () => retrievalResult(),
    generatePlan,
    readNote: (id) => (id === ALPHA_ID ? alphaNote(readFileSync(join(fix.dir, ALPHA_PATH), "utf8")) : null),
    validationVault: vault(),
    supportingEvidenceStates: () => [],
    config: { packBudgetTokens: 4000, requireSourcesForSynthesis: false },
    ctx: fix.ctx,
    repo: fix.repo,
    store: fix.store,
    vaultPath: fix.dir,
    refreshIndex: async (noteId) => { fix.refreshed.index.push(noteId); },
    refreshProjection: async (noteId) => { fix.refreshed.projection.push(noteId); },
    now: () => "2026-07-14T00:00:00.000Z",
  };
}

/**
 * A byte-fingerprint of the vault working tree: the sha256 of the note file (a sentinel if
 * it is absent) plus the full porcelain status (untracked / modified / staged / deleted).
 * HEAD + commit-count + projection cannot see a PRE-COMMIT leak — a file the apply step
 * materializes to the tree before a validation/provider failure throws (e.g. a future op
 * executor writing OUTSIDE `grounded.touchedPaths`, which `capturePreimage` would not
 * restore). This catches it: a leaked/modified/deleted file changes the fingerprint even
 * though no commit ever landed.
 */
function worktreeFingerprint(): string {
  const alpha = existsSync(join(fix.dir, ALPHA_PATH))
    ? createHash("sha256").update(readFileSync(join(fix.dir, ALPHA_PATH), "utf8"), "utf8").digest("hex")
    : "<absent>";
  return `${alpha}\n${fix.git(["status", "--porcelain", "--untracked-files=all"])}`;
}

/** Assert NOTHING mutated: HEAD sha, commit count, projection row, WORKING-TREE bytes, and refresh seams. */
function expectNoMutation(before: { head: string; count: number; hash: string | undefined; worktree: string }): void {
  expect(fix.head()).toBe(before.head);                 // HEAD byte-unchanged
  expect(fix.commitCount()).toBe(before.count);         // no new commit on refs/heads/main
  expect(fix.projectionHash()).toBe(before.hash);       // no projection row change
  expect(worktreeFingerprint()).toBe(before.worktree);  // no working-tree leak (a pre-commit file write/modify/delete)
  expect(fix.refreshed.index).toEqual([]);              // refresh seams never reached
  expect(fix.refreshed.projection).toEqual([]);
}

describe("agentic apply matrix (#342 — model-authored ChangePlan through the deterministic double)", () => {
  it("case 1: a VALID grounded plan ⇒ exactly ONE touched-paths-only commit, HEAD advances, projection refresh runs, exit 0", async () => {
    const before = fix.head();
    const beforeCount = fix.commitCount();
    const receipts: ModelCallReceipt[] = [];

    const result = await applySynthesis("enrich", { target: ALPHA_ID, instruction: "enrich alpha" }, applyDeps("valid", receipts));

    // exit 0 (no throw), one commit on main touching only the note file.
    expect(result.commitSha).toBe(fix.head());
    expect(fix.head()).not.toBe(before);
    expect(fix.commitCount()).toBe(beforeCount + 1);
    expect(fix.changedFiles()).toEqual([ALPHA_PATH]);
    expect(fix.git(["show", `HEAD:${ALPHA_PATH}`])).toContain("Appended by the deterministic fake double");
    // The plan genuinely came from the fake generateObject (one transmission ⇒ one receipt).
    expect(receipts).toHaveLength(1);
    // The post-commit refresh seams ran (index THEN projection) with the landed note.
    expect(fix.refreshed.index).toEqual([ALPHA_ID]);
    expect(fix.refreshed.projection).toEqual([ALPHA_ID]);
  });

  it("case 2: a MALFORMED (unparseable) provider response ⇒ exit 4, NO mutation", async () => {
    const before = { head: fix.head(), count: fix.commitCount(), hash: fix.projectionHash(), worktree: worktreeFingerprint() };
    const receipts: ModelCallReceipt[] = [];
    let thrown: unknown;
    try {
      await applySynthesis("enrich", { target: ALPHA_ID, instruction: "enrich alpha" }, applyDeps("malformed", receipts));
    } catch (e) { thrown = e; }
    expect(thrown, "malformed must fail").toBeDefined();
    expect(exitCodeFor(thrown)).toBe(EXIT.INTERNAL); // 4
    expectNoMutation(before);
  });

  it("case 3: a SCHEMA-INVALID plan (Zod-valid, validator-rejected reserved op) ⇒ exit 1, NO mutation", async () => {
    const before = { head: fix.head(), count: fix.commitCount(), hash: fix.projectionHash(), worktree: worktreeFingerprint() };
    const receipts: ModelCallReceipt[] = [];
    let thrown: unknown;
    try {
      await applySynthesis("enrich", { target: ALPHA_ID, instruction: "enrich alpha" }, applyDeps("schema-invalid", receipts));
    } catch (e) { thrown = e; }
    expect(thrown, "schema-invalid must fail").toBeDefined();
    expect(exitCodeFor(thrown)).toBe(EXIT.VALIDATION); // 1 — the ChangePlan validator rejected it
    // It DID reach the model (the reserved-op plan came from the double), then was rejected
    // before any mutation.
    expect(receipts).toHaveLength(1);
    expectNoMutation(before);
  });

  it("case 4: a GROUNDING-FAILED plan (unknown target) ⇒ exit 1, NO mutation", async () => {
    const before = { head: fix.head(), count: fix.commitCount(), hash: fix.projectionHash(), worktree: worktreeFingerprint() };
    const receipts: ModelCallReceipt[] = [];
    let thrown: unknown;
    try {
      // Valid-mode plan, but the workflow target is a note that does not exist — grounding
      // (note resolution) rejects it after the model produced a clean plan.
      await applySynthesis("enrich", { target: "ghost-note", instruction: "enrich ghost" }, applyDeps("valid", receipts));
    } catch (e) { thrown = e; }
    expect(thrown, "grounding-failed must fail").toBeDefined();
    expect(exitCodeFor(thrown)).toBe(EXIT.VALIDATION); // 1
    expectNoMutation(before);
  });

  it("case 5: a PROVIDER error/timeout (transmit throws ProviderCallError) ⇒ exit 4, NO commit", async () => {
    const before = { head: fix.head(), count: fix.commitCount(), hash: fix.projectionHash(), worktree: worktreeFingerprint() };
    const receipts: ModelCallReceipt[] = [];
    let thrown: unknown;
    try {
      await applySynthesis("enrich", { target: ALPHA_ID, instruction: "enrich alpha" }, applyDeps("error", receipts));
    } catch (e) { thrown = e; }
    expect(thrown, "provider error must fail").toBeDefined();
    expect(exitCodeFor(thrown)).toBe(EXIT.INTERNAL); // 4
    expectNoMutation(before);
  });
});

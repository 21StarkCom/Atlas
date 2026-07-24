/**
 * `synthesis-apply.e2e` — the v2 synthesis apply path (`applySynthesis`) driven through the
 * REAL mutation order over a REAL git vault + a REAL migrated store (task 3-2/3-3b, ADR-0003).
 *
 * The retired trust/risk-tier/scan-gate machinery is GONE: there is no Tier-2/Tier-3 branch,
 * no `review-pending`, no broker CAS, no `GeneratedArtifactGuard`, no exit 6. A validated +
 * grounded plan applies as ONE direct commit onto canonical (`refs/heads/main`) via
 * `runMutation` + `commitPaths`, then refreshes the index + projection. This proves:
 *   - a would-be Tier-3 plan (low confidence) applies DIRECTLY (exit 0, one commit);
 *   - retrieval-first: an empty retrieval aborts BEFORE any run/commit;
 *   - the refresh seams run index-then-projection after the commit;
 *   - a side-effect-free preview touches no sink.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { openStore, type Store } from "@atlas/sqlite-store";
import { openRepo, type Repo } from "@atlas/git";
import type { ChangePlan, ChangePlanOperation, ParsedNote } from "@atlas/contracts";
import type { RetrievalResult } from "../../src/retrieval/layers.js";
import { splitFrontmatter } from "../../src/markdown/parse.js";
import { buildSectionTree, resolveSections } from "../../src/markdown/sections.js";
import { sectionContentHash } from "../../src/markdown/patch.js";
import type { ValidationVault } from "../../src/validation/index.js";
import {
  applySynthesis,
  previewSynthesis,
  RetrievalRequiredError,
  type SynthesisApplyDeps,
} from "../../src/workflows/synthesis.js";
import type { RunContext } from "../../src/handlers.js";

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
  "The alpha note. Links [[concept-beta]].",
  "",
].join("\n");

function alphaNote(raw: string): ParsedNote {
  const { body } = splitFrontmatter(raw);
  return {
    id: ALPHA_ID, path: ALPHA_PATH, type: "concept", schemaVersion: 1, title: "Alpha", status: "active",
    created: "2026-07-14", updated: "2026-07-14", aliases: [], sources: [], declaredSensitivity: "internal",
    links: [], sections: buildSectionTree(body), contentHash: "sha256:0", raw,
  };
}

/** An UpdateSection plan grounded on note-alpha's current `# Alpha` section. */
function updateAlphaPlan(raw: string, newContent: string, over: Partial<ChangePlan> = {}): ChangePlan {
  const { body } = splitFrontmatter(raw);
  const alpha = resolveSections(body).find((s) => s.path === "Alpha")!;
  const hash = sectionContentHash(body.slice(alpha.bodyStart, alpha.bodyEnd));
  const operation: ChangePlanOperation = {
    op: "UpdateSection", opVersion: 1, selector: { path: "Alpha", expectedContentHash: hash }, newContent,
  };
  return {
    target: ALPHA_ID, rationale: "enrich the alpha note", sourceIds: ["src-1"], retrievedEvidence: [],
    confidence: 0.95, proposedRisk: "tier-1", reversibility: "reversible", schemaVersion: 1, operation, ...over,
  } as ChangePlan;
}

function retrievalResult(items: RetrievalResult["items"]): RetrievalResult {
  return { items, layersUsed: ["vector"], retrievalRunId: "ret-1", mode: "vector", degraded: false };
}

function rankedItem(): RetrievalResult["items"][number] {
  return {
    noteId: ALPHA_ID, sectionPath: "Alpha", score: 1,
    contributions: [{ layer: "vector", rank: 0, weightedContribution: 1 }],
    sensitivity: "internal", trust: "verified", sections: [{ sectionPath: "Alpha", text: "The alpha note." }],
  } as RetrievalResult["items"][number];
}

function vault(): ValidationVault {
  return {
    hasNoteId: () => true, identityOwners: () => [], hasSourceRef: () => true,
  };
}

interface Fix {
  dir: string;
  repo: Repo;
  store: Store;
  ctx: RunContext;
  git(args: string[]): string;
  head(): string;
  commitCount(): number;
}

let fix: Fix;

beforeEach(() => {
  const dir = mkdtempSync(join("/tmp", "atlas-synth-apply-"));
  const git = (args: string[]): string => execFileSync("git", args, { cwd: dir, encoding: "utf8", env: gitEnv() }).trim();
  git(["init", "-q", "-b", "main"]);
  git(["config", "commit.gpgsign", "false"]);
  writeFileSync(join(dir, ALPHA_PATH), ALPHA_RAW, "utf8");
  writeFileSync(join(dir, "note-beta.md"), ["---", "id: concept-beta", "title: Beta", "type: concept", "status: active", "schema_version: 1", "created: 2026-07-14", "updated: 2026-07-14", "---", "# Beta", "The beta note.", ""].join("\n"), "utf8");
  git(["add", "-A"]);
  git(["commit", "-q", "-m", "seed"]);
  const store = openStore({ path: ":memory:" });
  store.migrate();
  const ctx = { env: {}, withLock: (_s: unknown, fn: () => unknown) => fn() } as unknown as RunContext;
  fix = {
    dir, repo: openRepo(dir), store, ctx, git,
    head: () => git(["rev-parse", "HEAD"]),
    commitCount: () => Number(git(["rev-list", "--count", "HEAD"])),
  };
});

afterEach(() => {
  try { fix.store.close(); } catch { /* ignore */ }
  rmSync(fix.dir, { recursive: true, force: true });
});

function applyDeps(plan: ChangePlan, over: Partial<SynthesisApplyDeps> = {}): SynthesisApplyDeps {
  const raw = readFileSync(join(fix.dir, ALPHA_PATH), "utf8");
  return {
    retrieve: async () => retrievalResult([rankedItem()]),
    generatePlan: async () => plan,
    readNote: () => alphaNote(raw),
    validationVault: vault(),
    supportingEvidenceStates: () => [],
    config: { packBudgetTokens: 4000, requireSourcesForSynthesis: false },
    ctx: fix.ctx,
    repo: fix.repo,
    store: fix.store,
    vaultPath: fix.dir,
    now: () => "2026-07-14T00:00:00.000Z",
    ...over,
  };
}

describe("synthesis apply (v2 direct commit, ADR-0003)", () => {
  it("applies a clean plan directly to canonical as ONE commit + finalizes (no tier gate)", async () => {
    const before = fix.head();
    const beforeCount = fix.commitCount();
    const raw = readFileSync(join(fix.dir, ALPHA_PATH), "utf8");
    const plan = updateAlphaPlan(raw, "The alpha note, enriched. Links [[concept-beta]].\n");

    const result = await applySynthesis("enrich", { target: ALPHA_ID, instruction: "enrich alpha" }, applyDeps(plan));

    // Canonical advanced to the direct commit; the note change is on the canonical tree.
    expect(result.commitSha).toBe(fix.head());
    expect(fix.head()).not.toBe(before);
    expect(fix.commitCount()).toBe(beforeCount + 1);
    expect(fix.git(["show", `HEAD:${ALPHA_PATH}`])).toContain("enriched");

    // The result is a direct-integration result — no `mode`, no `review-pending`, no `tier`.
    expect((result as Record<string, unknown>).mode).toBeUndefined();
    expect((result as Record<string, unknown>).tier).toBeUndefined();
    expect(result.plan.report.ok).toBe(true);
    // No agent_runs / review-pending row — the direct path never writes that ledger.
    const runs = fix.store.db.prepare(`SELECT COUNT(*) AS n FROM agent_runs`).get() as { n: number };
    expect(runs.n).toBe(0);
  });

  it("a would-be Tier-3 plan (low confidence, irreversible) applies DIRECTLY — never exit 6", async () => {
    const beforeCount = fix.commitCount();
    const raw = readFileSync(join(fix.dir, ALPHA_PATH), "utf8");
    const plan = updateAlphaPlan(raw, "The alpha note, rewritten wholesale.\n", { confidence: 0.05, reversibility: "irreversible" });

    const result = await applySynthesis("maintain", { target: ALPHA_ID, instruction: "rewrite alpha" }, applyDeps(plan));

    expect(result.commitSha).toBe(fix.head());
    expect(fix.commitCount()).toBe(beforeCount + 1);
    expect(fix.git(["show", `HEAD:${ALPHA_PATH}`])).toContain("rewritten wholesale");
  });

  it("runs the refresh seams (index THEN projection) with the landed commit sha", async () => {
    const raw = readFileSync(join(fix.dir, ALPHA_PATH), "utf8");
    const plan = updateAlphaPlan(raw, "Enriched again.\n");
    const order: string[] = [];
    let indexSha = "", projSha = "";
    const result = await applySynthesis("enrich", { target: ALPHA_ID, instruction: "enrich alpha" }, applyDeps(plan, {
      refreshIndex: async (noteId, sha) => { order.push("index"); indexSha = sha; expect(noteId).toBe(ALPHA_ID); },
      refreshProjection: async (noteId, sha) => { order.push("projection"); projSha = sha; expect(noteId).toBe(ALPHA_ID); },
    }));
    expect(order).toEqual(["index", "projection"]); // index-then-projection
    expect(indexSha).toBe(result.commitSha);
    expect(projSha).toBe(result.commitSha);
  });

  it("retrieval-first: an empty retrieval aborts before any run / plan / commit", async () => {
    const before = fix.head();
    const beforeCount = fix.commitCount();
    const raw = readFileSync(join(fix.dir, ALPHA_PATH), "utf8");
    const plan = updateAlphaPlan(raw, "never applied\n");
    await expect(
      applySynthesis("enrich", { target: ALPHA_ID, instruction: "enrich alpha" }, applyDeps(plan, { retrieve: async () => retrievalResult([]) })),
    ).rejects.toBeInstanceOf(RetrievalRequiredError);
    // Nothing committed.
    expect(fix.head()).toBe(before);
    expect(fix.commitCount()).toBe(beforeCount);
  });

  it("preview is side-effect-free (canonical unmoved, no commit)", async () => {
    const before = fix.head();
    const beforeCount = fix.commitCount();
    const raw = readFileSync(join(fix.dir, ALPHA_PATH), "utf8");
    const plan = updateAlphaPlan(raw, "previewed only\n");
    const preview = await previewSynthesis("enrich", { target: ALPHA_ID, instruction: "enrich alpha" }, applyDeps(plan));
    expect(preview.mode).toBe("preview");
    expect(preview.plan.changePlan.operation.op).toBe("UpdateSection");
    expect(fix.head()).toBe(before);
    expect(fix.commitCount()).toBe(beforeCount);
  });
});

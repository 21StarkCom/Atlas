/**
 * synthesis.no-tier.test.ts (task 3-2, ADR-0003) — the ACCEPTANCE proof that the
 * trust/risk-tier/review-pending machinery is GONE from the synthesis apply path.
 *
 * A ChangePlan that under the OLD rules would have routed to Tier-3 (low confidence /
 * "untrusted-derived" / a large destructive edit) now applies DIRECTLY through the v2
 * mutation order (`applySynthesis` → `runMutation` → `commitPaths`): exit 0, exactly
 * ONE commit onto canonical (`refs/heads/main`), NEVER exit 6, and NO review-pending
 * run state (the ledger's `agent_runs` table is never touched by the direct path).
 *
 * Modelled on `mutation-order.restoration.test.ts`: a REAL git vault + a REAL migrated
 * store, driven directly against `applySynthesis` — no broker, no phase-2 harness.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { openStore, type Store } from "@atlas/sqlite-store";
import { openRepo, type Repo } from "@atlas/git";
import type { ChangePlan, ChangePlanOperation, ParsedNote } from "@atlas/contracts";
import type { RetrievalResult } from "../src/retrieval/layers.js";
import { splitFrontmatter } from "../src/markdown/parse.js";
import { buildSectionTree, resolveSections } from "../src/markdown/sections.js";
import { sectionContentHash } from "../src/markdown/patch.js";
import type { ValidationVault } from "../src/validation/index.js";
import { applySynthesis, type SynthesisApplyDeps } from "../src/workflows/synthesis.js";
import { EXIT } from "../src/errors/envelope.js";
import type { RunContext } from "../src/handlers.js";

const gitEnv = (): NodeJS.ProcessEnv => ({
  ...process.env,
  GIT_AUTHOR_NAME: "Aryeh Stark",
  GIT_AUTHOR_EMAIL: "aryeh@21stark.com",
  GIT_COMMITTER_NAME: "Aryeh Stark",
  GIT_COMMITTER_EMAIL: "aryeh@21stark.com",
});

const NOTE_PATH = "note-a.md";
const NOTE_ID = "note-a";
const NOTE_RAW = [
  "---",
  "id: note-a",
  "type: concept",
  "title: Alpha",
  "status: active",
  "created: 2026-07-14",
  "updated: 2026-07-14",
  "---",
  "# Overview",
  "",
  "Intro paragraph.",
  "",
  "## Goals",
  "",
  "- goal one",
  "",
].join("\n");

function noteFrom(raw: string): ParsedNote {
  const { body } = splitFrontmatter(raw);
  return {
    id: NOTE_ID, path: NOTE_PATH, type: "concept", schemaVersion: 1, title: "Alpha", status: "active",
    created: "2026-07-14", updated: "2026-07-14", aliases: [], sources: [], declaredSensitivity: "internal",
    links: [], sections: buildSectionTree(body), contentHash: "sha256:0", raw,
  };
}

function retrievalResult(): RetrievalResult {
  return {
    items: [{
      noteId: NOTE_ID, sectionPath: "Overview/Goals", score: 1,
      contributions: [{ layer: "vector", rank: 0, weightedContribution: 1 }],
      sensitivity: "internal", trust: "verified", sections: [{ sectionPath: "Overview/Goals", text: "- goal one" }],
    }] as RetrievalResult["items"],
    layersUsed: ["vector"], retrievalRunId: "ret-1", mode: "vector", degraded: false,
  };
}

function vault(): ValidationVault {
  return {
    hasNoteId: () => true, identityOwners: () => [], hasSourceRef: () => true,
  };
}

/** An UpdateSection plan grounded on the fixture's Goals body, parameterizable by confidence + size. */
function updateGoalsPlan(raw: string, newContent: string, over: Partial<ChangePlan> = {}): ChangePlan {
  const { body } = splitFrontmatter(raw);
  const goals = resolveSections(body).find((s) => s.path === "Overview/Goals")!;
  const hash = sectionContentHash(body.slice(goals.bodyStart, goals.bodyEnd));
  const operation: ChangePlanOperation = {
    op: "UpdateSection", opVersion: 1, selector: { path: "Overview/Goals", expectedContentHash: hash }, newContent,
  };
  return {
    target: NOTE_ID, rationale: "enrich goals", sourceIds: ["src-1"], retrievedEvidence: [],
    confidence: 0.95, proposedRisk: "tier-1", reversibility: "reversible", schemaVersion: 1, operation, ...over,
  } as ChangePlan;
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
  const dir = mkdtempSync(join("/tmp", "atlas-no-tier-"));
  const git = (args: string[]): string => execFileSync("git", args, { cwd: dir, encoding: "utf8", env: gitEnv() }).trim();
  git(["init", "-q", "-b", "main"]);
  git(["config", "commit.gpgsign", "false"]);
  writeFileSync(join(dir, NOTE_PATH), NOTE_RAW, "utf8");
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

function applyDeps(plan: ChangePlan): SynthesisApplyDeps {
  const raw = readFileSync(join(fix.dir, NOTE_PATH), "utf8");
  return {
    retrieve: async () => retrievalResult(),
    generatePlan: async () => plan,
    readNote: () => noteFrom(raw),
    validationVault: vault(),
    supportingEvidenceStates: () => [],
    config: { packBudgetTokens: 4000, requireSourcesForSynthesis: false },
    ctx: fix.ctx,
    repo: fix.repo,
    store: fix.store,
    vaultPath: fix.dir,
    now: () => "2026-07-14T00:00:00.000Z",
  };
}

describe("synthesis apply: no tier gate, no review-pending (ADR-0003)", () => {
  it("EXIT has no secret-scan(3) or action-required(6) code", () => {
    expect(EXIT).toEqual({ OK: 0, VALIDATION: 1, CONFIG: 2, INTERNAL: 4, USAGE: 5 });
  });

  it("a low-confidence plan (would-be Tier-3) applies DIRECTLY: one commit on canonical, no review-pending", async () => {
    const before = fix.head();
    const beforeCount = fix.commitCount();
    const raw = readFileSync(join(fix.dir, NOTE_PATH), "utf8");
    // Low confidence + not-reversible: under the retired rules this routes to Tier-3.
    const plan = updateGoalsPlan(raw, "- goal one\n- goal two\n", { confidence: 0.1, reversibility: "irreversible" });

    const res = await applySynthesis("enrich", { target: NOTE_ID, instruction: "enrich goals" }, applyDeps(plan));

    // The result is a direct-integration result — no `mode`, no `review-pending`, no `tier`.
    expect(res.commitSha).toMatch(/^[0-9a-f]{40}$/);
    expect(res.commitSha).toBe(fix.head());
    expect((res as Record<string, unknown>).mode).toBeUndefined();
    expect((res as Record<string, unknown>).tier).toBeUndefined();
    expect((res as Record<string, unknown>).agentRef).toBeUndefined();
    expect(res.plan.report.ok).toBe(true);

    // Exactly ONE new commit landed on canonical (`refs/heads/main` == HEAD).
    expect(fix.head()).not.toBe(before);
    expect(fix.commitCount()).toBe(beforeCount + 1);
    expect(fix.git(["show", `HEAD:${NOTE_PATH}`])).toContain("goal two");

    // NO review-pending run state — the direct path never writes the agent_runs ledger.
    const runs = fix.store.db.prepare(`SELECT COUNT(*) AS n FROM agent_runs`).get() as { n: number };
    expect(runs.n).toBe(0);
    const pending = fix.store.db.prepare(`SELECT COUNT(*) AS n FROM agent_runs WHERE status = 'review-pending'`).get() as { n: number };
    expect(pending.n).toBe(0);
  });

  it("a large edit (would exceed the retired changed-lines bound) also applies directly as ONE commit", async () => {
    const beforeCount = fix.commitCount();
    const raw = readFileSync(join(fix.dir, NOTE_PATH), "utf8");
    const big = Array.from({ length: 80 }, (_, i) => `- goal ${i}`).join("\n") + "\n";
    const plan = updateGoalsPlan(raw, big, { confidence: 0.2 });

    const res = await applySynthesis("maintain", { target: NOTE_ID, instruction: "many goals" }, applyDeps(plan));

    expect(res.commitSha).toBe(fix.head());
    expect(fix.commitCount()).toBe(beforeCount + 1);
    expect(fix.git(["show", `HEAD:${NOTE_PATH}`])).toContain("- goal 79");
    const runs = fix.store.db.prepare(`SELECT COUNT(*) AS n FROM agent_runs`).get() as { n: number };
    expect(runs.n).toBe(0);
  });
});

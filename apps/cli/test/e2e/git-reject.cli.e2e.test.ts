/**
 * `git-reject.cli.e2e` (Task 4.9) — `brain git reject <runId>` terminates a Tier-3 review-pending
 * run (`rejected`, `run.rejected`) and retains the agent commit for the audit trail; canonical is
 * never touched. Validated against `git-reject.schema.json`.
 */
import { writeFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ChangePlan, ChangePlanOperation, ParsedNote } from "@atlas/contracts";
import { GeneratedArtifactGuard, type QuarantineSink } from "@atlas/scan";
import { BrokerClient } from "@atlas/broker";
import _Ajv2020 from "ajv/dist/2020.js";
import { runCli } from "../../src/main.js";
import type { RetrievalResult } from "../../src/retrieval/layers.js";
import { splitFrontmatter } from "../../src/markdown/parse.js";
import { buildSectionTree, resolveSections } from "../../src/markdown/sections.js";
import { sectionContentHash } from "../../src/markdown/patch.js";
import { riskConfigFrom } from "../../src/policies/risk.js";
import type { ValidationVault } from "../../src/validation/index.js";
import type { IntegrationContext, RunIntegrator } from "../../src/workflows/index.js";
import { applySynthesis, type SynthesisApplyDeps } from "../../src/workflows/synthesis.js";
import { makePhase2Harness, CANONICAL_REF, type Phase2Harness } from "./phase2-support.js";

const REPO_ROOT = join(import.meta.dirname, "..", "..", "..", "..");
const RISK = riskConfigFrom({ tier2_min_confidence: 0.8, tier2_max_changed_lines: 50, tier2_max_sections: 3 });
const ALPHA_ID = "concept-alpha";
const Ajv = ((_Ajv2020 as unknown as { default?: unknown }).default ?? _Ajv2020) as new (o?: unknown) => { compile: (s: unknown) => ((v: unknown) => boolean) & { errors?: unknown }; errorsText: (e?: unknown) => string };
function validateSchema(name: string, value: unknown): void {
  const ajv = new Ajv({ strict: false, allErrors: true });
  const v = ajv.compile(JSON.parse(readFileSync(join(REPO_ROOT, "docs/specs/cli-contract", `${name}.schema.json`), "utf8")));
  if (!v(value)) throw new Error(`${name}: ${ajv.errorsText(v.errors)}\n${JSON.stringify(value)}`);
}

class Q implements QuarantineSink { quarantine(): Promise<void> { return Promise.resolve(); } }
function alphaNote(h: Phase2Harness): ParsedNote {
  const raw = readFileSync(join(h.vaultDir, "note-alpha.md"), "utf8").replace(/\r\n/g, "\n");
  const { body } = splitFrontmatter(raw);
  return { id: ALPHA_ID, path: "note-alpha.md", type: "concept", schemaVersion: 1, title: "Alpha", status: "active", created: "2026-07-14", updated: "2026-07-14", aliases: [], sources: [], declaredSensitivity: "internal", links: [], sections: buildSectionTree(body), contentHash: "sha256:0", raw };
}
function plan(h: Phase2Harness): ChangePlan {
  const { body } = splitFrontmatter(alphaNote(h).raw);
  const alpha = resolveSections(body).find((s) => s.path === "Alpha")!;
  const op: ChangePlanOperation = { op: "UpdateSection", opVersion: 1, selector: { path: "Alpha", expectedContentHash: sectionContentHash(body.slice(alpha.bodyStart, alpha.bodyEnd)) }, newContent: "Enriched.\n" };
  return { target: ALPHA_ID, rationale: "enrich", sourceIds: ["s"], retrievedEvidence: [], confidence: 0.95, proposedRisk: "tier-1", reversibility: "reversible", schemaVersion: 1, operation: op } as ChangePlan;
}
function retrieval(): RetrievalResult {
  return { items: [{ noteId: ALPHA_ID, sectionPath: "Alpha", score: 1, contributions: [{ layer: "vector", rank: 0, weightedContribution: 1 }], sensitivity: "internal", trust: "verified", sections: [{ sectionPath: "Alpha", text: "t" }] }] as RetrievalResult["items"], layersUsed: ["vector"], retrievalRunId: "r", mode: "vector", degraded: false };
}
function vault(): ValidationVault {
  return { hasNoteId: () => true, identityOwners: () => [], hasSourceRef: () => true, hasClaimKey: () => true, hasEvidenceLineage: () => true, hasEvidenceId: () => true, attachWouldDuplicate: () => false };
}
function noopIntegrator(): RunIntegrator { return async (_c: IntegrationContext) => { throw new Error("Tier-3"); }; }

let h: Phase2Harness, cwd: string, env: NodeJS.ProcessEnv;
async function cli(argv: string[]): Promise<{ code: number; out: string }> {
  let out = "";
  const ro = process.stdout.write.bind(process.stdout), re = process.stderr.write.bind(process.stderr);
  (process.stdout as unknown as { write: (s: string) => boolean }).write = (s: string) => ((out += s), true);
  (process.stderr as unknown as { write: (s: string) => boolean }).write = () => true;
  try { return { code: await runCli(argv, env, { cwd, root: REPO_ROOT }), out }; }
  finally { process.stdout.write = ro; process.stderr.write = re; }
}

beforeEach(async () => {
  h = await makePhase2Harness();
  cwd = h.root;
  writeFileSync(join(h.root, "brain.config.yaml"), [
    "vault:", `  path: ${h.vaultDir}`, "sqlite:", `  path: ${h.dbPath}`, "  ledger_backup:", `    dir: ${join(h.root, ".atlas", "backups")}`, "    key_id: test-key-v1", "    keep: 10",
    "lancedb:", `  dir: ${join(h.root, ".atlas", "lancedb")}`, "indexing:", "  chunker_version: 1", "  embedding_model: gemini-embedding-001", "  dimensions: 768",
    "git:", `  worktrees_path: ${h.worktreesPath}`, `  audit_anchor_path: ${h.anchorPath}`, "models: {}", "policies: {}",
    "logs:", `  dir: ${join(h.root, ".atlas", "logs")}`, "broker:", `  socket_path: ${h.socketPath}`, `  egress_socket_path: ${join(h.root, "e.sock")}`, "",
  ].join("\n"), "utf8");
  env = { ...process.env, NO_COLOR: "1", ATLAS_TEST_MODE: "1", ATLAS_CUSTODY_TEST_DIR: join(h.root, ".atlas", "custody") };
});
afterEach(async () => { await h.cleanup(); });

async function makeReviewPending(): Promise<{ runId: string; commitSha: string }> {
  const client = await BrokerClient.connect(h.socketPath);
  const store = h.openStore();
  try {
    const deps: SynthesisApplyDeps = {
      retrieve: async () => retrieval(), generatePlan: async () => plan(h), readNote: () => alphaNote(h), validationVault: vault(),
      supportingEvidenceStates: () => [], evidenceValid: () => true, inputsTrusted: () => false,
      config: { packBudgetTokens: 4000, requireSourcesForSynthesis: true, risk: RISK },
      store, broker: client, backup: h.backup, repo: h.repo(), integrate: noopIntegrator(),
      guard: new GeneratedArtifactGuard(new Q()), foldProjections: async () => {}, worktreesPath: h.worktreesPath, canonicalRef: CANONICAL_REF, now: () => "2026-07-14T00:00:00.000Z",
    };
    const res = await applySynthesis("enrich", { target: ALPHA_ID, instruction: "x" }, deps);
    return { runId: res.runId, commitSha: res.commitSha };
  } finally { store.close(); client.close(); }
}

describe("brain git reject", () => {
  it("rejects a review-pending run, retaining the agent commit; canonical untouched", async () => {
    const before = h.git(["rev-parse", CANONICAL_REF]);
    const { runId, commitSha } = await makeReviewPending();
    const r = await cli(["git", "reject", runId, "--json"]);
    expect(r.code, r.out).toBe(0);
    const out = JSON.parse(r.out);
    validateSchema("git-reject", out);
    expect(out.state).toBe("rejected");
    expect(out.retainedCommit).toBe(commitSha);
    expect(h.git(["rev-parse", CANONICAL_REF])).toBe(before); // canonical untouched
    const store = h.openStore();
    try {
      const row = store.db.prepare(`SELECT status FROM agent_runs WHERE run_id = ?`).get(runId) as { status: string };
      expect(row.status).toBe("rejected");
    } finally { store.close(); }
  });

  it("errors on a non-review-pending run (exit 1)", async () => {
    const r = await cli(["git", "reject", "01J9Z8Q000000000000UNKNOWN0", "--json"]);
    expect(r.code).toBe(1);
  });
});

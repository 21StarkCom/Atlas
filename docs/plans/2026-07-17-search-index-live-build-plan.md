# Search Index — Full-Corpus Live Build + Eval Gate Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the retrieval index over the **full** graduated real-vault corpus (~206 notes, all 11 types) and prove it against the graduation retrieval gate — recall@10 ≥ 0.85 AND MRR ≥ 0.7 — via a new operator surface (`brain index eval`), a real-corpus labeled eval set, and a live re-drive of graduation → `db rebuild` → `index rebuild` → eval on a fresh main-vault copy.

**Architecture:** All Phase-3 retrieval machinery already exists and has run live once (2026-07-16 drive: a real LanceDB index over the 32 notes V1's closed type set graduated). The open type system (#151/#152/#153) since made graduation a total function over the whole taxonomy. What is missing is (a) an **operator-grade eval vehicle** — today `runRetrievalEval` is reachable only from vitest, pinned to the repo fixture set, shelling `brain query` once per query (one audit event + one strict backup per query); (b) a **real-corpus eval set**; and (c) the **live full-corpus drive** itself. This plan adds `brain index eval` (a registered Tier-0 read command over the existing `makeRetrieveSeam`, one audit event per eval run), re-homes the pure eval harness into `@atlas/lancedb-index` so production code can import it, authors the graduation eval set in the **vault** (it references personal corpus content — it does not belong in the engine repo), and finishes with the operational runbook.

**Tech Stack:** TypeScript (strict/ESM/NodeNext), Node ≥ 24, pnpm, vitest, LanceDB, Gemini `gemini-embedding-001` (768-dim, D7) through the egress broker.

## Global Constraints

- TypeScript strict / ESM / NodeNext; compile per package with `../../node_modules/.bin/tsc -p tsconfig.json`; run tests with `npx vitest run` from the package dir.
- Commits authored `Aryeh Stark <aryeh@21stark.com>` (per-repo git config already set — verify with `git config user.email` before the first commit).
- Branch + PR for everything; every review finding lands on the PR; merge to `main` once CI is green (no canary).
- Exit codes unchanged: `0` ok · `1` validation · `2` config/vault · `3` secret-scan · `4` internal · `5` usage · `6` action-required.
- The CLI-contract harness gates the command surface: registry row + fixture line + schema, then `pnpm run contract:write`; `tools/contract-lint.test.ts` must stay green.
- Retrieval constants stay **config/contract-owned** (`retrieval-index-contract.md` §5/§8): never inline `60`, RRF weights, layer precedence, or the thresholds `0.85`/`0.7` outside the places this plan names.
- **The live main-vault is never touched.** Every live step operates on a fresh copy under a new drive root; assert `git -C ~/Code/Vaults/main-vault rev-parse HEAD` unchanged across the whole drive (V1 acceptance, #60).
- Privileged graduation apply uses the **production authorizer** (D20) — operator-signed challenge, never the test signer.

**Contracts consumed:** `docs/specs/retrieval-index-contract.md` (chunking, generations, reconciliation, RRF), `docs/specs/acceptance-thresholds.md` §retrieval (0.85/0.7). **Issues:** #151 (acceptance re-drive), #60 (the "derived-state rebuild" + "retrieval eval" slices — the workflow/purge/scale-bench slices stay in #60).

---

## Context — the 2026-07-17 reckon

Where the search index actually stands (verified against code + the 07-16 drive artifacts):

- **Engine: complete, merged, exercised.** `@atlas/lancedb-index` (schema, deterministic chunker v1, generation identity + double-fenced SQLite CAS activation, embed/write/verify-complete/activate/retire, staleness, hybrid FTS+vector search with RRF fusion and the §6 FTS-maturity degradation), `apps/cli` retrieval module + `query` + `index status|verify|repair|rebuild` (all `implemented: true`), egress-brokered embeddings (`atlas-egress` is the sole credential holder; embed is a first-class egress operation with pricing + budget).
- **Live proof at 15% scale.** The 2026-07-16 production drive (`~/Code/Vaults/atlas-graduation-2026-07-16/`) graduated 32/206 notes under V1's closed 5-type set, built a real LanceDB index over them (real Gemini embeddings), and ran `brain query` — which could not answer team/repo/meeting questions because 122 notes were (correctly) refused as unknown-type.
- **The blocker was removed.** The open type system (#151 spec + plan; landed #152, fix #153) makes graduation a total function over the vault's 11-type taxonomy: unknown-type/schema-version refusals removed, identity collisions disambiguated, unresolved links flattened, credential paths excluded in-run. Near-zero refusals expected on a re-run.
- **Never done:** a full-corpus index build, a real-corpus eval, or the #60 rebuild/eval slices. The only live-eval vehicle is an opt-in vitest suite (`ATLAS_LIVE_GEMINI=1`) hard-pinned to `fixtures/retrieval-eval/` (the 4-query `source-heavy` fixture set) that spawns `brain query` per query — unusable as the graduation-gate operator surface.
- **Cost/scale reality:** ~206 notes → roughly 1–2k chunks → well under 1M embedding tokens ≈ **cents** per full rebuild (`gemini-embedding-001` standard tier). The per-run egress capability in `index rebuild` (8 MB / 2M tokens / cost ceiling 10M micro-units) has ample headroom.

## Design decisions

**D-A — the live eval runs as a registered `brain index eval` command** (not a tools script, not more env-vars on the vitest suite). Rationale: it will be re-run at every graduation drive and every RRF-weight tune, so it deserves the registered, schema'd, audited surface every other index op has; in-process `makeRetrieveSeam` reuses one table connection + one run capability and appends **one** `run.readonly` audit event per eval run instead of one per query; a tools script would import `apps/cli` internals across the workspace boundary (only test files get away with that today — `apps/cli` compiles with `rootDir: src`). Alternatives rejected: env-parameterizing `apps/cli/test/retrieval-eval.test.ts` (still test-shaped, per-query subprocess + per-query strict backup); wiring eval only into the graduation E2E (no live vehicle).

**D-B — the graduation eval set lives in the vault**, at `main-vault/00_System/retrieval-eval/{queries,labels}.json`, not in the engine repo. It names real note ids and personal/work content; the vault is its natural, hub-synced home, and graduation copies carry it along so the eval set travels with the corpus it labels. The repo keeps only the generic `source-heavy` fixture set. `index eval` takes explicit `--queries/--labels` paths, so nothing hardcodes either location.

**D-C — scope: the index is built on the graduated copy, not on main-vault.** V1 graduation is *to a copy* by definition; going live on the real vault is a post-V1 cutover decision, out of scope. Also out of scope: the workflow-runs/purge halves of #60, `tools/scale-bench.ts` (synthetic 5k/50k profiles), and any ingest→index auto-hook (the index is disposable derived state converged by `index repair`/`rebuild` by design).

## File Structure

- **Create** `packages/lancedb-index/src/eval.ts` — the pure eval harness, moved verbatim from `tools/retrieval-eval.ts` (types `EvalQuery`, `EvalQuerySet`, `EvalLabelSet`, `EvalRow`, `RetrievalEvalResult`, `RetrievalEvalDeps`, function `runRetrievalEval`). Pure (no imports), so D14 (`lancedb-index` imports only `@atlas/contracts`) is untouched.
- **Create** `packages/lancedb-index/test/eval.test.ts` — the metric-math tests, moved from `tools/retrieval-eval.test.ts`.
- **Delete** `tools/retrieval-eval.ts`, `tools/retrieval-eval.test.ts` (re-homed above; `tools/` keeps only the contract harness + failpoints + test-signer).
- **Modify** `packages/lancedb-index/src/index.ts` — re-export the eval module.
- **Create** `apps/cli/src/commands/index-eval.ts` — `parseIndexEvalArgs`, `loadEvalSet`, the pure `evalOutput` shaper, and the `index eval` handler (wires `openMigratedStore` + `EgressClient` + `ModelsClient` + `makeRetrieveSeam` + `runRetrievalEval` + `runReadAudit`).
- **Modify** `apps/cli/src/main.ts` — import `./commands/index-eval.js` at the composition root (the #145 lesson: registration only counts at the root).
- **Create** `apps/cli/test/index-eval.cli.test.ts` — parse/validation/output/threshold tests over a stub retriever.
- **Modify** `apps/cli/test/retrieval-eval.test.ts` — import the harness from `@atlas/lancedb-index` instead of `../../../tools/retrieval-eval.js` (the live opt-in suite itself stays).
- **Modify** `docs/specs/cli-contract/commands.json` — one new row: `index eval` (sorted by name, before `index rebuild`).
- **Modify** `docs/specs/cli-contract/cli-surface.fixture.txt` — one new line after `index rebuild`.
- **Create** `docs/specs/cli-contract/index-eval.schema.json` — the `--json` success contract + `x-atlas-contract` block.
- **Modify** `docs/specs/retrieval-index-contract.md` §7 — add the `index eval` row to the CLI-surface table.
- **Regenerate** `docs/specs/cli-contract/commands-overview.md` via `pnpm run contract:write`.
- **Create (vault repo)** `~/Code/Vaults/main-vault/00_System/retrieval-eval/queries.json` + `labels.json` + `README.md` — the graduation eval set (own branch + PR on `stark-2nd-brain`).

---

## Task 0: Branch setup + preflight

- [ ] Verify a clean worktree on the expected base and create the feature branch BEFORE any edit.

```bash
git -C ~/Code/21Stark/atlas status --short          # MUST be empty
git -C ~/Code/21Stark/atlas fetch origin main
git -C ~/Code/21Stark/atlas switch -c feat/index-eval origin/main 2>/dev/null \
  || git -C ~/Code/21Stark/atlas switch feat/index-eval
git -C ~/Code/21Stark/atlas branch --show-current   # MUST print feat/index-eval
git -C ~/Code/21Stark/atlas config user.email       # MUST print aryeh@21stark.com
```

- [ ] Dependency preflight (fail-fast):

```bash
node -v | grep -qE 'v(2[4-9]|[3-9][0-9])' || { echo 'Node 24+ required'; exit 1; }
test -x node_modules/.bin/tsc && test -x node_modules/.bin/vitest \
  || /opt/homebrew/bin/pnpm install --frozen-lockfile
```

---

## Task 1: Re-home the pure eval harness into `@atlas/lancedb-index`

The harness must be importable by `apps/cli/src` (production), which `tools/` is not (`apps/cli` compiles `rootDir: src`; only vitest-run test files currently reach into `tools/`). The module is pure — moving it changes no behavior.

**Files:**
- Create: `packages/lancedb-index/src/eval.ts`
- Create: `packages/lancedb-index/test/eval.test.ts`
- Modify: `packages/lancedb-index/src/index.ts`
- Modify: `apps/cli/test/retrieval-eval.test.ts` (import path only)
- Delete: `tools/retrieval-eval.ts`, `tools/retrieval-eval.test.ts`

**Interfaces:**
- Produces: `runRetrievalEval(deps: RetrievalEvalDeps): Promise<RetrievalEvalResult>` and the types `EvalQuery`, `EvalQuerySet`, `EvalLabelSet`, `EvalRow`, `RetrievalEvalResult`, `RetrievalEvalDeps` — exported from `@atlas/lancedb-index`. Signatures are IDENTICAL to today's `tools/retrieval-eval.ts` (`RetrievalEvalDeps = { queries, labels, retrieve: (text) => Promise<readonly string[]>, k? }`; `RetrievalEvalResult = { recallAt10, mrr, k, perQuery }`).

- [ ] **Step 1: Move the module**

```bash
git mv tools/retrieval-eval.ts packages/lancedb-index/src/eval.ts
git mv tools/retrieval-eval.test.ts packages/lancedb-index/test/eval.test.ts
```

- [ ] **Step 2: Fix the moved test's import**

In `packages/lancedb-index/test/eval.test.ts`, change:

```ts
import { runRetrievalEval, type EvalQuerySet, type EvalLabelSet } from "./retrieval-eval.js";
```

to:

```ts
import { runRetrievalEval, type EvalQuerySet, type EvalLabelSet } from "../src/eval.js";
```

- [ ] **Step 3: Export from the package barrel**

In `packages/lancedb-index/src/index.ts`, add alongside the existing exports:

```ts
export {
  runRetrievalEval,
  type EvalQuery,
  type EvalQuerySet,
  type EvalLabelSet,
  type EvalRow,
  type RetrievalEvalResult,
  type RetrievalEvalDeps,
} from "./eval.js";
```

- [ ] **Step 4: Re-point the live opt-in suite**

In `apps/cli/test/retrieval-eval.test.ts:21`, change:

```ts
import { runRetrievalEval, type EvalQuerySet, type EvalLabelSet } from "../../../tools/retrieval-eval.js";
```

to:

```ts
import { runRetrievalEval, type EvalQuerySet, type EvalLabelSet } from "@atlas/lancedb-index";
```

- [ ] **Step 5: Build + test the touched packages; sweep for stragglers**

```bash
grep -rn "tools/retrieval-eval" apps packages tools docs --include="*.ts" --include="*.json" --include="*.md" | grep -v node_modules   # MUST be empty
cd packages/lancedb-index && ../../node_modules/.bin/tsc -p tsconfig.json && npx vitest run && cd ../..
cd apps/cli && ../../node_modules/.bin/tsc -p tsconfig.json && cd ../..
cd tools && npx vitest run && cd ..    # contract-lint unaffected but prove it
```

Expected: all green; the grep finds nothing.

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "refactor(retrieval): re-home the pure eval harness into @atlas/lancedb-index

tools/retrieval-eval.ts was reachable only from vitest; brain index eval
(next commit) needs it from production code. Pure move — no behavior change."
```

---

## Task 2: `index eval` contract surface (registry row + fixture line + schema)

**Files:**
- Modify: `docs/specs/cli-contract/commands.json`
- Modify: `docs/specs/cli-contract/cli-surface.fixture.txt`
- Create: `docs/specs/cli-contract/index-eval.schema.json`
- Modify: `docs/specs/retrieval-index-contract.md` (§7 table)
- Regenerate: `docs/specs/cli-contract/commands-overview.md`

**Interfaces:**
- Produces: the registry row (initially `implemented: false`; Task 3 flips it) and the `--json` output contract Task 3's handler emits.

- [ ] **Step 1: Add the registry row** in `docs/specs/cli-contract/commands.json`, keeping rows sorted by name (immediately before the `index rebuild` row):

```json
    {
      "name": "index eval",
      "schemaRef": "docs/specs/cli-contract/index-eval.schema.json",
      "phase": 5,
      "idempotency": "none",
      "privilege": "shared",
      "implemented": false
    },
```

(`phase: 5` — the eval gates *graduation*, acceptance-thresholds.md §retrieval / Task 5.4.)

- [ ] **Step 2: Add the fixture line** in `docs/specs/cli-contract/cli-surface.fixture.txt`, directly after the `index rebuild` line:

```
`index eval` — retrieval-quality eval (recall@10 / MRR) against a labeled query set.
```

- [ ] **Step 3: Create `docs/specs/cli-contract/index-eval.schema.json`:**

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "$id": "atlas://cli-contract/index-eval.schema.json",
  "title": "brain index eval — --json success output",
  "description": "Retrieval-quality eval over the live index: scores every labeled query's ranked retrieval (the production retrieve → RRF-fuse path, one in-process seam) and aggregates recall@K + MRR per retrieval-index-contract.md and acceptance-thresholds.md §retrieval. Threshold defaults are the graduation-gate constants (recall@10 ≥ 0.85, MRR ≥ 0.7); a below-threshold result exits 1 with this same success payload (pass=false), mirroring `index verify`'s report-then-exit-1 shape. Emits exactly one terminal run.readonly audit event per eval run.",
  "type": "object",
  "unevaluatedProperties": false,
  "required": ["command", "k", "thresholds", "metrics", "pass", "queries", "perQuery"],
  "properties": {
    "command": { "const": "index eval" },
    "k": { "type": "integer", "minimum": 1, "maximum": 100, "description": "Top-K recall was computed at (default 10 — the graduation metric)." },
    "thresholds": {
      "type": "object",
      "unevaluatedProperties": false,
      "required": ["recallAt10", "mrr"],
      "properties": {
        "recallAt10": { "type": "number", "minimum": 0, "maximum": 1, "description": "Effective recall threshold (default 0.85, acceptance-thresholds.md §retrieval)." },
        "mrr": { "type": "number", "minimum": 0, "maximum": 1, "description": "Effective MRR threshold (default 0.7)." }
      }
    },
    "metrics": {
      "type": "object",
      "unevaluatedProperties": false,
      "required": ["recallAt10", "mrr"],
      "properties": {
        "recallAt10": { "type": "number", "minimum": 0, "maximum": 1 },
        "mrr": { "type": "number", "minimum": 0, "maximum": 1 }
      }
    },
    "pass": { "type": "boolean", "description": "metrics.recallAt10 >= thresholds.recallAt10 AND metrics.mrr >= thresholds.mrr." },
    "queries": { "type": "integer", "minimum": 0, "description": "Number of labeled queries scored." },
    "degradedQueries": { "type": "integer", "minimum": 0, "description": "Queries served in the §6 FTS-maturity fallback (fts layer dropped). Present when > 0." },
    "perQuery": {
      "type": "array",
      "items": {
        "type": "object",
        "unevaluatedProperties": false,
        "required": ["queryId", "expected", "retrieved", "firstRelevantRank", "reciprocalRank", "recall"],
        "properties": {
          "queryId": { "type": "string", "minLength": 1 },
          "expected": { "type": "array", "items": { "type": "string", "minLength": 1 }, "description": "The labeled relevant note ids." },
          "retrieved": { "type": "array", "items": { "type": "string", "minLength": 1 }, "description": "The retriever's ranked note ids, truncated to top-K." },
          "firstRelevantRank": { "type": ["integer", "null"], "minimum": 1, "description": "1-indexed rank of the first relevant note, null on a miss." },
          "reciprocalRank": { "type": "number", "minimum": 0, "maximum": 1 },
          "recall": { "type": "number", "minimum": 0, "maximum": 1 }
        }
      }
    }
  },
  "examples": [
    {
      "command": "index eval",
      "k": 10,
      "thresholds": { "recallAt10": 0.85, "mrr": 0.7 },
      "metrics": { "recallAt10": 0.9, "mrr": 0.82 },
      "pass": true,
      "queries": 30,
      "perQuery": [
        { "queryId": "q-cloud-team", "expected": ["team-cloud"], "retrieved": ["team-cloud", "person-kobi-sharbat"], "firstRelevantRank": 1, "reciprocalRank": 1, "recall": 1 }
      ]
    },
    {
      "command": "index eval",
      "k": 10,
      "thresholds": { "recallAt10": 0.85, "mrr": 0.7 },
      "metrics": { "recallAt10": 0.5, "mrr": 0.4 },
      "pass": false,
      "queries": 4,
      "degradedQueries": 4,
      "perQuery": [
        { "queryId": "q-miss", "expected": ["note-x"], "retrieved": ["note-y"], "firstRelevantRank": null, "reciprocalRank": 0, "recall": 0 }
      ]
    }
  ],
  "x-atlas-contract": {
    "command": "index eval",
    "phase": 5,
    "privilege": "shared",
    "idempotency": "none",
    "executionClass": "read",
    "summary": "Score the live hybrid retriever against a labeled query set (recall@K + MRR); exit 1 when below the graduation thresholds; emits exactly one terminal run.readonly audit event.",
    "args": [],
    "flags": [
      "--queries <path> (required: EvalQuerySet JSON)",
      "--labels <path> (required: EvalLabelSet JSON)",
      "--k <n> (default 10; bounds 1..100)",
      "--min-recall <x> (default 0.85 — acceptance-thresholds.md §retrieval)",
      "--min-mrr <x> (default 0.7 — acceptance-thresholds.md §retrieval)"
    ],
    "commonFlags": ["--json", "--quiet", "--verbose", "--plain", "--no-color", "--config <path>", "--vault <path>"],
    "terminalAuditEvent": "run.readonly",
    "sideEffects": [
      "one egress embed call per query (the vector layer embeds the query text through the egress broker)",
      "emits exactly one run.readonly git-ref audit event for the whole eval run"
    ],
    "prohibitedEffects": [
      "no ledger business row written (embed receipts are not persisted; the egress broker's own budget/audit still applies)",
      "no index/projection/vault mutation",
      "no more than one terminal audit event per run"
    ],
    "locks": [{ "scope": "shared", "mode": "shared" }],
    "exitCodes": [0, 1, 2, 4, 5],
    "errorCodes": [
      { "code": "usage", "exit": 5, "when": "missing/unknown flag, --k out of 1..100, threshold out of [0,1]" },
      { "code": "eval-set-invalid", "exit": 1, "when": "queries/labels JSON malformed, version != 1, a query without labels, or a labeled note id absent from the notes projection" },
      { "code": "eval-below-threshold", "exit": 1, "when": "metrics below thresholds (the success payload is still emitted; pass=false)" },
      { "code": "config-invalid", "exit": 2, "when": "brain.config.yaml fails schema validation" },
      { "code": "db-unavailable", "exit": 2, "when": "the SQLite store file is missing or unopenable" },
      { "code": "index-unavailable", "exit": 2, "when": "the LanceDB index is absent — run `brain index rebuild` first" },
      { "code": "broker-unreachable", "exit": 2, "when": "the egress broker socket is unreachable" },
      { "code": "internal", "exit": 4, "when": "unexpected internal failure" }
    ],
    "errorEnvelopeRef": "docs/specs/cli-contract/error-envelope.schema.json"
  }
}
```

- [ ] **Step 4: Add the §7 table row** in `docs/specs/retrieval-index-contract.md` (after the `index rebuild` row):

```markdown
| `index eval` | `cli-contract/index-eval.schema.json` | Tier-0 audited read (`run.readonly`) — the graduation eval gate (acceptance-thresholds.md §retrieval) |
```

- [ ] **Step 5: Regenerate + gate**

```bash
pnpm run contract:write
node tools/gen-cli-contract.ts --check
cd tools && npx vitest run && cd ..
```

Expected: generator writes `commands-overview.md`; `--check` and contract-lint green (an `implemented:false` row only requires membership consistency; the schema already exists).

- [ ] **Step 6: Commit**

```bash
git add docs/specs/cli-contract docs/specs/retrieval-index-contract.md
git commit -m "feat(contract): index eval — registry row + schema + fixture line (implemented:false until the handler lands)"
```

---

## Task 3: `brain index eval` handler (TDD)

**Files:**
- Create: `apps/cli/src/commands/index-eval.ts`
- Create: `apps/cli/test/index-eval.cli.test.ts`
- Modify: `apps/cli/src/main.ts` (composition-root import)
- Modify: `docs/specs/cli-contract/commands.json` (flip `implemented: true`)

**Interfaces:**
- Consumes: `runRetrievalEval` + eval types from `@atlas/lancedb-index` (Task 1); `makeRetrieveSeam(deps): Promise<(q: {text, k?, filters?}) => Promise<RetrievalResult>>` from `../retrieval/wiring.js` (existing; `RetrievalResult.items: RankedItem[]`, `RankedItem.noteId: string`, `RetrievalResult.degraded: boolean`); `openMigratedStore(ctx)` (existing); `runReadAudit(ctx, "run.readonly", "index eval", store, { strictBackup: true })` (existing); `EgressClient.connect(socketPath)` + `new ModelsClient(invoke, onReceipt)` (existing, exact shape below mirrors `enrich.ts:56-64`).
- Produces: the `index eval` command emitting the Task 2 schema; exported `parseIndexEvalArgs` and `loadEvalSet` for tests.

- [ ] **Step 1: Write the failing tests** — `apps/cli/test/index-eval.cli.test.ts`:

```ts
/**
 * `index-eval.cli.test` — parse/validation/output/threshold behavior of `brain index
 * eval` (this plan). The heavy wiring (store/LanceDB/egress) is exercised by the live
 * drive + the opt-in `retrieval-eval.test.ts`; here the pure pieces are driven directly:
 * flag parsing, eval-set loading/validation, and the output/exit shaping over a stub
 * retriever via the re-homed `runRetrievalEval`.
 */
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { runRetrievalEval } from "@atlas/lancedb-index";
import { CliError } from "../src/errors/envelope.js";
import { parseIndexEvalArgs, loadEvalSet, evalOutput } from "../src/commands/index-eval.js";

function writeSet(queries: unknown, labels: unknown): { queriesPath: string; labelsPath: string } {
  const dir = mkdtempSync(join(tmpdir(), "index-eval-"));
  const queriesPath = join(dir, "queries.json");
  const labelsPath = join(dir, "labels.json");
  writeFileSync(queriesPath, JSON.stringify(queries));
  writeFileSync(labelsPath, JSON.stringify(labels));
  return { queriesPath, labelsPath };
}

const GOOD_QUERIES = { version: 1, queries: [{ id: "q1", text: "who runs the cloud team" }] };
const GOOD_LABELS = { version: 1, labels: { q1: ["team-cloud"] } };

describe("parseIndexEvalArgs", () => {
  it("parses required paths + defaults (k=10, thresholds 0.85/0.7)", () => {
    const p = parseIndexEvalArgs(["--queries", "/q.json", "--labels", "/l.json"]);
    expect(p).toEqual({ queriesPath: "/q.json", labelsPath: "/l.json", k: 10, minRecall: 0.85, minMrr: 0.7 });
  });

  it("accepts --k / --min-recall / --min-mrr in both --flag v and --flag=v forms", () => {
    const p = parseIndexEvalArgs(["--queries=/q.json", "--labels=/l.json", "--k=5", "--min-recall", "0.9", "--min-mrr=0.5"]);
    expect(p).toEqual({ queriesPath: "/q.json", labelsPath: "/l.json", k: 5, minRecall: 0.9, minMrr: 0.5 });
  });

  it("rejects a missing --queries/--labels, out-of-bounds --k, and non-[0,1] thresholds as usage", () => {
    expect(() => parseIndexEvalArgs([])).toThrowError(CliError);
    expect(() => parseIndexEvalArgs(["--queries", "/q", "--labels", "/l", "--k", "0"])).toThrowError(/--k/);
    expect(() => parseIndexEvalArgs(["--queries", "/q", "--labels", "/l", "--k", "101"])).toThrowError(/--k/);
    expect(() => parseIndexEvalArgs(["--queries", "/q", "--labels", "/l", "--min-recall", "1.5"])).toThrowError(/--min-recall/);
    expect(() => parseIndexEvalArgs(["--queries", "/q", "--labels", "/l", "--unknown"])).toThrowError(/unknown/);
  });
});

describe("loadEvalSet", () => {
  it("loads a valid set and cross-checks label ids against the projection", () => {
    const { queriesPath, labelsPath } = writeSet(GOOD_QUERIES, GOOD_LABELS);
    const set = loadEvalSet(queriesPath, labelsPath, (id) => id === "team-cloud");
    expect(set.queries).toHaveLength(1);
    expect(set.labels["q1"]).toEqual(["team-cloud"]);
  });

  it("rejects malformed JSON, a bad version, a query without labels, and an unknown labeled note id", () => {
    const anyId = (): boolean => true;
    const { queriesPath, labelsPath } = writeSet(GOOD_QUERIES, GOOD_LABELS);
    expect(() => loadEvalSet("/nonexistent.json", labelsPath, anyId)).toThrowError(/eval-set-invalid|cannot read/);
    const badVersion = writeSet({ version: 2, queries: [] }, GOOD_LABELS);
    expect(() => loadEvalSet(badVersion.queriesPath, badVersion.labelsPath, anyId)).toThrowError(/version/);
    const unlabeled = writeSet({ version: 1, queries: [{ id: "q-un", text: "t" }] }, { version: 1, labels: {} });
    expect(() => loadEvalSet(unlabeled.queriesPath, unlabeled.labelsPath, anyId)).toThrowError(/q-un/);
    const ghost = writeSet(GOOD_QUERIES, GOOD_LABELS);
    expect(() => loadEvalSet(ghost.queriesPath, ghost.labelsPath, () => false)).toThrowError(/team-cloud/);
  });
});

describe("evalOutput", () => {
  it("shapes the schema payload and passes/fails against the thresholds", async () => {
    const result = await runRetrievalEval({
      queries: [
        { id: "q1", text: "a" },
        { id: "q2", text: "b" },
      ],
      labels: { q1: ["n1"], q2: ["n2"] },
      k: 10,
      retrieve: (text) => Promise.resolve(text === "a" ? ["n1"] : ["x", "n2"]),
    });
    const out = evalOutput(result, { minRecall: 0.85, minMrr: 0.7 }, 0);
    expect(out.command).toBe("index eval");
    expect(out.metrics).toEqual({ recallAt10: 1, mrr: 0.75 });
    expect(out.pass).toBe(true);
    expect(out.queries).toBe(2);
    expect(out.perQuery[0]).toEqual({ queryId: "q1", expected: ["n1"], retrieved: ["n1"], firstRelevantRank: 1, reciprocalRank: 1, recall: 1 });
    expect("degradedQueries" in out).toBe(false);

    const failing = evalOutput(result, { minRecall: 0.85, minMrr: 0.8 }, 2);
    expect(failing.pass).toBe(false);
    expect(failing.degradedQueries).toBe(2);
  });
});
```

- [ ] **Step 2: Run to verify failure**

```bash
cd apps/cli && npx vitest run test/index-eval.cli.test.ts
```

Expected: FAIL — `Cannot find module '../src/commands/index-eval.js'`.

- [ ] **Step 3: Implement `apps/cli/src/commands/index-eval.ts`:**

```ts
/**
 * `brain index eval` (search-index live-build plan, 2026-07-17) — the graduation
 * retrieval-eval gate as an operator command, per `retrieval-index-contract.md` §7 and
 * `cli-contract/index-eval.schema.json`.
 *
 * Scores the PRODUCTION retriever (the Task 4.11 `makeRetrieveSeam` — identity
 * short-circuits + FTS/vector RRF fusion over the live LanceDB index) against a labeled
 * query set (`EvalQuerySet`/`EvalLabelSet` JSON, the shapes `runRetrievalEval` defines),
 * and aggregates recall@K + MRR (acceptance-thresholds.md §retrieval: recall@10 ≥ 0.85,
 * MRR ≥ 0.7 gate graduation). Below-threshold emits the SAME success payload with
 * `pass:false` and exits 1 — mirroring `index verify`'s report-then-exit-1 shape.
 *
 * Tier-0 audited read: ONE terminal `run.readonly` audit event for the whole eval run
 * (per-query egress embeds are capability-bound to this run; receipts are not persisted
 * — the egress broker's own budget/audit applies). No ledger business row, no mutation.
 */
import { readFileSync } from "node:fs";
import {
  runRetrievalEval,
  type EvalLabelSet,
  type EvalQuerySet,
  type RetrievalEvalResult,
} from "@atlas/lancedb-index";
import { ModelsClient } from "@atlas/models";
import { EgressClient } from "@atlas/broker";
import { newRunId } from "@atlas/contracts";
import { CliError, EXIT, emitJson } from "../errors/envelope.js";
import { registerCommand, type RunContext } from "../handlers.js";
import { openMigratedStore } from "./store-open.js";
import { makeRetrieveSeam } from "../retrieval/wiring.js";
import { runReadAudit } from "../audit/readonly.js";

export interface ParsedIndexEvalArgs {
  readonly queriesPath: string;
  readonly labelsPath: string;
  readonly k: number;
  readonly minRecall: number;
  readonly minMrr: number;
}

/** Parse `index eval`'s residual argv: `--queries <p> --labels <p> [--k <n>] [--min-recall <x>] [--min-mrr <x>]`. */
export function parseIndexEvalArgs(argv: string[]): ParsedIndexEvalArgs {
  let queriesPath: string | undefined;
  let labelsPath: string | undefined;
  let k = 10;
  let minRecall = 0.85; // acceptance-thresholds.md §retrieval (contract-pinned defaults)
  let minMrr = 0.7;
  const take = (i: number, flag: string): string => {
    const v = argv[i];
    if (v === undefined) throw CliError.usage(`\`${flag}\` requires a value`);
    return v;
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === "--queries") queriesPath = take(++i, "--queries");
    else if (a.startsWith("--queries=")) queriesPath = a.slice("--queries=".length);
    else if (a === "--labels") labelsPath = take(++i, "--labels");
    else if (a.startsWith("--labels=")) labelsPath = a.slice("--labels=".length);
    else if (a === "--k") k = parseIntBounded(take(++i, "--k"), "--k", 1, 100);
    else if (a.startsWith("--k=")) k = parseIntBounded(a.slice("--k=".length), "--k", 1, 100);
    else if (a === "--min-recall") minRecall = parseUnit(take(++i, "--min-recall"), "--min-recall");
    else if (a.startsWith("--min-recall=")) minRecall = parseUnit(a.slice("--min-recall=".length), "--min-recall");
    else if (a === "--min-mrr") minMrr = parseUnit(take(++i, "--min-mrr"), "--min-mrr");
    else if (a.startsWith("--min-mrr=")) minMrr = parseUnit(a.slice("--min-mrr=".length), "--min-mrr");
    else throw CliError.usage(`unknown flag/argument for \`index eval\`: ${a}`);
  }
  if (queriesPath === undefined) throw CliError.usage("`index eval` requires `--queries <path>`");
  if (labelsPath === undefined) throw CliError.usage("`index eval` requires `--labels <path>`");
  if (queriesPath.length === 0) throw CliError.usage("`--queries` requires a non-empty path");
  if (labelsPath.length === 0) throw CliError.usage("`--labels` requires a non-empty path");
  return { queriesPath, labelsPath, k, minRecall, minMrr };
}

function parseIntBounded(v: string, flag: string, min: number, max: number): number {
  const n = Number(v);
  if (!Number.isInteger(n) || n < min || n > max) throw CliError.usage(`${flag} must be an integer in ${min}..${max} (got ${v})`);
  return n;
}

function parseUnit(v: string, flag: string): number {
  const n = Number(v);
  if (!Number.isFinite(n) || n < 0 || n > 1) throw CliError.usage(`${flag} must be a number in [0,1] (got ${v})`);
  return n;
}

const evalSetInvalid = (message: string): CliError =>
  new CliError({
    code: "eval-set-invalid",
    message,
    hint: "The eval set is {version:1, queries:[{id,text}]} + {version:1, labels:{<queryId>:[noteId,...]}} — see the vault's 00_System/retrieval-eval/README.md.",
    exitCode: EXIT.VALIDATION,
  });

/** Load + validate the labeled eval set; every label id must exist in the notes projection. */
export function loadEvalSet(
  queriesPath: string,
  labelsPath: string,
  noteExists: (noteId: string) => boolean,
): { queries: EvalQuerySet["queries"]; labels: EvalLabelSet["labels"] } {
  const read = (p: string): unknown => {
    let raw: string;
    try {
      raw = readFileSync(p, "utf8");
    } catch (e) {
      throw evalSetInvalid(`cannot read eval-set file ${p}: ${e instanceof Error ? e.message : String(e)}`);
    }
    try {
      return JSON.parse(raw);
    } catch {
      throw evalSetInvalid(`eval-set file ${p} is not valid JSON`);
    }
  };
  const q = read(queriesPath) as Partial<EvalQuerySet>;
  const l = read(labelsPath) as Partial<EvalLabelSet>;
  if (q.version !== 1 || !Array.isArray(q.queries)) throw evalSetInvalid(`${queriesPath}: expected {version:1, queries:[...]}`);
  if (l.version !== 1 || l.labels === undefined || typeof l.labels !== "object") throw evalSetInvalid(`${labelsPath}: expected {version:1, labels:{...}}`);
  for (const query of q.queries) {
    if (typeof query?.id !== "string" || query.id.length === 0 || typeof query?.text !== "string" || query.text.length === 0)
      throw evalSetInvalid(`${queriesPath}: every query needs a non-empty id + text`);
    const ids = l.labels[query.id];
    if (!Array.isArray(ids) || ids.length === 0) throw evalSetInvalid(`query ${query.id} has no labels — every query must name ≥1 expected note id`);
    for (const id of ids) {
      if (typeof id !== "string" || id.length === 0) throw evalSetInvalid(`query ${query.id} has a malformed label entry`);
      if (!noteExists(id)) throw evalSetInvalid(`query ${query.id} labels note id ${id}, which is not in the notes projection — a label that cannot be retrieved silently sinks recall`);
    }
  }
  return { queries: q.queries, labels: l.labels };
}

/** Shape the schema payload from the harness result + thresholds (pure — unit-tested). */
export function evalOutput(
  result: RetrievalEvalResult,
  thresholds: { minRecall: number; minMrr: number },
  degradedQueries: number,
): {
  command: "index eval";
  k: number;
  thresholds: { recallAt10: number; mrr: number };
  metrics: { recallAt10: number; mrr: number };
  pass: boolean;
  queries: number;
  degradedQueries?: number;
  perQuery: RetrievalEvalResult["perQuery"];
} {
  const pass = result.recallAt10 >= thresholds.minRecall && result.mrr >= thresholds.minMrr;
  return {
    command: "index eval",
    k: result.k,
    thresholds: { recallAt10: thresholds.minRecall, mrr: thresholds.minMrr },
    metrics: { recallAt10: result.recallAt10, mrr: result.mrr },
    pass,
    queries: result.perQuery.length,
    ...(degradedQueries > 0 ? { degradedQueries } : {}),
    perQuery: result.perQuery,
  };
}

async function indexEvalCmd(ctx: RunContext): Promise<number> {
  const p = parseIndexEvalArgs(ctx.argv);
  const cfg = ctx.config.config;
  const store = openMigratedStore(ctx);
  const noteExists = (noteId: string): boolean =>
    store.db.prepare(`SELECT 1 FROM notes WHERE note_id = ?`).get(noteId) !== undefined;

  let egress: EgressClient;
  try {
    egress = await EgressClient.connect(cfg.broker.egress_socket_path);
  } catch (e) {
    store.close();
    throw new CliError({
      code: "broker-unreachable",
      message: `the egress broker is unreachable at ${cfg.broker.egress_socket_path}`,
      hint: "Start the egress broker daemon (provisioning/bin/egress-launcher.sh) before `brain index eval`.",
      exitCode: EXIT.CONFIG,
      cause: e,
    });
  }
  const models = new ModelsClient((params, signal) => egress.invoke(params, signal), () => {});

  try {
    const { queries, labels } = loadEvalSet(p.queriesPath, p.labelsPath, noteExists);
    const runId = newRunId();
    const indexingCfg = {
      chunker_version: cfg.indexing.chunker_version,
      embedding_model: cfg.indexing.embedding_model,
      dimensions: cfg.indexing.dimensions,
    };
    const retrieveSeam = await makeRetrieveSeam({
      ctx,
      store,
      models,
      indexingCfg,
      rrf: cfg.retrieval.rrf,
      fts: cfg.retrieval.fts,
      defaultSensitivity: cfg.policies.default_sensitivity,
      runId,
      now: () => new Date().toISOString(),
    });

    let degradedQueries = 0;
    const result = await runRetrievalEval({
      queries,
      labels,
      k: p.k,
      retrieve: async (text) => {
        const r = await retrieveSeam({ text, k: p.k });
        if (r.degraded) degradedQueries++;
        return r.items.map((i) => i.noteId);
      },
    });

    const out = evalOutput(result, { minRecall: p.minRecall, minMrr: p.minMrr }, degradedQueries);
    const audit = await runReadAudit(ctx, "run.readonly", "index eval", store, { strictBackup: true });
    ctx.log.info("index.eval", {
      queries: out.queries,
      recallAt10: out.metrics.recallAt10,
      mrr: out.metrics.mrr,
      pass: out.pass,
      degradedQueries,
      audited: audit.recorded,
      runId: audit.runId,
    });
    if (ctx.output.mode === "json") emitJson(out);
    else
      ctx.render(
        `index eval — ${out.pass ? "PASS" : "BELOW THRESHOLD"}: recall@${out.k}=${out.metrics.recallAt10.toFixed(3)} (≥${p.minRecall}) mrr=${out.metrics.mrr.toFixed(3)} (≥${p.minMrr}) over ${out.queries} queries${degradedQueries > 0 ? ` [${degradedQueries} degraded]` : ""}`,
      );
    return out.pass ? EXIT.OK : EXIT.VALIDATION;
  } finally {
    egress.close();
    store.close();
  }
}

registerCommand("index eval", indexEvalCmd);

export { indexEvalCmd };
```

> Adjust two details against the codebase while implementing, keeping behavior identical: (1) the exact `EgressClient` close method name (`close()` per `index-ops.ts:146`); (2) if `CliError.usage` renders the code `usage` differently, keep the house form. If `makeRetrieveSeam`'s `RetrieveSeamDeps` requires fields this omits, thread them from `cfg` exactly as `enrich.ts:68` does.

- [ ] **Step 4: Register at the composition root** — in `apps/cli/src/main.ts`, add next to the existing command-module imports (grep `commands/index-ops.js` for the block):

```ts
import "./commands/index-eval.js";
```

- [ ] **Step 5: Flip the registry flag** — in `docs/specs/cli-contract/commands.json`, set the `index eval` row's `"implemented": true`, then:

```bash
pnpm run contract:write && node tools/gen-cli-contract.ts --check
```

- [ ] **Step 6: Run the tests**

```bash
cd apps/cli && ../../node_modules/.bin/tsc -p tsconfig.json && npx vitest run test/index-eval.cli.test.ts && cd ../..
cd tools && npx vitest run && cd ..
```

Expected: PASS (parse/loader/output tests + contract-lint).

- [ ] **Step 7: Full workspace gate + commit**

```bash
/opt/homebrew/bin/pnpm -r build && /opt/homebrew/bin/pnpm -r test
git add -A
git commit -m "feat(cli): brain index eval — the graduation retrieval-eval gate as an operator command

Scores the production retrieve→RRF path against a labeled query set
(recall@K + MRR, defaults 0.85/0.7 per acceptance-thresholds §retrieval);
one run.readonly audit event per eval run; exit 1 below threshold."
```

- [ ] **Step 8: Open the PR** (stark-gh pr-open flow); post any review findings on the PR; merge to `main` once green.

---

## Task 4: Author the graduation eval set (vault repo — separate branch + PR)

The eval set lives in the **vault** (D-B): `~/Code/Vaults/main-vault/00_System/retrieval-eval/`. Work happens on a branch of `stark-2nd-brain`, PR'd like any vault change. **It labels the *graduated* corpus, so do this after the Task 5 migrate preview exists** (label ids must be the post-migration canonical note ids from the migrate plan's `idMap` — ids may have been disambiguated/renamed).

**Files (vault repo):**
- Create: `00_System/retrieval-eval/queries.json`
- Create: `00_System/retrieval-eval/labels.json`
- Create: `00_System/retrieval-eval/README.md`

- [ ] **Step 1: Derive the candidate pool.** From the Task 5 migrate-preview JSON, list the graduated note ids per type. Select ≥ 30 notes covering the taxonomy, minimum per type where the vault has them: 4× `team`, 4× `repo`, 4× `person`, 4× `project`, 3× `meeting`, 3× `memory`, 3× `conversation`, 2× `tool`, 3× loose (`research`/`personal`).

- [ ] **Step 2: Write queries with eval hygiene** — one query per selected note (multi-label where genuinely multiple notes answer). Mix retrieval modes deliberately, ~equal thirds:
  - **exact/alias** — the note's title or a declared alias verbatim (exercises identity short-circuits + FTS);
  - **semantic paraphrase** — a natural question that shares few content words with the note (exercises the vector layer), e.g. `who runs the Cloud team` → `team-cloud` (the #151 canonical regression — MUST be included);
  - **detail probe** — a fact from a section body, not the title (exercises chunk-level retrieval + breadcrumbs).

- [ ] **Step 3: Write the three files.** Shapes (these are the `EvalQuerySet`/`EvalLabelSet` contracts from `@atlas/lancedb-index`):

`queries.json`:

```json
{
  "version": 1,
  "description": "Graduation retrieval-eval query set over the real vault (search-index live-build plan, 2026-07-17). Grows over time; never delete a query that once gated a drive — supersede by adding.",
  "queries": [
    { "id": "q-cloud-team", "text": "who runs the Cloud team" },
    { "id": "q-atlas-repo", "text": "which repo is the LLM-native second-brain wiki engine" }
  ]
}
```

`labels.json`:

```json
{
  "version": 1,
  "description": "query id → canonical POST-MIGRATION note ids (the migrate plan idMap is authoritative).",
  "labels": {
    "q-cloud-team": ["team-cloud"],
    "q-atlas-repo": ["repo-atlas"]
  }
}
```

(The two entries above are format examples — Step 2 produces the full ≥ 30-query set; verify each label id against the migrate preview, do not guess.)

`README.md`: three lines — what the set is, the `brain index eval --queries ... --labels ...` invocation, and the never-delete/supersede rule.

- [ ] **Step 4: Validate shape locally** (id-existence is enforced by `index eval` itself at run time):

```bash
node -e "
const q=require(process.env.HOME+'/Code/Vaults/main-vault/00_System/retrieval-eval/queries.json');
const l=require(process.env.HOME+'/Code/Vaults/main-vault/00_System/retrieval-eval/labels.json');
if(q.version!==1||l.version!==1) throw new Error('version');
if(q.queries.length<30) throw new Error('need >=30 queries, have '+q.queries.length);
for(const {id,text} of q.queries){ if(!id||!text) throw new Error('bad query'); if(!Array.isArray(l.labels[id])||l.labels[id].length===0) throw new Error('unlabeled '+id); }
console.log('ok:', q.queries.length, 'queries');
"
```

Expected: `ok: <n> queries` with n ≥ 30.

- [ ] **Step 5: Branch + PR on the vault repo** (`stark-2nd-brain`), merge once green.

---

## Task 5: The live drive — full-corpus graduation → rebuild → index → eval (operator-gated)

Operational runbook; no code changes expected (any bug found becomes its own issue/PR, per the altitude rule). Requires Tasks 1–3 merged; Task 4 labels are finalized against this task's migrate preview (Steps 1–4 can run before Task 4 completes; Step 8 needs it).

**Drive root layout** mirrors the 07-16 drive (`~/Code/Vaults/atlas-graduation-2026-07-16/` is the worked example — copy its `work/brain.config.yaml`/`drive/brain.config.yaml` and rewrite the paths):

```bash
export ROOT=~/Code/Vaults/atlas-graduation-2026-07-18   # date of execution
mkdir -p "$ROOT"
```

- [ ] **Step 1: Preconditions.**

```bash
git -C ~/Code/Vaults/main-vault rev-parse HEAD | tee "$ROOT/main-vault-head-before"
git -C ~/Code/21Stark/atlas log --oneline -1     # on main, includes Tasks 1-3
/opt/homebrew/bin/pnpm -C ~/Code/21Stark/atlas -r build
```

- [ ] **Step 2: Start the brokers** (production mode: `testMode=false`, operator-enrolled `approval-verify.pub`, real Gemini credential held only by `atlas-egress`) via `provisioning/bin/broker-launcher.sh` + `provisioning/bin/egress-launcher.sh`, per `provisioning/README.md` and the 07-16 drive's env. Verify both sockets respond (`brain doctor`).

- [ ] **Step 3: Graduation scan + audit on a fresh copy.**

```bash
brain graduation scan --source ~/Code/Vaults/main-vault    # expect gate: clean (ruleset v2); triage any new finding — do NOT weaken rules mid-drive
brain graduation audit                                      # expect: ~206+ notes, treeHashUnchanged: true
```

- [ ] **Step 4: Migrate preview — the #151 acceptance readout.**

```bash
brain graduation migrate --json > "$ROOT/migrate-preview.json"
```

Expected: `unknown-type` refusals **= 0**; quarantines only `detected-credential`; renames/link-flattening per the open-type-system plan. **Record the counts on #151.** The preview's idMap feeds Task 4's labels.

- [ ] **Step 5: Operator-gated apply.** `brain graduation migrate --apply --export-challenge` → **STOP: Aryeh signs the challenge out-of-band** (production authorizer, D20) → `--authorization <file>` → expect `mode: applied`, exit 0; `readVault()` over the graduated copy reports **zero errors** (the open-type-system reader-compatibility gate, live).

- [ ] **Step 6: Build the derived state + THE SEARCH INDEX.**

```bash
brain db rebuild --json   | tee "$ROOT/db-rebuild-1.json"     # projections from the graduated copy
brain index rebuild --json | tee "$ROOT/index-rebuild-1.json" # chunk → embed → write → verify → activate, full corpus
brain index status --json  | tee "$ROOT/index-status.json"    # expect: 0 stale, 0 missing (empty title-only stubs report benign `empty`)
brain index verify --json  | tee "$ROOT/index-verify.json"    # expect: consistent
```

Expected: `notesIndexed` ≈ the migrated count; note `chunksWritten` and `durationMs` (observe chunks/s against the §scale 50/s figure — record, don't gate; the formal gate is the synthetic scale bench, #60).

- [ ] **Step 7: Rebuild-consistency slice (#60).** Run `brain db rebuild` a second time and byte-compare the projection dump (`brain db status --json` + a `sqlite3 .dump` diff of projection tables); run `brain index rebuild` a second time and assert the same `notesIndexed`/`chunksWritten` and an `index verify` pass — the chunk-ID set is deterministic by contract §1 (embedding vector bytes may differ; identity, not bytes, is the index's determinism guarantee).

- [ ] **Step 8: The eval gate.**

```bash
brain index eval \
  --queries "$ROOT/COPY/00_System/retrieval-eval/queries.json" \
  --labels  "$ROOT/COPY/00_System/retrieval-eval/labels.json" \
  --json | tee "$ROOT/index-eval-1.json"
```

(`COPY` = the graduated copy path from Step 3's scan state; the eval set graduated along with the vault.) Expected: exit 0, `pass: true`, recall@10 ≥ 0.85 AND MRR ≥ 0.7.

**If below threshold:** tune **config-owned** values only — `retrieval.rrf.k` within [1,1000], `retrieval.rrf.weights.{fts,vector}` within bounds (vector > 0), `--k` stays 10 for the gate — in the drive's `brain.config.yaml`, then re-run `brain index eval` (weights are query-time; **no re-embed needed**). If FTS quality is the culprit, `retrieval.fts.enabled: false` selects the §6 vector-only fallback (expect `degradedQueries = queries`). Record every tuning iteration's JSON in `$ROOT`. Never touch phase code to pass the gate; a genuine engine defect becomes an issue + its own PR.

- [ ] **Step 9: Query smoke — the #151 acceptance sentence.**

```bash
brain query "who runs the Cloud team" --json          # expect: team-cloud surfaced, grounded answer
brain query "what is the atlas repo" --no-answer --json
brain query "recent meeting about the layoff" --no-answer --json
```

- [ ] **Step 10: Close out.**

```bash
git -C ~/Code/Vaults/main-vault rev-parse HEAD  # MUST equal main-vault-head-before
```

Post on #151: preview counts, applied result, eval metrics, query answers → close #151 if all acceptance bullets hold. Post on #60: the derived-state-rebuild + retrieval-eval slices with artifacts (leave #60 open for workflows/purge/scale-bench). File issues for anything found.

---

## Verification (plan-level)

1. `pnpm -r build && pnpm -r test && node tools/gen-cli-contract.ts --check` green on `main` after Tasks 1–3.
2. `brain index eval` on the drive copy: exit 0, recall@10 ≥ 0.85, MRR ≥ 0.7 (artifacts in `$ROOT`).
3. `brain query "who runs the Cloud team"` answers from `team-cloud` (#151 acceptance).
4. main-vault HEAD unchanged across the drive.
5. #151 closed with the recorded run; #60 updated.

## Risks

- **Eval set too easy/too hard** distorts the gate — the Task 4 mode mix (exact/paraphrase/detail) is the control; review the per-query breakdown, not just aggregates.
- **LanceDB FTS immaturity** — already designed for: §6 fallback via `retrieval.fts.enabled: false`, isolated to `search.ts`, no code change.
- **Gemini rate limits mid-rebuild** — `embedding-retryable` outcomes leave `unresolved[]` + exit 6; rerun `brain index rebuild`/`repair` to converge (idempotent by generation/chunk-id).
- **Eval label drift** as the vault evolves — `index eval` fails closed (`eval-set-invalid`) on a label id missing from the projection, which is the desired signal to refresh labels.

## Rollback

- Tasks 1–3 revert cleanly (one registry row, one schema, one fixture line, two new modules, import-path changes). Index state on the copy is disposable derived state — delete `lancedb.dir` wholesale. The drive root is a copy; main-vault is untouched by construction. The vault eval set is additive.

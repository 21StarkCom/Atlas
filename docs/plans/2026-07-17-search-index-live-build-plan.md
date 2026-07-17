# Search Index — Full-Corpus Live Build + Eval Gate Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the retrieval index over the **full** graduated real-vault corpus (~206 notes, all 11 types) and prove it against the graduation retrieval gate — recall@10 ≥ 0.85 AND MRR ≥ 0.7 — via a new operator surface (`brain index eval`), a real-corpus labeled eval set, and a live re-drive of graduation → `db rebuild` → `index rebuild` → eval on a fresh main-vault copy.

**Architecture:** All Phase-3 retrieval machinery already exists and has run live once (2026-07-16 drive: a real LanceDB index over the 32 notes V1's closed type set graduated). The open type system (#151/#152/#153) since made graduation a total function over the whole taxonomy. What is missing is (a) an **operator-grade eval vehicle** — today `runRetrievalEval` is reachable only from vitest, pinned to the repo fixture set, shelling `brain query` once per query (one `run.readonly` audit event + ledger write per query; backups coalesce); (b) a **real-corpus eval set**; and (c) the **live full-corpus drive** itself. This plan adds `brain index eval` (a registered Tier-0 read command over the existing `makeRetrieveSeam`, one audit event per eval run), re-homes the pure eval harness into `@atlas/lancedb-index` so production code can import it, authors the graduation eval set in the **vault** (it references personal corpus content — it does not belong in the engine repo), and finishes with the operational runbook.

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

**D-A — the live eval runs as a registered `brain index eval` command** (not a tools script, not more env-vars on the vitest suite). Rationale: it will be re-run at every graduation drive and every RRF-weight tune, so it deserves the registered, schema'd, audited surface every other index op has; in-process `makeRetrieveSeam` reuses one table connection + one run capability and appends **one** `run.readonly` audit event per eval run instead of one per query; a tools script would import `apps/cli` internals across the workspace boundary (only test files get away with that today — `apps/cli` compiles with `rootDir: src`). Alternatives rejected: env-parameterizing `apps/cli/test/retrieval-eval.test.ts` (still test-shaped, per-query subprocess + per-query `run.readonly` audit event — backups coalesce under the read-coalescing window, so the cost is events + subprocesses, not backups); wiring eval only into the graduation E2E (no live vehicle).

**D-B — the graduation eval set lives in the vault**, at `main-vault/00_System/retrieval-eval/{queries,labels}.json`, not in the engine repo. It names real note ids and personal/work content; the vault is its natural, hub-synced home, and graduation copies carry it along so the eval set travels with the corpus it labels. The repo keeps only the generic `source-heavy` fixture set. `index eval` takes explicit `--queries/--labels` paths, so nothing hardcodes either location.

**D-C — scope: the index is built on the graduated copy, not on main-vault.** V1 graduation is *to a copy* by definition; going live on the real vault is a post-V1 cutover decision, out of scope. Also out of scope: the workflow-runs/purge halves of #60, `tools/scale-bench.ts` (synthetic 5k/50k profiles), and any ingest→index auto-hook (the index is disposable derived state converged by `index repair`/`rebuild` by design).

## File Structure

- **Create** `packages/lancedb-index/src/eval.ts` — the pure eval harness, moved verbatim from `tools/retrieval-eval.ts` (types `EvalQuery`, `EvalQuerySet`, `EvalLabelSet`, `EvalRow`, `RetrievalEvalResult`, `RetrievalEvalDeps`, function `runRetrievalEval`). Pure (no imports), so D14 (`lancedb-index` imports only `@atlas/contracts`) is untouched.
- **Create** `packages/lancedb-index/test/eval.test.ts` — the metric-math tests, moved from `tools/retrieval-eval.test.ts` (harness import AND the two file-relative fixture URLs re-pointed — Task 1 Step 2).
- **Delete** `tools/retrieval-eval.ts`, `tools/retrieval-eval.test.ts` (re-homed above; `tools/` keeps only the contract harness + failpoints + test-signer).
- **Modify** `packages/lancedb-index/src/index.ts` — re-export the eval module.
- **Create** `apps/cli/src/commands/index-eval.ts` — `parseIndexEvalArgs`, `loadEvalSet`, the pure `evalOutput` shaper, and the `index eval` handler (wires `openMigratedStore` + `EgressClient` + `ModelsClient` + `makeRetrieveSeam` + `runRetrievalEval` + `runReadAudit`).
- **Modify** `apps/cli/src/commands/index.ts` — add `import "./index-eval.js";` to the registration barrel (`main.ts` imports the barrel before dispatch; registration only counts when reachable from the composition root — the #145 lesson).
- **Create** `apps/cli/test/index-eval.cli.test.ts` — parse/validation/output/threshold tests over a stub retriever.
- **Modify** `apps/cli/test/retrieval-eval.test.ts` — import the harness from `@atlas/lancedb-index` instead of `../../../tools/retrieval-eval.js` (the live opt-in suite itself stays).
- **Modify** `docs/specs/cli-contract/commands.json` — one new row: `index eval` (sorted by name, before `index rebuild`).
- **Modify** `docs/specs/cli-contract/cli-surface.fixture.txt` — one new line in the `# Graduation & quarantine (Phase 5)` section (the row is `phase: 5`; the generated overview groups by phase).
- **Modify** `tools/contract-lint.test.ts` — the Phase-5 gates learn the open inventory (Task 2 Step 5): add `index eval` to the inventory list; scope the blanket `implemented:true` assertion to the delivered five (the Phase-2/3/4 "schema presence, not temporal implementation-status" pattern).
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

- [ ] **Step 2: Fix the moved test's import AND its fixture URLs**

In `packages/lancedb-index/test/eval.test.ts`, change:

```ts
import { runRetrievalEval, type EvalQuerySet, type EvalLabelSet } from "./retrieval-eval.js";
```

to:

```ts
import { runRetrievalEval, type EvalQuerySet, type EvalLabelSet } from "../src/eval.js";
```

The last test ("the labeled fixture set is internally consistent", originally `tools/retrieval-eval.test.ts:72-73`) loads the repo-root fixture set via file-relative URLs. From `tools/` that was `../fixtures/...`; from `packages/lancedb-index/test/` it must climb three levels. Change BOTH lines:

```ts
new URL("../fixtures/retrieval-eval/queries.json", import.meta.url)
new URL("../fixtures/retrieval-eval/labels.json", import.meta.url)
```

to:

```ts
new URL("../../../fixtures/retrieval-eval/queries.json", import.meta.url)
new URL("../../../fixtures/retrieval-eval/labels.json", import.meta.url)
```

(Without this, Step 5's vitest run fails ENOENT — the package dir has no `fixtures/`. The harness move is pure; the moved TEST needs these two path edits.)

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

Also update the file's header comments at lines 3 and 11, which name `tools/retrieval-eval.ts`/`.test.ts` — point them at the new home (`@atlas/lancedb-index` `src/eval.ts` / `packages/lancedb-index/test/eval.test.ts`) so Step 5's sweep can gate on code references.

- [ ] **Step 5: Build + test the touched packages; sweep for stragglers**

```bash
grep -rn "tools/retrieval-eval" apps packages tools --include="*.ts" | grep -v node_modules   # MUST be empty (code scope; docs/ and this plan legitimately mention the old path)
grep -rn '"../fixtures/retrieval-eval' packages --include="*.ts" | grep -v node_modules       # MUST be empty (Step 2's URL rewrite took)
cd packages/lancedb-index && ../../node_modules/.bin/tsc -p tsconfig.json && npx vitest run && cd ../..
cd apps/cli && ../../node_modules/.bin/tsc -p tsconfig.json && cd ../..
cd tools && npx vitest run && cd ..    # contract-lint unaffected but prove it
```

Expected: all green; both greps find nothing.

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "refactor(retrieval): re-home the pure eval harness into @atlas/lancedb-index

tools/retrieval-eval.ts was reachable only from vitest; brain index eval
(next commit) needs it from production code. The harness moves verbatim;
the moved test re-points its import + file-relative fixture URLs."
```

---

## Task 2: `index eval` contract surface (registry row + fixture line + schema)

**Files:**
- Modify: `docs/specs/cli-contract/commands.json`
- Modify: `docs/specs/cli-contract/cli-surface.fixture.txt`
- Create: `docs/specs/cli-contract/index-eval.schema.json`
- Modify: `tools/contract-lint.test.ts` (the Phase-5 gates — Step 5)
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

- [ ] **Step 2: Add the fixture line** in `docs/specs/cli-contract/cli-surface.fixture.txt`, at the END of the `# Graduation & quarantine (Phase 5)` section (after the `quarantine resolve` line — the row declares `phase: 5`, and the generated `commands-overview.md` groups by phase; putting it under the Phase-3 heading would make the two artifacts disagree):

```
`index eval` — retrieval-quality eval (recall@10 / MRR) against a labeled query set; the graduation gate.
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
      { "flag": "--queries <path>", "type": "string", "default": null, "required": true, "description": "EvalQuerySet JSON ({version:1, queries:[{id,text}]})." },
      { "flag": "--labels <path>", "type": "string", "default": null, "required": true, "description": "EvalLabelSet JSON ({version:1, labels:{<queryId>:[noteId,...]}})." },
      { "flag": "--k <n>", "type": "integer", "default": 10, "required": false, "description": "Top-K to score recall at; bounds 1..100 (10 = the graduation metric)." },
      { "flag": "--min-recall <x>", "type": "number", "default": 0.85, "required": false, "description": "Recall threshold in [0,1] (default per acceptance-thresholds.md §retrieval)." },
      { "flag": "--min-mrr <x>", "type": "number", "default": 0.7, "required": false, "description": "MRR threshold in [0,1] (default per acceptance-thresholds.md §retrieval)." }
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
      { "code": "embedding-retryable", "exit": 4, "when": "a query embed hit a provider-retryable failure (rate limit/quota/timeout/transport); envelope carries retryable:true (+retryAfterMs when known). Exit 4 per the §2.5 cap — retryability lives on the flag, not a code the exit set does not define (query.ts convention)" },
      { "code": "embedding-failed", "exit": 4, "when": "a query embed failed non-retryably (provider validation/auth or egress refusal)" },
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

- [ ] **Step 5: Teach the Phase-5 lint gates the new row** — `tools/contract-lint.test.ts` hard-codes the Phase-5 world and fails Task 2 as-is; three edits, mirroring the Phase-2/3/4 gate policy already in the file (see its NB comments near the Phase-2/Phase-4 blocks):

1. Add `"index eval"` to the Phase-5 inventory array in `"the Phase-5 command set matches the plan Task 5.0 inventory"` (~line 1408), and retitle it to reflect the open inventory (e.g. "the Phase-5 command set matches the delivered inventory (Task 5.0 + index eval)").
2. Replace `"every Phase-5 row is implemented:true AND has an existing schema (Task 5.0 flips the delivered set)"` (~line 1400) with the delivered-set pattern: assert schema presence for EVERY Phase-5 row (already covered by the preceding test), and assert `implemented:true` only for the originally delivered five (`graduation audit|migrate|scan`, `quarantine inspect|resolve`). Add the NB comment the other phases carry: schema presence is the durable gate, not a temporal implementation-status assertion — Task 3 flips `index eval` to `implemented:true`.
3. Leave the `"every Phase-5 schema is well-formed..."` test untouched — the new schema must pass it as-is (x-atlas-contract mirrors the registry row; exitCodes ⊆ the §2.5 set incl. 4+5; examples validate).

- [ ] **Step 6: Regenerate + gate**

```bash
pnpm run contract:write
node tools/gen-cli-contract.ts --check
cd tools && npx vitest run && cd ..
```

Expected: generator writes `commands-overview.md`; `--check` green; contract-lint green WITH the Step-5 edits (the untouched gates would reject an `implemented:false` Phase-5 row and an inventory of six).

- [ ] **Step 7: Commit**

```bash
git add docs/specs/cli-contract docs/specs/retrieval-index-contract.md tools/contract-lint.test.ts
git commit -m "feat(contract): index eval — registry row + schema + fixture line (implemented:false until the handler lands)"
```

---

## Task 3: `brain index eval` handler (TDD)

**Files:**
- Create: `apps/cli/src/commands/index-eval.ts`
- Create: `apps/cli/test/index-eval.cli.test.ts`
- Modify: `apps/cli/src/commands/index.ts` (registration barrel)
- Modify: `docs/specs/cli-contract/commands.json` (flip `implemented: true`)

**Interfaces:**
- Consumes: `runRetrievalEval` + eval types from `@atlas/lancedb-index` (Task 1); `makeRetrieveSeam(deps): Promise<(q: {text, k?, filters?}) => Promise<RetrievalResult>>` from `../retrieval/wiring.js` (existing; `RetrievalResult.items: RankedItem[]`, `RankedItem.noteId: string`, `RetrievalResult.degraded: boolean`); `openMigratedStore(ctx)` (existing); `runReadAudit(ctx, "run.readonly", "index eval", store, { strictBackup: true, runId })` (existing — `runId` correlates the audit event with the seam's egress capability, the query.ts pattern); `QueryEmbedError` from `../retrieval/layers.js` (the embed path's typed failure); `EgressClient.connect(socketPath)` + `new ModelsClient(invoke, onReceipt)` (existing, exact shape below mirrors `enrich.ts:56-64`).
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
 * ONE run id: the invocation ULID (`ctx.runId`) binds the egress embed capability AND
 * anchors the audit event, so logs, broker per-run records, and the run.readonly event
 * join on a single id (the query.ts pattern; handlers.ts documents RunContext.runId).
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
import { CliError, EXIT, emitJson } from "../errors/envelope.js";
import { registerCommand, type RunContext } from "../handlers.js";
import { openMigratedStore } from "./store-open.js";
import { makeRetrieveSeam } from "../retrieval/wiring.js";
import { QueryEmbedError } from "../retrieval/layers.js";
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
    const runId = ctx.runId; // ONE id: egress capability + audit event + logs (query.ts pattern)
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
    let result: RetrievalEvalResult;
    try {
      result = await runRetrievalEval({
        queries,
        labels,
        k: p.k,
        retrieve: async (text) => {
          const r = await retrieveSeam({ text, k: p.k });
          if (r.degraded) degradedQueries++;
          return r.items.map((i) => i.noteId);
        },
      });
    } catch (e) {
      // Typed embed failures surface as the contract's embedding-* codes (query.ts
      // convention): §2.5 caps exits at 6, so retryability rides the envelope flag.
      if (e instanceof QueryEmbedError) {
        throw new CliError({
          code: e.code,
          message: e.message,
          exitCode: EXIT.INTERNAL,
          retryable: e.retryable,
          ...(e.retryAfterMs !== undefined ? { retryAfterMs: e.retryAfterMs } : {}),
          cause: e,
        });
      }
      throw e;
    }

    const out = evalOutput(result, { minRecall: p.minRecall, minMrr: p.minMrr }, degradedQueries);
    const audit = await runReadAudit(ctx, "run.readonly", "index eval", store, { strictBackup: true, runId });
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

- [ ] **Step 4: Register in the command barrel** — in `apps/cli/src/commands/index.ts` (the registration barrel `main.ts` imports before dispatch), add next to the existing side-effect imports (grep `./index-ops.js` for the block):

```ts
import "./index-eval.js";
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

The eval set lives in the **vault** (D-B): `~/Code/Vaults/main-vault/00_System/retrieval-eval/`. Work happens on a branch of `stark-2nd-brain`, PR'd like any vault change. **It labels the *graduated* corpus, so do this after Task 5 Step 0's label-preview pass exists** (label ids must be the post-migration canonical note ids from that preview's `idMap` — ids may have been disambiguated/renamed). **The vault PR must MERGE and local main-vault must sync BEFORE the real drive's Step 1** — the drive's clone (Step 3) must already carry `00_System/retrieval-eval/`, and the Step-10 HEAD assert must not see a mid-drive merge.

**Files (vault repo):**
- Create: `00_System/retrieval-eval/queries.json`
- Create: `00_System/retrieval-eval/labels.json`
- Create: `00_System/retrieval-eval/README.md`

- [ ] **Step 1: Derive the candidate pool.** From Task 5 Step 0's `label-preview.json`, list the graduated note ids per type. Select ≥ 30 notes covering the taxonomy, minimum per type where the vault has them: 4× `team`, 4× `repo`, 4× `person`, 4× `project`, 3× `meeting`, 3× `memory`, 3× `conversation`, 2× `tool`, 3× loose (`research`/`personal`).

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

`README.md`: three lines — what the set is, the invocation (spelled explicitly: `node ~/Code/21Stark/atlas/apps/cli/dist/bin.js index eval --queries ... --labels ...` — bare `brain` on this host is the Go 2nd-brain CLI, not atlas), and the never-delete/supersede rule.

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

Operational runbook; no code changes expected (any bug found becomes its own issue/PR, per the altitude rule). Requires Tasks 1–3 merged.

**Ordering (kills the Task-4 circularity):** the eval set must already be IN main-vault when the real drive clones it, and its labels need a migrate preview — so the drive is TWO passes: **Step 0** (a disposable label-preview pass → Task 4 authored → vault PR merged → main-vault synced), then **Steps 1–10** (the real drive, whose Step-1 HEAD-before already includes the eval-set commit, whose Step-3 clone carries `00_System/retrieval-eval/`, and whose Step-10 HEAD assert holds with zero exceptions).

**Drive root layout** mirrors the 07-16 drive (`~/Code/Vaults/atlas-graduation-2026-07-16/` is the worked example — copy its `work/brain.config.yaml`/`drive/brain.config.yaml` and rewrite the paths; its `keys/`, `egress/`, `approver/`, `custody/` dirs are the worked example for key/custody/approver enrollment):

```bash
export ROOT=~/Code/Vaults/atlas-graduation-2026-07-18   # date of execution
export COPY="$ROOT/grad-copy"                           # the graduated copy (Step 3's scan creates it)
mkdir -p "$ROOT"
# Bare `brain` on PATH is the Go 2nd-brain CLI (~/go/bin/brain), NOT this repo's CLI.
# Define the atlas CLI for this shell (zsh function — an env var would not word-split);
# re-declare it in any new shell mid-drive. dist/bin.js is the entry (dist/index.js is inert).
brain() { node "$HOME/Code/21Stark/atlas/apps/cli/dist/bin.js" "$@"; }
```

**Two configs, two working dirs** (the runbook's cwd column is load-bearing — config is cwd-resolved): **Steps 0 and 3–5 run from `$ROOT/work`** (scan/migrate take explicit `--source/--copy`; the work `.atlas` holds scan state). **Steps 6–9 run from `$ROOT/drive`**, whose config's `vault.path` MUST point at `$COPY` (07-16 cloned the copy to a separate `drive-vault/`; pointing straight at `$COPY` is equally valid — what matters is that projections and the index are built from the graduated corpus the eval labels name) with fresh `sqlite`/`lancedb` state under `$ROOT/drive/.atlas`.

- [ ] **Step 0: Label-preview pass + eval-set merge.** Build the CLI first, then run a disposable scan + preview solely to produce the idMap Task 4 needs:

```bash
/opt/homebrew/bin/pnpm -C ~/Code/21Stark/atlas -r build
cd "$ROOT/work"
brain graduation scan --source ~/Code/Vaults/main-vault --copy "$ROOT/preview-copy"
brain graduation audit
brain graduation migrate --json > "$ROOT/label-preview.json"   # its idMap = Task 4's label source
```

Then: author Task 4 from `label-preview.json`'s idMap (vault branch + PR on `stark-2nd-brain`), **merge it, sync local main-vault** (hub-sync/pull) so `00_System/retrieval-eval/` is in the working tree and HEAD, and `rm -rf "$ROOT/preview-copy"` — nothing from this pass is reused. (The eval-set commit adds non-note JSON under `00_System/`, so the real drive's Step-4 idMap must equal this one — Step 4 diffs them as a sanity check.)

- [ ] **Step 1: Preconditions** (only AFTER the Task-4 merge is synced into local main-vault):

```bash
test -d ~/Code/Vaults/main-vault/00_System/retrieval-eval || { echo "eval set missing — finish Step 0"; }
git -C ~/Code/Vaults/main-vault rev-parse HEAD | tee "$ROOT/main-vault-head-before"   # includes the eval-set commit
git -C ~/Code/21Stark/atlas log --oneline -1     # on main, includes Tasks 1-3
/opt/homebrew/bin/pnpm -C ~/Code/21Stark/atlas -r build
```

- [ ] **Step 2: Start the brokers** (production mode: `testMode=false`, operator-enrolled `approval-verify.pub` in `$ROOT/keys`, real Gemini credential held ONLY by the egress daemon). The fixed-path launchers (`provisioning/bin/*-launcher.sh`) exec installed binaries under `/usr/local/lib/atlas` with OS-level socket paths — for a drive-root-scoped run, start the daemons directly with the env spelled out (what the 07-16 drive did; key/approver enrollment per `provisioning/README.md`, worked example in the 07-16 root):

```bash
cd ~/Code/21Stark/atlas
ATLAS_BROKER_SOCKET="$ROOT/broker.sock" \
ATLAS_BROKER_KEYS_DIR="$ROOT/keys" \
ATLAS_AUDIT_ANCHOR_PATH="$ROOT/anchor" \
ATLAS_VAULT_REPO_DIR="$COPY" \
  node packages/broker/dist/bin/atlas-broker.js > "$ROOT/broker.log" 2>&1 &
# ATLAS_TEST_MODE deliberately NOT set (D20) — the production broker hard-rejects the test signer.
# $COPY is created by Step 3's scan; the broker opens the repo on first ref op (Step 5), not at startup.

ATLAS_EGRESS_SOCKET="$ROOT/egress.sock" \
ATLAS_EGRESS_KEYS_DIR="$ROOT/egress/keys" \
ATLAS_EGRESS_CAPABILITY_KEY="$ROOT/egress/shared/egress-capability.key" \
ATLAS_EGRESS_QUARANTINE_PUBKEY="$ROOT/egress/shared/quarantine.pub" \
ATLAS_EGRESS_QUARANTINE_SPOOL="$ROOT/egress/spool" \
ATLAS_EGRESS_BUDGET_STATE="$ROOT/egress/budget-state.json" \
  node packages/broker/dist/bin/atlas-egress.js > "$ROOT/egress.log" 2>&1 &
# The Gemini credential is the ONLY key in the egress-only keys dir, read at startup from
# $ROOT/egress/keys/atlas.gemini.key (bin/atlas-egress.ts — the path is keysDir-joined, not an env var).
```

Verify BOTH daemons directly — `brain doctor` probes NEITHER socket in a drive env:

```bash
test -S "$ROOT/broker.sock" && test -S "$ROOT/egress.sock" && echo sockets-up
grep "atlas-broker listening" "$ROOT/broker.log"    # the "(testMode=false)" suffix proves production mode
grep "atlas-egress listening" "$ROOT/egress.log"
```

(The first egress exercise is Step 6's `index rebuild` — a dead egress daemon fails fast there as `broker-unreachable`.)

- [ ] **Step 3: Graduation scan + audit on a fresh copy** (from `$ROOT/work`; the clone now carries the merged eval set).

```bash
cd "$ROOT/work"
brain graduation scan --source ~/Code/Vaults/main-vault --copy "$COPY"   # expect gate: clean (ruleset v2); triage any new finding — do NOT weaken rules mid-drive
brain graduation audit                                                    # expect: ~206+ notes, treeHashUnchanged: true
```

- [ ] **Step 4: Migrate preview — the #151 acceptance readout** (from `$ROOT/work`).

```bash
brain graduation migrate --json > "$ROOT/migrate-preview.json"
```

Expected: `unknown-type` refusals **= 0**; quarantines only `detected-credential`; renames/link-flattening per the open-type-system plan; **its idMap equals Step 0's `label-preview.json` idMap** (diff them — a mismatch means the vault changed between passes; refresh Task 4's labels before proceeding). **Record the counts on #151.**

- [ ] **Step 5: Operator-gated apply** (from `$ROOT/work`; both commands spelled in full — `--authorization` without `--apply` would silently run a preview):

```bash
brain graduation migrate --apply --export-challenge > "$ROOT/challenge.json"   # emits the challenge JSON; exits 6 (action-required) BY DESIGN
# STOP: Aryeh signs $ROOT/challenge.json out-of-band (production authorizer, D20) → $ROOT/authorization.json
brain graduation migrate --apply --authorization "$ROOT/authorization.json"    # expect: mode: applied, exit 0
```

Then `readVault()` over the graduated copy reports **zero errors** (the open-type-system reader-compatibility gate, live).

- [ ] **Step 6: Build the derived state + THE SEARCH INDEX** (from `$ROOT/drive` — its config's `vault.path` points at `$COPY`, so projections and the index come from the graduated corpus).

```bash
cd "$ROOT/drive"
brain db rebuild --json    | tee "$ROOT/db-rebuild-1.json"    # projections from the graduated copy
brain index rebuild --json | tee "$ROOT/index-rebuild-1.json" # chunk → embed → write → verify → activate, full corpus
brain index status --json  | tee "$ROOT/index-status.json"    # expect: 0 stale; `missing` equals the count of empty title-only stubs (never activated by design — the activate empty-note policy); there is no `empty` status
brain index verify --json  | tee "$ROOT/index-verify.json"    # expect: consistent
```

Expected: `notesIndexed` ≈ the migrated count; note `chunksWritten` and `durationMs` (observe chunks/s against the §scale 50/s figure — record, don't gate; the formal gate is the synthetic scale bench, #60).

- [ ] **Step 7: Rebuild-consistency slice (#60)** (from `$ROOT/drive`). Run `brain db rebuild` a second time and compare **deterministic SELECTs**, not a raw `.dump` (which is guaranteed to differ: `vault_schema_migrations.applied_at` is wall-clock, and a `db rebuild` wipes activation fences that only the subsequent `index rebuild` restores): diff ordered SELECTs of the rebuild-owned columns of `notes` (excluding `active_generation`/`active_generation_id`) plus `note_identity_keys` and `note_links`, and `brain db status --json` counts. Then run `brain index rebuild` a second time and assert the same `notesIndexed`/`chunksWritten` and an `index verify` pass — the chunk-ID set is deterministic by contract §1 (embedding vector bytes may differ; identity, not bytes, is the index's determinism guarantee). **Order is load-bearing:** the second `db rebuild` must be followed by the second `index rebuild` before Step 8, or the wiped fences leave the index unreadable.

- [ ] **Step 8: The eval gate** (from `$ROOT/drive`).

```bash
brain index eval \
  --queries "$COPY/00_System/retrieval-eval/queries.json" \
  --labels  "$COPY/00_System/retrieval-eval/labels.json" \
  --json | tee "$ROOT/index-eval-1.json"
```

(The eval set genuinely graduated along with the vault — Step 0 merged it into main-vault BEFORE Step 3's clone, so the copy carries it.) Expected: exit 0, `pass: true`, recall@10 ≥ 0.85 AND MRR ≥ 0.7.

**If below threshold:** tune **config-owned** values only — `retrieval.rrf.k` within [1,1000], `retrieval.rrf.weights.{fts,vector}` within bounds (vector > 0), `--k` stays 10 for the gate — in the drive's `brain.config.yaml`, then re-run `brain index eval` (weights are query-time; **no re-embed needed**). If FTS quality is the culprit, `retrieval.fts.enabled: false` selects the §6 vector-only fallback (expect `degradedQueries = queries`). Record every tuning iteration's JSON in `$ROOT`. Never touch phase code to pass the gate; a genuine engine defect becomes an issue + its own PR.

- [ ] **Step 9: Query smoke — the #151 acceptance sentence** (from `$ROOT/drive`).

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
2. `brain index eval` on the drive copy (the Task-5 `brain()` function — `node apps/cli/dist/bin.js`): exit 0, recall@10 ≥ 0.85, MRR ≥ 0.7 (artifacts in `$ROOT`).
3. `brain query "who runs the Cloud team"` answers from `team-cloud` (#151 acceptance).
4. main-vault HEAD unchanged across the drive.
5. #151 closed with the recorded run; #60 updated.

## Risks

- **Eval set too easy/too hard** distorts the gate — the Task 4 mode mix (exact/paraphrase/detail) is the control; review the per-query breakdown, not just aggregates.
- **LanceDB FTS immaturity** — already designed for: §6 fallback via `retrieval.fts.enabled: false`, isolated to `search.ts`, no code change.
- **Gemini rate limits mid-rebuild** — `embedding-retryable` outcomes leave `unresolved[]` + exit 6; rerun `brain index rebuild`/`repair` to converge (idempotent by generation/chunk-id).
- **Eval label drift** as the vault evolves — `index eval` fails closed (`eval-set-invalid`) on a label id missing from the projection, which is the desired signal to refresh labels.

## Rollback

- Tasks 1–3 revert cleanly (one registry row, one schema, one fixture line, the two Phase-5 lint-gate edits, two new modules, one barrel import, import-path + fixture-URL changes). Index state on the copy is disposable derived state — delete `lancedb.dir` wholesale. The drive root is a copy; main-vault is untouched by construction (the eval set lands via its own reviewed vault PR BEFORE the drive, not during it). The vault eval set is additive.

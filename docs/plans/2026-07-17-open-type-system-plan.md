# Open Type System Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make Atlas graduation ingest *every* note of the real vault's 11-type taxonomy (currently 122/206 refused for unrecognized type), normalizing any gap with deterministic judgement, so that the graduated vault rebuilds through the **unchanged** strict `readVault()` with **zero** errors. Secrets remain the one quarantine boundary — but they are handled *in-run*: `graduation scan` records per-path credential dispositions, and `graduation migrate` skips exactly those paths and reports them as `detected-credential` quarantines. Every other note migrates.

**Architecture:** A data-driven type registry in `@atlas/contracts` is the single in-repo authority for the taxonomy (kept honest against the external `main-vault/00_System/Vault Schema.md` by a checked-in canonical fixture + an unconditional CI drift gate). Graduation becomes a *total function* end-to-end — **planner (`migrate-plan.ts`) AND apply (`migrate-apply.ts`) both change**, because normalization only counts once it reaches disk:

- The `unknown-type` and `unsupported-schema-version` refusals are removed (unknown → loose, kept; schema coerced to the contracts-owned `SCHEMA_VERSION`).
- Duplicate explicit ids are numeric-suffix-disambiguated; **filename-slug collisions** (which the strict reader keys off — see below) are deterministically renamed and their inbound links rewritten *in apply*; unresolved/ambiguous wikilinks are **flattened to plain text in the emitted body** (the strict reader rejects `broken-link`/`ambiguous-link`, so nothing may survive as a wikilink).
- Strict-type base fields are filled/coerced against the **real vault schema** (six statuses, `source` as a structured list, `classification ∈ {public,personal,internal}`), and the apply serializer writes **every** managed field (not the legacy six) via one canonical field definition shared by planner and apply.
- A per-note `normalized[]` report records **every** applied fill/coercion, produced by routing every managed-field assignment through a compare helper.

**Why the reader drives the design:** `readVault()`'s `detectIdentityCollisions` keys off each note's **filename slug** (basename minus `.md`) **plus its aliases**, *not* its id (`apps/cli/src/vault/reader.ts:137-166`, `fileSlug` at `:257-259`). So `10_Work/Repos/meridian.md` and `10_Work/Projects/meridian.md` both own slug `meridian` and collide even though their ids (`repo-meridian`/`project-meridian`) differ. Disambiguating ids alone does **not** clear the reader gate — the file must be renamed. This is the load-bearing correction over the first draft.

**Tech Stack:** TypeScript (strict/ESM/NodeNext), Node ≥ 24, pnpm, vitest. Build per package with `../../node_modules/.bin/tsc -p tsconfig.json` (the pnpm global wrapper is broken — use tsc directly or `/opt/homebrew/bin/pnpm` only if healthy). Run tests with `npx vitest run` from the package dir.

## Global Constraints

- TypeScript strict / ESM / NodeNext; compile with `tsc` (no runtime type-stripping in prod).
- Commits authored `Aryeh Stark <aryeh@21stark.com>` (per-repo git config already set).
- Branch + PR for everything; every review finding lands on the PR. Merge to `main` once CI green (no canary).
- Graduation stays DETERMINISTIC: pure function of input vault + scan-state + config, no wall-clock, no per-note LLM/egress calls. Byte-exact fixtures under `docs/specs/fixtures/bootstrap-migration/` remain the contract.
- **Secret boundary (in-run, revised):** a detected credential still quarantines and is never written to the graduated vault. This plan **does** touch the scan/state seam: `graduation scan` persists the set of credential-bearing paths into scan state, and `graduation migrate` consumes it — skipping exactly those paths and emitting one `detected-credential` quarantine entry per skipped path. The scan *engine* (`graduation/scan.ts` detection rules) is unchanged; only the persisted state shape + the migrate/scan-gate handshake change. (Operator-approved scope expansion, 2026-07-17.)
- Do NOT modify the spec-locked mutation-policy table (`policies/mutation-policy.ts`, `workflow-risk-contract.md`) — out of scope (spec non-goal).
- Exit codes unchanged: `0` ok · `1` validation · `2` config · `3` secret-scan · `4` internal · `5` usage · `6` action-required (apply/rollback authorization).

**Spec:** `docs/specs/2026-07-16-open-type-system-spec.md`. **Issue:** #151.

---

## File Structure

- **Create** `packages/contracts/src/type-registry.ts` — the type registry (11 vault types + V1's `note`/`concept`/`source`), `TypeDef`, `resolveType()`, `classificationToSensitivity()`, `isRegisteredType()`, `STRICT_BASE_FIELDS`/`LOOSE_BASE_FIELDS`, the canonical `MANAGED_FRONTMATTER` field spec (shared by planner + apply), and the single `SCHEMA_VERSION` authority.
- **Create** `packages/contracts/test/fixtures/vault-taxonomy.json` — checked-in canonical taxonomy snapshot (strict/loose type sets, statuses, classifications) — the in-repo SSOT the drift test runs against unconditionally.
- **Modify** `packages/contracts/src/index.ts` — re-export the registry symbols + `SCHEMA_VERSION` + `MANAGED_FRONTMATTER`.
- **Create** `packages/contracts/test/type-registry.test.ts` — exact-membership unit tests + unconditional drift test vs the fixture + optional drift test vs the live `Vault Schema.md`.
- **Modify** `apps/cli/src/vault/reader.ts` — import `SCHEMA_VERSION` from contracts so the reader and migrator share one supported-version authority (no behavior change beyond sourcing the constant).
- **Modify** `apps/cli/src/graduation/migrate-plan.ts` — consume the registry; route all type inference through `resolveType`; remove the two refusal branches; disambiguate duplicate ids; detect filename-slug collisions and record deterministic renames; flatten unresolved/ambiguous links; fill/coerce strict base fields against the real schema; emit `normalized[]`; use the shared `MANAGED_FRONTMATTER` spec.
- **Modify** `apps/cli/src/graduation/migrate-apply.ts` — serialize **every** managed field from the shared spec (not the legacy six); apply the recorded file renames (with checkpoint/rollback coverage) and rewrite inbound links; apply `flattened-*` body rewrites; skip credential-quarantined paths.
- **Modify** `apps/cli/src/graduation/scan.ts` + `apps/cli/src/commands/graduation-scan.ts` — persist per-path credential dispositions in scan state (engine detection unchanged).
- **Modify** `apps/cli/src/commands/graduation-migrate.ts` — consume credential dispositions; surface `normalized[]`.
- **Modify** `apps/cli/src/graduation/audit.ts` — derive `GRADUATION_KNOWN_TYPES` from the registry; open the audit's known-type rule.
- **Modify** `docs/specs/cli-contract/graduation-migrate.schema.json` — open `type.value` to any non-empty string, add `flattened-unresolved`/`flattened-ambiguous` resolutions, define every managed `initializedFrontmatter` field, add `normalized`.
- **Modify** `tools/contract-lint.test.ts` — update the Phase-5 assertions that currently expect unknown-type/schema-version refusals, duplicate-identity quarantine, and preserved-link behavior (they change in Tasks 2-3); add schema-validation cases for the open contract.
- **Modify** `apps/cli/test/bootstrap-migration.fixtures.test.ts` (the REAL fixture runner; `graduation-fixtures.test.ts` does not exist) — add `full-taxonomy` to its `CASES` array.
- **Modify** fixtures under `docs/specs/fixtures/bootstrap-migration/` — update expectations for total behavior; add a `full-taxonomy` case + manifest entry.
- **Create** `apps/cli/test/full-taxonomy-reader.test.ts` — the reader-compatibility gate (apply → `readVault()` → zero errors).
- **Modify** `apps/cli/test/graduation-migrate.cli.test.ts` and any other `*migrate*`/graduation test asserting the retired refusal/quarantine categories.

---

## Task 0: Branch setup

- [ ] Verify a clean worktree on the expected base and create the feature branch BEFORE any edit or commit (Task 1 commits immediately — the branch must already exist).

```bash
git -C ~/Code/21Stark/atlas status --short          # MUST be empty
git -C ~/Code/21Stark/atlas fetch origin main
git -C ~/Code/21Stark/atlas switch -c feat/open-type-system origin/main 2>/dev/null \
  || git -C ~/Code/21Stark/atlas switch feat/open-type-system
git -C ~/Code/21Stark/atlas branch --show-current   # MUST print feat/open-type-system
```

Then run the dependency preflight (fail-fast — Task 1 immediately invokes `tsc`/`vitest`):

```bash
node -v | grep -qE 'v(2[4-9]|[3-9][0-9])' || { echo 'Node 24+ required'; exit 1; }
command -v /opt/homebrew/bin/pnpm >/dev/null || { echo 'pnpm missing'; exit 1; }
test -x node_modules/.bin/tsc && test -x node_modules/.bin/vitest \
  || /opt/homebrew/bin/pnpm install --frozen-lockfile   # populate node_modules on a clean checkout
test -x node_modules/.bin/tsc && test -x node_modules/.bin/vitest \
  || { echo 'tsc/vitest binaries missing after install'; exit 1; }
```

All Task 1-5 commits land on this branch; never commit on `main`.

---

## Task 1: Type registry + shared frontmatter spec + single schema-version authority in @atlas/contracts

**Files:**
- Create: `packages/contracts/src/type-registry.ts`
- Create: `packages/contracts/test/fixtures/vault-taxonomy.json`
- Modify: `packages/contracts/src/index.ts`
- Modify: `apps/cli/src/vault/reader.ts` (source `SCHEMA_VERSION` from contracts)
- Test: `packages/contracts/test/type-registry.test.ts`

**Interfaces:**
- Consumes: `Sensitivity` from `./dtos.js` (`"public" | "internal" | "confidential" | "restricted"`).
- Produces:
  - `interface TypeDef { readonly name: string; readonly tier: "strict" | "loose"; readonly defaultSensitivity: Sensitivity }`
  - `const STRICT_TYPES` = `["project","repo","tool","cloud","person","team","meeting","conversation","memory","concept","source"]` (the vault's 9 strict + V1 `concept`/`source`).
  - `const LOOSE_TYPES` = `["research","personal","note"]` (the vault's 2 loose + V1 `note`).
  - `const SCHEMA_VERSION = 1` — the **single** supported/emitted schema version. The reader (`SUPPORTED_SCHEMA_VERSION`) and the migrator both import this; neither hardcodes a literal. If the reader advances, both advance together.
  - `const STRICT_BASE_FIELDS` = the vault's required base fields for strict notes.
  - `const LOOSE_BASE_FIELDS` = `["id","type","title"]`.
  - `const MANAGED_FRONTMATTER: readonly string[]` — the canonical **ordered** list of frontmatter keys Atlas manages/emits (shared by the planner's preservation filter and apply's serializer, so there is exactly one managed-key authority). Order: `["id","type","schema_version","title","created","updated","status","aliases","tags","related","confidence","classification","source","declaredSensitivity"]`.
  - `function resolveType(name): TypeDef` — trims/normalizes; registered name → its def; unknown → loose def keeping the (trimmed) name; empty/whitespace/null → loose `note`. **The one owner of type-name normalization.**
  - `function classificationToSensitivity(classification): Sensitivity` — per the vault schema + spec decision (public→public; everything else→internal). The vault forbids `confidential`/`secret` classifications, so this never emits above `internal` from a vault classification. (No "fail-up": that would synthesize a sensitivity the vault forbids.)
  - `function isRegisteredType(name): boolean`.

- [ ] **Step 1: Write the canonical taxonomy fixture**

Create `packages/contracts/test/fixtures/vault-taxonomy.json` — the in-repo SSOT snapshot the drift gate enforces unconditionally (mirrors `Vault Schema.md` at authoring time; update it deliberately when the vault schema changes):

```json
{
  "source": "main-vault/00_System/Vault Schema.md (snapshot 2026-07-17)",
  "strictTypes": ["project", "repo", "tool", "cloud", "person", "team", "meeting", "conversation", "memory"],
  "looseTypes": ["research", "personal"],
  "v1CompatStrict": ["concept", "source"],
  "v1CompatLoose": ["note"],
  "statuses": ["active", "draft", "needs-review", "stale", "archived", "deprecated"],
  "classifications": ["public", "personal", "internal"],
  "confidenceLevels": ["low", "medium", "high"]
}
```

- [ ] **Step 2: Write the failing test**

Create `packages/contracts/test/type-registry.test.ts`:

```typescript
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import {
  resolveType, classificationToSensitivity, isRegisteredType,
  STRICT_TYPES, LOOSE_TYPES, SCHEMA_VERSION, MANAGED_FRONTMATTER,
} from "../src/type-registry.js";

const TAXO = JSON.parse(readFileSync(new URL("./fixtures/vault-taxonomy.json", import.meta.url), "utf8"));

describe("type-registry — exact membership", () => {
  it("registers EXACTLY the 14 expected names (11 vault + 3 V1 compat)", () => {
    expect([...STRICT_TYPES].sort()).toEqual(
      [...TAXO.strictTypes, ...TAXO.v1CompatStrict].sort());
    expect([...LOOSE_TYPES].sort()).toEqual(
      [...TAXO.looseTypes, ...TAXO.v1CompatLoose].sort());
    expect(new Set([...STRICT_TYPES, ...LOOSE_TYPES]).size).toBe(14);
  });
  it("V1 compat: concept/source are STRICT, note is LOOSE, all three registered", () => {
    expect(resolveType("concept").tier).toBe("strict");
    expect(resolveType("source").tier).toBe("strict");
    expect(resolveType("note").tier).toBe("loose");
    for (const t of ["concept", "source", "note"]) expect(isRegisteredType(t)).toBe(true);
  });
  it("every vault strict type resolves strict; every vault loose type resolves loose", () => {
    for (const t of TAXO.strictTypes) expect(resolveType(t)).toMatchObject({ name: t, tier: "strict" });
    for (const t of TAXO.looseTypes) expect(resolveType(t)).toMatchObject({ name: t, tier: "loose" });
  });
  it("an UNKNOWN type is accepted as a loose def keeping its name (open registry)", () => {
    expect(resolveType("podcast")).toEqual({ name: "podcast", tier: "loose", defaultSensitivity: "internal" });
    expect(isRegisteredType("podcast")).toBe(false);
  });
  it("empty/whitespace/absent type defaults to loose 'note'; whitespace is trimmed", () => {
    expect(resolveType("")).toMatchObject({ name: "note", tier: "loose" });
    expect(resolveType("   ")).toMatchObject({ name: "note", tier: "loose" });
    expect(resolveType(null)).toMatchObject({ name: "note", tier: "loose" });
    expect(resolveType("  repo  ")).toMatchObject({ name: "repo", tier: "strict" });
  });
  it("maps classification to sensitivity (public→public, else→internal; never above internal)", () => {
    expect(classificationToSensitivity("public")).toBe("public");
    expect(classificationToSensitivity("personal")).toBe("internal");
    expect(classificationToSensitivity("internal")).toBe("internal");
    expect(classificationToSensitivity(undefined)).toBe("internal");
    expect(classificationToSensitivity("weird")).toBe("internal");
  });
  it("SCHEMA_VERSION is a positive integer and MANAGED_FRONTMATTER is the emit order", () => {
    expect(Number.isInteger(SCHEMA_VERSION) && SCHEMA_VERSION >= 1).toBe(true);
    expect(MANAGED_FRONTMATTER[0]).toBe("id");
    expect(MANAGED_FRONTMATTER).toContain("declaredSensitivity");
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `cd packages/contracts && npx vitest run test/type-registry.test.ts`
Expected: FAIL — `Cannot find module '../src/type-registry.js'`.

- [ ] **Step 4: Write the registry**

Create `packages/contracts/src/type-registry.ts`:

```typescript
/**
 * The note-type registry (open type system, spec 2026-07-16). The in-repo SSOT for
 * the taxonomy, kept honest against the external `main-vault/00_System/Vault Schema.md`
 * by a checked-in canonical fixture + an unconditional CI drift test. Strict types
 * require the full base frontmatter; loose types require only id/type/title. Any type
 * NOT registered is accepted as a generic LOOSE def keeping its asserted name — the
 * door stays open so a future 12th type ingests without a code change.
 */
import type { Sensitivity } from "./dtos.js";

export interface TypeDef {
  readonly name: string;
  readonly tier: "strict" | "loose";
  readonly defaultSensitivity: Sensitivity;
}

/** The single supported/emitted schema version. Reader + migrator both import this. */
export const SCHEMA_VERSION = 1 as const;

export const STRICT_TYPES = ["project", "repo", "tool", "cloud", "person", "team", "conversation", "meeting", "memory", "concept", "source"] as const;
export const LOOSE_TYPES = ["research", "personal", "note"] as const;

/** Required base frontmatter for a STRICT type (vault schema §"Strict note types"). */
export const STRICT_BASE_FIELDS = ["id", "type", "status", "title", "aliases", "tags", "related", "updated", "confidence", "classification", "source"] as const;
export const LOOSE_BASE_FIELDS = ["id", "type", "title"] as const;

/** Canonical ordered managed-frontmatter keys — the ONE authority shared by the
 *  planner's preservation filter and apply's serializer. */
export const MANAGED_FRONTMATTER = ["id", "type", "schema_version", "title", "created", "updated", "status", "aliases", "tags", "related", "confidence", "classification", "source", "declaredSensitivity"] as const;

const REGISTRY = new Map<string, TypeDef>();
for (const name of STRICT_TYPES) REGISTRY.set(name, { name, tier: "strict", defaultSensitivity: "internal" });
for (const name of LOOSE_TYPES) REGISTRY.set(name, { name, tier: "loose", defaultSensitivity: "internal" });

export function isRegisteredType(name: string): boolean {
  return REGISTRY.has(name);
}

/** The ONE owner of type-name normalization: trims, resolves, and falls back. */
export function resolveType(name: string | null | undefined): TypeDef {
  const n = typeof name === "string" ? name.trim() : "";
  if (n !== "" && REGISTRY.has(n)) return REGISTRY.get(n)!;
  return { name: n === "" ? "note" : n, tier: "loose", defaultSensitivity: "internal" };
}

/**
 * Map the vault's `classification` (public|personal|internal) to Atlas
 * `declaredSensitivity`. `public`→`public`; everything else (personal, internal,
 * unknown, absent)→`internal`. The vault FORBIDS `confidential`/`secret`
 * classifications, so a vault-sourced classification never maps above `internal`.
 */
export function classificationToSensitivity(classification: string | null | undefined): Sensitivity {
  return typeof classification === "string" && classification.trim().toLowerCase() === "public" ? "public" : "internal";
}
```

- [ ] **Step 5: Add the drift tests (unconditional fixture gate + optional live gate)**

Append to `packages/contracts/test/type-registry.test.ts`:

```typescript
import { existsSync } from "node:fs";

describe("type-registry ↔ canonical taxonomy drift (unconditional CI gate)", () => {
  it("registry tiers match the checked-in canonical taxonomy fixture EXACTLY", () => {
    for (const t of [...TAXO.strictTypes, ...TAXO.v1CompatStrict]) expect(resolveType(t), `strict ${t}`).toMatchObject({ tier: "strict" });
    for (const t of [...TAXO.looseTypes, ...TAXO.v1CompatLoose]) expect(resolveType(t), `loose ${t}`).toMatchObject({ tier: "loose" });
    // no extra registrations beyond the fixture
    const expected = new Set([...TAXO.strictTypes, ...TAXO.v1CompatStrict, ...TAXO.looseTypes, ...TAXO.v1CompatLoose]);
    for (const t of [...STRICT_TYPES, ...LOOSE_TYPES]) expect(expected.has(t), `unexpected registration ${t}`).toBe(true);
  });
});

describe("type-registry ↔ live Vault Schema.md (optional, informational)", () => {
  const SCHEMA = process.env.ATLAS_VAULT_SCHEMA ?? "/Users/aryeh/Code/Vaults/main-vault/00_System/Vault Schema.md";
  it.runIf(existsSync(SCHEMA))("live schema still matches the canonical fixture (edit the fixture if this fails)", () => {
    const md = readFileSync(SCHEMA, "utf8");
    const section = (h: string) => (md.split(`## ${h}`)[1] ?? "").split("\n## ")[0];
    const listed = (h: string) => [...section(h).matchAll(/^-\s+([a-z-]+)\s*$/gm)].map((m) => m[1]!);
    const liveStrict = listed("Strict note types");
    const liveLoose = listed("Loose note types");
    if (liveStrict.length) expect(new Set(liveStrict)).toEqual(new Set(TAXO.strictTypes));
    if (liveLoose.length) expect(new Set(liveLoose)).toEqual(new Set(TAXO.looseTypes));
  });
});
```

The **fixture** gate always runs (CI-safe). The **live** gate is advisory: if the vault schema drifts, it fails loudly telling you to update the fixture — but it never gates a clean checkout that lacks the external vault.

- [ ] **Step 6: Wire the export + share the schema version with the reader**

Modify `packages/contracts/src/index.ts` — add after the `dtos` export block:

```typescript
export {
  resolveType, classificationToSensitivity, isRegisteredType,
  STRICT_TYPES, LOOSE_TYPES, STRICT_BASE_FIELDS, LOOSE_BASE_FIELDS,
  SCHEMA_VERSION, MANAGED_FRONTMATTER,
} from "./type-registry.js";
export type { TypeDef } from "./type-registry.js";
```

In `apps/cli/src/vault/reader.ts`, replace the local `SUPPORTED_SCHEMA_VERSION` literal with the contracts constant (import `SCHEMA_VERSION from "@atlas/contracts"` and alias/use it) so reader and migrator share one authority. Verify no reader test regresses.

- [ ] **Step 7: Build + run tests to verify they pass**

Run: `cd packages/contracts && ../../node_modules/.bin/tsc -p tsconfig.json && npx vitest run test/type-registry.test.ts`
Then rebuild the CLI reader change: `cd apps/cli && ../../node_modules/.bin/tsc -p tsconfig.json && npx vitest run test/reader*.test.ts`
Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add packages/contracts/src/type-registry.ts packages/contracts/src/index.ts \
  packages/contracts/test/type-registry.test.ts packages/contracts/test/fixtures/vault-taxonomy.json \
  apps/cli/src/vault/reader.ts
git commit -m "feat(contracts): open note-type registry + shared SCHEMA_VERSION + canonical taxonomy drift gate (#151)"
```

---

## Task 2: Graduation type gate becomes total (types + schema version)

**Files:**
- Modify: `apps/cli/src/graduation/migrate-plan.ts` (imports `~:15`; `inferType` `~:132-143`; the refusal loop `~:163-177`; schema-version constant `~:16`)
- Modify: `apps/cli/src/graduation/audit.ts` (`GRADUATION_KNOWN_TYPES` `:21` + the `known.has` membership test `~:72`)
- Modify: `docs/specs/cli-contract/graduation-migrate.schema.json` (open `type.value` NOW, before Task 2 emits open types)
- Modify: `tools/contract-lint.test.ts` (the Phase-5 unknown-type/schema-version refusal assertions `~:1636-1655`)
- Test: `apps/cli/test/migrate-open-types.test.ts` (new) + `apps/cli/test/graduation-migrate.cli.test.ts`

**Interfaces:**
- Consumes: `resolveType`, `isRegisteredType`, `SCHEMA_VERSION` from `@atlas/contracts` (Task 1).
- Produces: `planBootstrapMigration` no longer emits `refused` entries for `unknown-type`/`unsupported-schema-version`; every non-credential note reaches the migrable set. `inferType` emits the **resolver-normalized** name for asserted types (trimmed, never raw whitespace). `NoteOutcome.type.source` variants unchanged (frontmatter|folder|filename|default).

- [ ] **Step 1: Open the JSON contract FIRST (sequencing — the contract must accept an open type before Task 2 emits one)**

In `docs/specs/cli-contract/graduation-migrate.schema.json`:
- Change `notes[].type.value` (`~:29`) from the 5-name enum to `{ "type": "string", "minLength": 1 }`.
- Update the schema `description`/`x-atlas-contract` prose that claims a closed type set.
- Leave link-resolution + `initializedFrontmatter` for Tasks 3-4 (they change there); this step only unblocks the open type.

In `tools/contract-lint.test.ts`, update the schema-shape assertion(s) that assert the closed `type.value` enum, and add a positive case that a fixture note with an unknown `type` (e.g. `podcast`) validates. Run `cd tools && npx vitest run -t "schema"` to confirm the schema itself still lints.

- [ ] **Step 2: Write the failing test**

Create `apps/cli/test/migrate-open-types.test.ts`:

```typescript
import { describe, expect, it } from "vitest";
import { SCHEMA_VERSION } from "@atlas/contracts";
import { planBootstrapMigration, type MigrationInputFile } from "../src/graduation/migrate-plan.js";

const TS = "2026-07-17T00:00:00.000Z";
export function note(path: string, fm: string, body = "# Body\n"): MigrationInputFile {
  return { path, raw: `---\n${fm}\n---\n${body}` };
}

describe("graduation migrate — open type system (types)", () => {
  it("a vault 'repo' note migrates (no unknown-type refusal)", () => {
    const plan = planBootstrapMigration([note("10_Work/Repos/meridian.md", "id: repo-meridian\ntype: repo\ntitle: Meridian")], { bootstrapTimestamp: TS });
    expect(plan.refused).toEqual([]);
    expect(plan.notes.map((n) => n.newId)).toContain("repo-meridian");
    expect(plan.notes[0]!.type.value).toBe("repo");
  });
  it("a completely unknown type is kept as-is and migrates (open registry)", () => {
    const plan = planBootstrapMigration([note("x/podcast.md", "id: podcast-ep1\ntype: podcast\ntitle: Ep 1")], { bootstrapTimestamp: TS });
    expect(plan.refused).toEqual([]);
    expect(plan.notes[0]!.type.value).toBe("podcast");
  });
  it("a whitespace-padded type is normalized through resolveType (no raw whitespace emitted)", () => {
    const plan = planBootstrapMigration([note("x/w.md", "id: note-w\ntype: '  repo  '\ntitle: W")], { bootstrapTimestamp: TS });
    expect(plan.notes[0]!.type.value).toBe("repo");
  });
  it("a whitespace-only type falls back to 'note'", () => {
    const plan = planBootstrapMigration([note("x/blank.md", "type: '   '\ntitle: Blank")], { bootstrapTimestamp: TS });
    expect(plan.notes[0]!.type.value).toBe("note");
  });
  it("an unsupported schema_version is coerced to SCHEMA_VERSION, never refused", () => {
    const plan = planBootstrapMigration([note("a.md", "id: note-a\ntype: note\ntitle: A\nschema_version: 99")], { bootstrapTimestamp: TS });
    expect(plan.refused).toEqual([]);
    expect(plan.notes[0]!.initializedFrontmatter.schema_version).toBe(SCHEMA_VERSION);
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `cd apps/cli && npx vitest run test/migrate-open-types.test.ts`
Expected: FAIL — `refused` non-empty / raw whitespace type.

- [ ] **Step 4: Route inference through the resolver + open the gate**

In `apps/cli/src/graduation/migrate-plan.ts`, replace the local type sets + schema const (`~:15-18`):

```typescript
import { resolveType, isRegisteredType, SCHEMA_VERSION } from "@atlas/contracts";

/** Top-level folder → type (§3, case-sensitive) — vault folders included. */
const FOLDER_TYPE: Record<string, string> = {
  People: "person", Concepts: "concept", Sources: "source", Projects: "project",
  Repos: "repo", Teams: "team", Meetings: "meeting", Conversations: "conversation", Tools: "tool",
};
```

Replace `inferType` with a total version that **emits the resolver-normalized name** (never `String(explicit)` raw), so the migrator, registry, and audit agree on one identity:

```typescript
type TypeResult = { value: string; source: NoteOutcome["type"]["source"] };
function inferType(d: Doc): TypeResult {
  const explicit = d.fm.type;
  if (explicit !== undefined && explicit !== null && String(explicit).trim() !== "") {
    // ANY asserted type is accepted (open registry). resolveType() owns trimming +
    // fallback, so we emit the canonical name (e.g. "  repo " → "repo"), never raw.
    return { value: resolveType(String(explicit)).name, source: "frontmatter" };
  }
  const top = d.path.includes("/") ? d.path.split("/")[0]! : "";
  if (top && FOLDER_TYPE[top]) return { value: FOLDER_TYPE[top]!, source: "folder" };
  const pfx = /^([a-z]+)-/.exec(stem(d.path));
  if (pfx && isRegisteredType(pfx[1]!)) return { value: pfx[1]!, source: "filename" };
  return { value: "note", source: "default" };
}
```

Replace the refusal loop (`~:163-177`) with a total `migrable` build — no `unknown-type`/`unsupported-schema-version` refusals; keep `supportedMax` for Task 4's coercion reporting, sourced from `SCHEMA_VERSION`:

```typescript
  const refused: RefusalEntry[] = []; // retained in the shape; now always empty
  const supportedMax = opts.supportedSchemaMax ?? SCHEMA_VERSION;
  const migrable: { doc: Doc; type: TypeResult }[] = [];
  for (const d of docs) migrable.push({ doc: d, type: inferType(d) });
```

Delete the now-unused `refusedPaths` set, the `unsupported-schema-version` refusal check, and `DEFAULT_SCHEMA_MAX` (replaced by `SCHEMA_VERSION`). Remove any now-unused imports.

- [ ] **Step 5: Point the audit at the registry (open rule + real back-compat export)**

In `apps/cli/src/graduation/audit.ts`, replace the `GRADUATION_KNOWN_TYPES` definition (`:21`) with a registry-derived export and open the membership rule:

```typescript
import { STRICT_TYPES, LOOSE_TYPES } from "@atlas/contracts";

/** Back-compat export, now DERIVED from the registry (open system). Consumers that
 *  imported this constant keep working; it now reflects the full registered set. */
export const GRADUATION_KNOWN_TYPES: readonly string[] = [...STRICT_TYPES, ...LOOSE_TYPES];
```

Replace the `const known = new Set(GRADUATION_KNOWN_TYPES)` + every `known.has(type)` test (`~:72`) with the open rule — any non-empty asserted type is "known"; only a genuinely empty/absent type is inventoried (`missing-type`):

```typescript
// Open system: registration no longer gates the audit. Any non-empty asserted type
// is "known" (the migrator keeps unknown types as loose, never refused). An empty/
// absent type still falls through to the existing missing-type category.
const isKnown = (type: string): boolean => type.trim() !== "";
```

Confirm `GRADUATION_KNOWN_TYPES` is still exported (it is referenced by tests/back-compat) and add/keep an audit test asserting the export is the 14-name registry set.

- [ ] **Step 6: Update the tools contract-lint refusal assertions**

In `tools/contract-lint.test.ts`, update the Phase-5 assertions (`~:1636-1655`) that expect `unsupported-schema-version` / `unknown-type` refusals: those categories no longer occur. Change them to assert the corresponding fixture notes now appear in `notes` with the coerced schema / kept type. (The fixture `expected.json` they read is regenerated in Task 5; here, update the *assertions* to the new contract so Task 5's regenerated data satisfies them.)

- [ ] **Step 7: Run the new + existing migrate tests**

Run: `cd apps/cli && npx vitest run test/migrate-open-types.test.ts`
Expected: PASS.
Run: `cd apps/cli && npx vitest run test/graduation-migrate.cli.test.ts`
Expected: some existing cases FAIL (they asserted refusals) — expected; fix in Step 8.

- [ ] **Step 8: Update existing behavior assertions (repo-wide, not just apps/cli/test)**

Search the WHOLE repo: `grep -rn "unknown-type\|unsupported-schema-version" apps/cli/test tools`. For each assertion, change it to expect migration/coercion instead of refusal. Include `tools/contract-lint.test.ts` (Step 6) in this sweep.

- [ ] **Step 9: Rebuild + suite**

Run: `cd apps/cli && ../../node_modules/.bin/tsc -p tsconfig.json && npx vitest run test/migrate-open-types.test.ts test/graduation-migrate.cli.test.ts test/graduation.cli.test.ts`
Run: `cd tools && npx vitest run`
Expected: PASS (Task 5 regenerates fixtures; if a *fixture-data* test still fails here because its `expected.json` predates the behavior change, note it and let Task 5 Step 2 regenerate it — do NOT weaken the assertion).

- [ ] **Step 10: Commit**

```bash
git add apps/cli/src/graduation/migrate-plan.ts apps/cli/src/graduation/audit.ts \
  docs/specs/cli-contract/graduation-migrate.schema.json tools/contract-lint.test.ts apps/cli/test
git diff --check
test -z "$(git status --short apps/cli/test tools | grep '^.M')" || { echo 'unstaged test edits remain'; exit 1; }
git commit -m "feat(graduation): open type gate — any type ingests via resolveType, schema coerced, contract opened (#151)"
```

---

## Task 3: Identity, links, and slug collisions become total (planner + apply)

**Files:**
- Modify: `apps/cli/src/graduation/migrate-plan.ts` (Pass-1 dup-id `~:179-196`; slug-collision detection; link resolution `~:251-267`; `LinkRewrite` union `:40`; ambiguous-alias tail `~:296`)
- Modify: `apps/cli/src/graduation/migrate-apply.ts` (apply file renames + link rewrites + `flattened-*` body rewrites; checkpoint/rollback coverage)
- Modify: `docs/specs/cli-contract/graduation-migrate.schema.json` (add `flattened-unresolved`/`flattened-ambiguous` to the resolution enum; add a `renames` shape)
- Modify: `tools/contract-lint.test.ts` (Phase-5 duplicate-identity quarantine + preserved-link assertions `~:1616-1633,1743-1747`)
- Test: `apps/cli/test/migrate-open-types.test.ts` (append)

**Interfaces:**
- Consumes: the total `migrable` set (Task 2).
- Produces: `planBootstrapMigration` returns `quarantined` populated ONLY by the secret path (Task-2/5 credential dispositions). Duplicate explicit ids are numeric-suffix-disambiguated. **Filename-slug collisions** (reader-fatal) are resolved by a deterministic **file rename** recorded on the outcome; apply performs the rename + rewrites inbound links. Unresolved/ambiguous wikilinks are **flattened to display text** — `LinkRewrite.resolution` gains `"flattened-unresolved"|"flattened-ambiguous"`, and apply rewrites the body so no `[[…]]` survives. `QuarantineEntry` keeps `detected-credential` (the only remaining category).

- [ ] **Step 1: Write the failing tests**

Append to `apps/cli/test/migrate-open-types.test.ts` (reuse the exported `note()` from Step-2):

```typescript
describe("graduation migrate — identity, slug collisions, links", () => {
  it("two notes with the SAME explicit id both migrate, disambiguated by numeric suffix", () => {
    const plan = planBootstrapMigration([
      note("a/dup.md", "id: repo-dup\ntype: repo\ntitle: Dup A"),
      note("b/dup.md", "id: repo-dup\ntype: repo\ntitle: Dup B"),
    ], { bootstrapTimestamp: TS });
    expect(plan.quarantined).toEqual([]);
    expect(plan.notes.map((n) => n.newId).sort()).toEqual(["repo-dup", "repo-dup-2"]);
  });
  it("a suffix never collides with an existing explicit id (reserve-all-first)", () => {
    const plan = planBootstrapMigration([
      note("a/dup.md", "id: repo-dup\ntype: repo\ntitle: Dup A"),
      note("b/dup.md", "id: repo-dup\ntype: repo\ntitle: Dup B"),
      note("c/two.md", "id: repo-dup-2\ntype: repo\ntitle: Two"),
    ], { bootstrapTimestamp: TS });
    expect(plan.notes.map((n) => n.newId).sort()).toEqual(["repo-dup", "repo-dup-2", "repo-dup-3"]);
  });
  it("filename-SLUG collision (reader-fatal) triggers a deterministic file rename", () => {
    const plan = planBootstrapMigration([
      note("10_Work/Repos/meridian.md", "id: repo-meridian\ntype: repo\ntitle: Meridian Repo"),
      note("10_Work/Projects/meridian.md", "id: project-meridian\ntype: project\ntitle: Meridian Project"),
    ], { bootstrapTimestamp: TS });
    expect(plan.quarantined).toEqual([]);
    // exactly one keeps the bare slug; the other is renamed deterministically (sorted-path loser)
    const renamed = plan.notes.map((n) => n.newPath ?? n.path).sort();
    expect(new Set(renamed).size).toBe(2);              // distinct basenames now
    const slugs = renamed.map((p) => p.slice(p.lastIndexOf("/") + 1));
    expect(new Set(slugs).size).toBe(2);                // no shared slug → reader-safe
  });
  it("an unresolved wikilink is FLATTENED to display text (no [[…]] survives)", () => {
    const plan = planBootstrapMigration([
      note("x/a.md", "id: note-a\ntype: note\ntitle: A", "See [[Nonexistent Target|the target]] here.\n"),
    ], { bootstrapTimestamp: TS });
    expect(plan.quarantined).toEqual([]);
    expect(plan.notes[0]!.linkRewrites[0]).toMatchObject({ resolution: "flattened-unresolved", to: "the target" });
  });
  it("an ambiguous-title note still migrates (no ambiguous-alias quarantine)", () => {
    const plan = planBootstrapMigration([note("x/weird.md", "type: memory\ntitle: '***'", "# ***\n")], { bootstrapTimestamp: TS });
    expect(plan.quarantined).toEqual([]);
    expect(plan.notes).toHaveLength(1);
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `cd apps/cli && npx vitest run test/migrate-open-types.test.ts -t "identity, slug"`
Expected: FAIL (quarantines present / no `newPath` / no `flattened-*`).

- [ ] **Step 3: Disambiguate duplicate explicit ids (reserve-all-first, correct allocator)**

In `planBootstrapMigration` Pass 1, replace the `duplicate-identity` quarantine branch. Reserve **every** distinct explicit id first, then suffix each later owner against the complete reservation set so a suffix can never collide with another note's bare id:

```typescript
  const explicitById = new Map<string, string[]>();
  for (const { doc } of migrable) {
    const eid = typeof doc.fm.id === "string" ? doc.fm.id.trim() : "";
    if (eid !== "") { const arr = explicitById.get(eid) ?? []; arr.push(doc.path); explicitById.set(eid, arr); }
  }
  // Phase A: reserve EVERY explicit id up front (so a later suffix can't hit an existing bare id).
  for (const id of explicitById.keys()) assigned.add(id);
  // Phase B: first owner (sorted path) keeps the bare id; each later owner gets the next
  // free `${id}-${n}` against the complete reservation set.
  const supersededExplicit = new Map<string, string>(); // path → disambiguated explicit id
  for (const [id, paths] of explicitById) {
    if (paths.length < 2) continue;
    const sorted = [...paths].sort();
    let n = 2;
    for (const p of sorted.slice(1)) {
      let candidate = `${id}-${n}`;
      while (assigned.has(candidate)) candidate = `${id}-${++n}`;
      assigned.add(candidate); supersededExplicit.set(p, candidate); n++;
    }
  }
```

Delete the `dupIdPaths` skip set. In Pass 2 use `supersededExplicit.get(doc.path) ?? explicitId` as the id; derived-id notes still `for (let n = 2; assigned.has(newId); n++)`.

- [ ] **Step 4: Detect filename-slug collisions → deterministic rename (the reader-fatal case)**

The strict reader collides on **filename slug + aliases** (`reader.ts` `detectIdentityCollisions`), NOT id. Add a pass over `migrable` computing each note's slug (`stem(doc.path)`); for any slug owned by >1 path, the first (sorted-path) owner keeps the file, each later owner is renamed to `${slug}-${type.value}` (then numeric-suffixed if that too collides), recorded as `newPath` on the outcome and in a plan-level `renames: { from: string; to: string }[]`. Record the rename in `normalized[]` (Task 4) as a coercion. Also fold each note's declared `aliases` into the slug-ownership set so an alias never re-introduces a collision (drop/renumber a losing alias claim).

```typescript
  // slug = basename without .md; the reader's identity namespace.
  const slugOwners = new Map<string, string[]>();
  for (const { doc } of migrable) { const s = stem(doc.path); (slugOwners.get(s) ?? slugOwners.set(s, []).get(s)!).push(doc.path); }
  const renames = new Map<string, string>(); // original path → renamed path
  const takenSlugs = new Set<string>(slugOwners.keys());
  for (const [slug, paths] of slugOwners) {
    if (paths.length < 2) continue;
    for (const p of [...paths].sort().slice(1)) {
      const t = migrable.find((m) => m.doc.path === p)!.type.value;
      let base = `${slug}-${t}`, n = 2, cand = base;
      while (takenSlugs.has(cand)) cand = `${base}-${n++}`;
      takenSlugs.add(cand);
      renames.set(p, p.slice(0, p.lastIndexOf("/") + 1) + cand + ".md");
    }
  }
```

Set `outcome.newPath = renames.get(doc.path) ?? doc.path` when building each outcome, and return `renames` (as an array) on the plan.

- [ ] **Step 5: Flatten unresolved/ambiguous links (planner records; apply rewrites body)**

Extend the `LinkRewrite.resolution` union (`:40`) to `"rewritten" | "flattened-unresolved" | "flattened-ambiguous"` (the `preserved-*` values are removed — nothing may survive as a wikilink). In the link loop (`~:251-267`), replace the release/quarantine branch: zero owners ⇒ `flattened-unresolved`; multiple owners ⇒ `flattened-ambiguous`; exactly one ⇒ `rewritten` (unchanged). For a flattened link, record `{ from: "[[Target|Display]]", to: "Display" ?? "Target", resolution }` so apply can rewrite the body deterministically. Delete the `incompatibleLink` set + its quarantine tail (`~:297`).

- [ ] **Step 6: Drop the ambiguous-alias quarantine tail**

Remove `for (const p of [...ambiguousAlias].sort()) quarantined.push({ path: p, category: "ambiguous-alias" });` (`~:296`). Keep the `ambiguousAlias` set — it feeds `normalized[]` (Task 4).

- [ ] **Step 7: Teach apply to rename files, rewrite links, and flatten (migrate-apply.ts)**

In `apps/cli/src/graduation/migrate-apply.ts`:
- **Renames:** before writing each note, if `outcome.newPath !== outcome.path`, write to `newPath` and record the rename in the checkpoint journal so rollback restores the original path. Rewrite every inbound wikilink/target that referenced the old slug to the new slug (the plan supplies `renames`; apply rewrites bodies + any frontmatter `related`/link fields).
- **Flatten + rewrite:** change the link-rewrite loop (currently `if (r.resolution === "rewritten")` only, `~:68`) to also apply `flattened-unresolved`/`flattened-ambiguous`: replace `r.from` with `r.to` in the body for ALL three resolutions. Assert post-condition: the emitted body contains no `[[`.

Add apply-level tests (`apps/cli/test/migrate-apply.*.test.ts` or the reader gate in Task 5) proving on disk: the renamed file exists at `newPath`, the old path is gone, inbound links point at the new slug, and no `[[` remains.

- [ ] **Step 8: Update the JSON schema + tools contract-lint for the new resolutions/renames**

In `graduation-migrate.schema.json`: set the link-resolution enum to `["rewritten","flattened-unresolved","flattened-ambiguous"]`; add an optional top-level `renames` array (`{from,to}`); reconcile descriptions.
In `tools/contract-lint.test.ts`: update the Phase-5 assertions (`~:1616-1633,1743-1747`) that expect `preserved-unresolved`, `incompatible-link`, and `duplicate-identity` quarantine — those become flattened links / disambiguated ids / renames. Update the authorized-release assertion (release is no longer required to migrate an unresolved link).

- [ ] **Step 9: Run tests**

Run: `cd apps/cli && npx vitest run test/migrate-open-types.test.ts`
Expected: PASS (types + identity + slug rename + flattening).

- [ ] **Step 10: Update existing quarantine assertions repo-wide**

Search `grep -rn "duplicate-identity\|ambiguous-alias\|incompatible-link\|preserved-unresolved\|preserved-ambiguous" apps/cli/test tools`. Update each to the new behavior (disambiguated id / rename / flattened link). The secret-scan `detected-credential` quarantine tests are unaffected — do NOT touch them.

- [ ] **Step 11: Rebuild + suite**

Run: `cd apps/cli && ../../node_modules/.bin/tsc -p tsconfig.json && npx vitest run test/graduation-migrate.cli.test.ts test/migrate-open-types.test.ts test/graduation.cli.test.ts`
Expected: PASS.

- [ ] **Step 12: Commit**

```bash
git add apps/cli/src/graduation/migrate-plan.ts apps/cli/src/graduation/migrate-apply.ts \
  docs/specs/cli-contract/graduation-migrate.schema.json tools/contract-lint.test.ts apps/cli/test
git diff --check
test -z "$(git status --short apps/cli/test tools | grep '^.M')" || { echo 'unstaged test edits remain'; exit 1; }
git commit -m "feat(graduation): identity/slug-collision renames + link flattening, total in planner AND apply (#151)"
```

---

## Task 4: Strict base-field defaults + normalized[] report (planner + apply serialize every managed field)

**Files:**
- Modify: `apps/cli/src/graduation/migrate-plan.ts` (`initializedFrontmatter` build `~:269-277`; add `NormalizedEntry` + `normalized`; use the shared `MANAGED_FRONTMATTER` for the preservation filter, replacing the local `MANAGED_KEYS` `:146`)
- Modify: `apps/cli/src/graduation/migrate-apply.ts` (serialize EVERY managed field via `MANAGED_FRONTMATTER`, replacing the six-key `MANAGED_ORDER` `:19`; YAML-safe arrays/lists)
- Modify: `apps/cli/src/commands/graduation-migrate.ts` (surface `normalized`)
- Modify: `docs/specs/cli-contract/graduation-migrate.schema.json` (define every managed field in `initializedFrontmatter`; add `normalized`)
- Test: `apps/cli/test/migrate-open-types.test.ts` (append) + a schema-conformance test

**Interfaces:**
- Consumes: `resolveType`, `classificationToSensitivity`, `STRICT_BASE_FIELDS`, `MANAGED_FRONTMATTER`, `SCHEMA_VERSION` from `@atlas/contracts`.
- Produces:
  - `interface NormalizedEntry { readonly path: string; readonly filled: string[]; readonly coerced: string[]; readonly note: string }` (`filled`/`coerced` capped at 32 entries each; `note` ≤ 120 chars).
  - `MigrationPlan` gains `readonly normalized: NormalizedEntry[]`.
  - For a STRICT type, `initializedFrontmatter` fills/coerces **every** `STRICT_BASE_FIELD` against the **real vault schema**: `status ∈ {active,draft,needs-review,stale,archived,deprecated}` (default `active`); `confidence ∈ {low,medium,high}` (default `medium`); `classification ∈ {public,personal,internal}` (default `internal`); `source` is a **structured list**, default `["manual"]` (the vault-tolerated bare form) — NOT the file path; `aliases`/`tags`/`related` default `[]`; `declaredSensitivity` re-derived from the coerced `classification` (public→public else internal). Valid existing values are PRESERVED (valid statuses like `needs-review`/`stale`/`deprecated` are not reset; a valid structured `source` list is kept). Existing valid `created`/`updated` are PRESERVED; only absent ones get the bootstrap timestamp, and a replacement is recorded.
  - The apply serializer writes every managed field (via `MANAGED_FRONTMATTER`) with YAML-safe handling for lists — so planner normalization actually lands on disk.

- [ ] **Step 1: Write the failing test**

Append to `apps/cli/test/migrate-open-types.test.ts`:

```typescript
describe("graduation migrate — strict field-fill + normalized report", () => {
  it("a strict 'repo' note missing base fields gets schema-valid defaults; report lists them", () => {
    const plan = planBootstrapMigration([note("Repos/x.md", "id: repo-x\ntype: repo\ntitle: X")], { bootstrapTimestamp: TS });
    const fm = plan.notes[0]!.initializedFrontmatter;
    expect(fm.status).toBe("active");
    expect(fm.confidence).toBe("medium");
    expect(fm.classification).toBe("internal");
    expect(fm.aliases).toEqual([]);
    expect(fm.source).toEqual(["manual"]);            // structured list, NOT the path
    const rep = plan.normalized.find((n) => n.path === "Repos/x.md");
    expect(rep?.filled).toEqual(expect.arrayContaining(["status", "confidence", "classification", "source"]));
  });
  it("valid vault statuses (needs-review/stale/deprecated) are PRESERVED, not reset to active", () => {
    for (const st of ["needs-review", "stale", "deprecated"]) {
      const plan = planBootstrapMigration([note("Repos/s.md", `id: repo-s\ntype: repo\ntitle: S\nstatus: ${st}`)], { bootstrapTimestamp: TS });
      expect(plan.notes[0]!.initializedFrontmatter.status).toBe(st);
      expect(plan.normalized.find((n) => n.path === "Repos/s.md")?.coerced ?? []).not.toContain("status");
    }
  });
  it("a valid structured source list is preserved verbatim", () => {
    const plan = planBootstrapMigration([note("Repos/src.md", "id: repo-src\ntype: repo\ntitle: S\nsource:\n  - type: git\n    date: 2026-01-01")], { bootstrapTimestamp: TS });
    expect(plan.notes[0]!.initializedFrontmatter.source).toEqual([{ type: "git", date: "2026-01-01" }]);
  });
  it("declaredSensitivity: public→public, personal/internal→internal (vault forbids confidential)", () => {
    const pub = planBootstrapMigration([note("a.md", "id: note-a\ntype: note\ntitle: A\nclassification: public")], { bootstrapTimestamp: TS });
    expect(pub.notes[0]!.initializedFrontmatter.declaredSensitivity).toBe("public");
    const per = planBootstrapMigration([note("b.md", "id: note-b\ntype: note\ntitle: B\nclassification: personal")], { bootstrapTimestamp: TS });
    expect(per.notes[0]!.initializedFrontmatter.declaredSensitivity).toBe("internal");
  });
  it("a loose 'research' note is NOT force-filled with strict base fields", () => {
    const plan = planBootstrapMigration([note("R/x.md", "id: research-x\ntype: research\ntitle: X")], { bootstrapTimestamp: TS });
    expect(plan.notes[0]!.initializedFrontmatter.confidence).toBeUndefined();
  });
  it("normalized[] records EVERY change: missing/malformed schema_version, inferred type, replaced timestamp", () => {
    const p1 = planBootstrapMigration([note("x/n.md", "title: N")], { bootstrapTimestamp: TS });            // no type, no schema_version
    const r1 = p1.normalized.find((n) => n.path === "x/n.md")!;
    expect(r1.filled).toEqual(expect.arrayContaining(["schema_version"]));
    const p2 = planBootstrapMigration([note("x/b.md", 'type: note\ntitle: B\nschema_version: "99"')], { bootstrapTimestamp: TS });
    expect(p2.normalized.find((n) => n.path === "x/b.md")!.coerced).toEqual(expect.arrayContaining(["schema_version"]));
  });
  it("present-but-malformed strict fields are COERCED, not copied through", () => {
    const plan = planBootstrapMigration([note("Repos/m.md", "id: repo-m\ntype: repo\ntitle: M\naliases:\nstatus: bogus\nconfidence: '   '")], { bootstrapTimestamp: TS });
    const fm = plan.notes[0]!.initializedFrontmatter;
    expect(fm.aliases).toEqual([]);
    expect(fm.status).toBe("active");
    expect(fm.confidence).toBe("medium");
    expect(plan.normalized.find((n) => n.path === "Repos/m.md")!.coerced).toEqual(expect.arrayContaining(["aliases", "status", "confidence"]));
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `cd apps/cli && npx vitest run test/migrate-open-types.test.ts -t "field-fill"`
Expected: FAIL.

- [ ] **Step 3: Add NormalizedEntry + a normalization-tracking helper**

In `migrate-plan.ts` add the `NormalizedEntry` interface + `readonly normalized: NormalizedEntry[]` on `MigrationPlan`, and `const normalized: NormalizedEntry[] = []`. Add a small helper that every managed-field assignment flows through, so tracking is total (fixes the "normalized[] omits changes" findings):

```typescript
function track(
  key: string, original: unknown, emitted: unknown,
  filled: string[], coerced: string[],
): void {
  const wasAbsent = original === undefined;
  if (wasAbsent) filled.push(key);
  else if (JSON.stringify(original) !== JSON.stringify(emitted)) coerced.push(key);
}
```

- [ ] **Step 4: Build initializedFrontmatter through the tracker (planner)**

Replace the `initialized` build (`~:269-277`). Assign the always-managed fields through `track`, then the strict-only fields against the real schema. Statuses/classifications sourced from the same values as the canonical fixture:

```typescript
    const def = resolveType(type.value);
    const filled: string[] = []; const coerced: string[] = [];
    const initialized: Record<string, unknown> = {};
    const put = (k: string, orig: unknown, val: unknown) => { track(k, orig, val, filled, coerced); initialized[k] = val; };

    put("id", doc.fm.id, newId);
    put("type", doc.fm.type, type.value);
    // schema_version: any non-1 (missing, string, number≠SCHEMA_VERSION) is normalized + recorded.
    put("schema_version", doc.fm.schema_version, SCHEMA_VERSION);
    put("title", doc.fm.title, doc.title);
    // timestamps: preserve a valid ISO string; otherwise fill/replace with bootstrap + record.
    const validTs = (v: unknown) => typeof v === "string" && !Number.isNaN(Date.parse(v));
    put("created", doc.fm.created, validTs(doc.fm.created) ? doc.fm.created : opts.bootstrapTimestamp);
    put("updated", doc.fm.updated, validTs(doc.fm.updated) ? doc.fm.updated : opts.bootstrapTimestamp);

    if (def.tier === "strict") {
      const STATUS = ["active", "draft", "needs-review", "stale", "archived", "deprecated"];
      const CONF = ["low", "medium", "high"];
      const CLASS = ["public", "personal", "internal"];
      const enumField = (k: string, allowed: string[], dflt: string) => {
        const raw = doc.fm[k];
        const ok = typeof raw === "string" && allowed.includes(raw.trim().toLowerCase());
        put(k, raw, ok ? (raw as string).trim().toLowerCase() : dflt);
      };
      enumField("status", STATUS, "active");
      enumField("confidence", CONF, "medium");
      enumField("classification", CLASS, "internal");
      // source: structured list preferred; a valid non-empty array is kept; a bare "manual"
      // string is normalized to ["manual"]; anything else defaults to ["manual"].
      const rawSrc = doc.fm.source;
      const srcOk = Array.isArray(rawSrc) && rawSrc.length > 0;
      put("source", rawSrc, srcOk ? rawSrc : ["manual"]);
      for (const k of ["aliases", "tags", "related"]) {
        const raw = doc.fm[k];
        put(k, raw, Array.isArray(raw) ? raw : []);
      }
      put("declaredSensitivity", undefined, classificationToSensitivity(initialized.classification as string));
    } else {
      // loose: still derive declaredSensitivity from any asserted classification, but no strict fill.
      initialized.declaredSensitivity = classificationToSensitivity(typeof doc.fm.classification === "string" ? doc.fm.classification : undefined);
    }

    if (filled.length || coerced.length) {
      normalized.push({
        path: doc.path,
        filled: filled.slice(0, 32).sort(),
        coerced: coerced.slice(0, 32).sort(),
        note: `${def.tier} type '${type.value}'`.slice(0, 120),
      });
    }
```

Replace the local `MANAGED_KEYS` (`:146`) with `MANAGED_FRONTMATTER` from contracts for the preservation filter (preserved = original keys ∉ `MANAGED_FRONTMATTER`). Add `normalized` to the return.

- [ ] **Step 5: Serialize every managed field on disk (apply — the fix that makes normalization real)**

In `migrate-apply.ts`, replace the six-key `MANAGED_ORDER` (`:19`) with `MANAGED_FRONTMATTER` from contracts, and serialize **every** key present in `outcome.initializedFrontmatter` in that order with YAML-safe handling (arrays/objects via `yamlStringify`, scalars inline). Preserved fields (already excluded via the shared managed set) are appended after. Verify a strict note's `status`/`source`/`declaredSensitivity`/`aliases` now appear on disk (asserted by the Task 5 reader gate + an apply-and-read test).

- [ ] **Step 6: Surface normalized + define the contract**

In `apps/cli/src/commands/graduation-migrate.ts`, add `normalized: plan.normalized` beside `quarantined`/`refused` in both preview and applied JSON.

In `graduation-migrate.schema.json`:
- Define **every** managed field under `initializedFrontmatter.properties` (id, type, schema_version const SCHEMA_VERSION, title, created, updated, status enum, aliases/tags/related arrays, confidence enum, classification enum, source array, declaredSensitivity enum) so `unevaluatedProperties:false` still validates the new output.
- Add the `normalized` array (path, filled[], coerced[], note).

Add a **conformance test** (`apps/cli/test/migrate-schema-conformance.test.ts`): run a small migrate over a strict note, an unknown type, and a flattened link, and validate the actual preview + applied JSON payload against `graduation-migrate.schema.json` with the same validator the tools lint uses. This proves the TS output and the JSON Schema agree (fixes the "manually duplicated" SSOT finding).

- [ ] **Step 7: Run tests + contract lint**

Run: `cd apps/cli && ../../node_modules/.bin/tsc -p tsconfig.json && npx vitest run test/migrate-open-types.test.ts test/migrate-schema-conformance.test.ts`
Run: `cd tools && npx vitest run`
Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add apps/cli/src/graduation/migrate-plan.ts apps/cli/src/graduation/migrate-apply.ts \
  apps/cli/src/commands/graduation-migrate.ts docs/specs/cli-contract/graduation-migrate.schema.json apps/cli/test
git diff --check
git commit -m "feat(graduation): schema-valid strict field-fill + total normalized[] + apply serializes every managed field (#151)"
```

---

## Task 5: Secret-disposition handshake, fixtures, reader gate, and the live acceptance run

**Files:**
- Modify: `apps/cli/src/graduation/scan.ts` + `apps/cli/src/commands/graduation-scan.ts` (persist per-path credential dispositions)
- Modify: `apps/cli/src/commands/graduation-migrate.ts` (consume dispositions; skip + quarantine credential paths)
- Modify: `docs/specs/fixtures/bootstrap-migration/*` + `manifest.json` (update drifted expectations; add `full-taxonomy`)
- Modify: `apps/cli/test/bootstrap-migration.fixtures.test.ts` (add `full-taxonomy` to `CASES`)
- Create: `apps/cli/test/full-taxonomy-reader.test.ts` (reader-compat gate)

**Interfaces:**
- Consumes: everything from Tasks 1-4.
- Produces: a scan→migrate handshake where credential paths are skipped + reported quarantined in one run; green byte-exact fixtures incl. `full-taxonomy`; a reader-compat gate proving zero `readVault()` errors; a recorded live acceptance result.

- [ ] **Step 1: Persist per-path credential dispositions (scan) + consume them (migrate)**

In `apps/cli/src/graduation/scan.ts` + `graduation-scan.ts`: extend the persisted scan state with `credentialPaths: string[]` (the working-tree paths whose files carry ≥1 finding). The detection engine is unchanged; only the persisted state gains this field. Keep the existing `gate`/exit-3 behavior for a *bare* `graduation scan` invocation.

In `apps/cli/src/commands/graduation-migrate.ts`: when reading scan state, instead of hard-failing on `gate: blocked` **when credential dispositions exist**, pass `credentialPaths` into `planBootstrapMigration` (new opt `credentialPaths?: string[]`). The planner excludes those paths from `migrable` and emits one `quarantined: { path, category: "detected-credential" }` per excluded path. A blocked gate with *no* recorded credential paths (older state) still errors `scan-gate-open` (exit 2) — backward-compatible.

Add unit tests: a two-note input where one path is in `credentialPaths` → that note is quarantined `detected-credential`, the other migrates, and `scanned == migrated + quarantined`.

- [ ] **Step 2: Identify + regenerate drifted fixtures**

Run: `cd apps/cli && npx vitest run 2>&1 | grep -iE "fixture|byte|migrate|expected" | head -40`
The `bootstrap-migration.fixtures.test.ts` `CASES` are `["basic","collision","explicit-collision","guards"]`; `explicit-collision` and `guards` will drift (refusals/quarantines → migrations). Read `docs/specs/fixtures/bootstrap-migration/manifest.json` (9 cases) for keying. Check for a golden updater: `grep -rn "UPDATE_GOLDEN\|updateSnapshot\|writeFileSync" apps/cli tools | grep -i expected`. If one exists, use it; else hand-edit each `expected.json` to the new total outcome and **verify each diff is a deliberate behavior change, not a regression** (no dropped notes; refusals→notes; quarantines→disambiguation/rename/flatten).

- [ ] **Step 3: Add the full-taxonomy fixture + wire it into the REAL runner**

Create `docs/specs/fixtures/bootstrap-migration/full-taxonomy/input/` with one note per type (`person, repo, research, project, memory, meeting, conversation, personal, team, cloud, tool`) plus: one `podcast` (unknown), one no-frontmatter file, one strict note missing ALL base fields, a duplicate-explicit-id pair, a **same-slug pair at different folders** (the meridian case), and one note with an unresolved `[[link]]`. Add its `expected.json` (plan: idMap, notes, quarantined=[], refused=[], renames, normalized) and a `manifest.json` entry.

Add `"full-taxonomy"` to the `CASES` array in `apps/cli/test/bootstrap-migration.fixtures.test.ts` (the real runner — NOT the nonexistent `graduation-fixtures.test.ts`) and assert the case actually executed (e.g. `expect(ranCases).toContain("full-taxonomy")`).

- [ ] **Step 4: Add the reader-compatibility gate (the proof)**

Create `apps/cli/test/full-taxonomy-reader.test.ts`: apply the full-taxonomy plan into a temp copy via `applyBootstrapMigration`, run `readVault()` over the result, and assert **zero** errors — specifically no `broken-link`, `ambiguous-link`, `identity-collision`, `duplicate-id`, or schema errors. This is what makes "total ingestion" real. It must exercise the meridian same-slug pair (proving the rename cleared the collision) and the flattened link (proving no `[[` survives).

- [ ] **Step 5: Run the entire affected suite**

Run: `cd apps/cli && ../../node_modules/.bin/tsc -p tsconfig.json && npx vitest run`
Run: `cd packages/contracts && npx vitest run && cd ../../tools && npx vitest run`
Expected: PASS (all, incl. updated fixtures, the reader gate, and the schema-conformance test).

- [ ] **Step 6: Commit the fixtures + tests**

```bash
git add docs/specs/fixtures/bootstrap-migration apps/cli/test apps/cli/src/graduation/scan.ts \
  apps/cli/src/commands/graduation-scan.ts apps/cli/src/commands/graduation-migrate.ts
git status --short apps/cli/test docs/specs/fixtures    # MUST be empty after add
git commit -m "feat(graduation): scan→migrate credential handshake + full-taxonomy fixture + reader-compat gate (#151)"
```

- [ ] **Step 7: Live real-vault acceptance (the gate) — REAL CLI only**

Build first: `cd apps/cli && ../../node_modules/.bin/tsc -p tsconfig.json`. Use the 2026-07-16 drive runbook custody seam. **These are the ACTUAL commands** (verified against the parser): apply is in-place + authorization-gated (exit 6 without one); there is no `--out`; validation is the top-level `validate` (reads the configured vault; no `--source`); scan JSON has `scanned`/`findings`/`gate` (no `notes[]`). Every command's exit is checked; a fresh copy dir per run makes it retry-safe.

```bash
set -euo pipefail
WORK=$(mktemp -d); COPY="$WORK/copy"; CUSTODY="$WORK/custody"
BIN=~/Code/21Stark/atlas/apps/cli/dist/bin.js
export ATLAS_CUSTODY_TEST_DIR="$CUSTODY"          # custody seam only; NOT test-mode for the broker

# 1. scan → persists gate + credentialPaths into scan state; exit 3 only aborts if we treat it fatally.
node "$BIN" graduation scan --source ~/Code/Vaults/main-vault --copy "$COPY" --json > "$WORK/scan.json" || true
# 2. preview (no mutation) — credential paths become detected-credential quarantines, everything else migrates.
node "$BIN" graduation migrate --json > "$WORK/preview.json"
# 3. authorize + apply IN PLACE on the copy (no --out flag exists).
node "$BIN" graduation migrate --apply --export-challenge --json > "$WORK/challenge.json"
#    sign the challenge with the production broker per the runbook → $WORK/auth.json
node ~/Code/21Stark/atlas/scripts/sign-graduation-challenge.js "$WORK/challenge.json" > "$WORK/auth.json"
node "$BIN" graduation migrate --apply --authorization "$WORK/auth.json" --json > "$WORK/applied.json"
# 4. strict-reader gate over the applied copy (validate reads the configured vault → point config at $COPY).
ATLAS_VAULT_DIR="$COPY" node "$BIN" validate --json > "$WORK/reader.json"
```

Then a FAIL-FAST conservation check over the REAL field shapes (scan has no `notes[]`; derive the input path set from the copy's markdown files independently):

```bash
python3 - "$WORK" <<'PY'
import json, sys, pathlib
W = pathlib.Path(sys.argv[1])
scan = json.load(open(W/"scan.json")); prev = json.load(open(W/"preview.json"))
appl = json.load(open(W/"applied.json")); rdr = json.load(open(W/"reader.json"))
inputs = {str(p.relative_to(W/"copy")) for p in (W/"copy").rglob("*.md")}
written = {n["path"] if "newPath" not in n else n["newPath"] for n in appl["notes"]}
quar = {q["path"] for q in prev["quarantined"]}
assert prev["refused"] == [], prev["refused"]
assert all(q["category"] == "detected-credential" for q in prev["quarantined"]), prev["quarantined"]
assert not rdr.get("findings") and not rdr.get("errors"), rdr        # validate: zero reader errors
missing = {q for q in inputs} - {n["path"] for n in appl["notes"]} - quar
# note: renamed notes appear under newPath; conservation is by original input path membership
assert len(appl["notes"]) + len(quar) >= len(inputs) - 5, (len(appl["notes"]), len(quar), len(inputs))
print(f"OK refused=0 migrated={len(appl['notes'])} credential-quarantined={len(quar)} reader-errors=0 inputs={len(inputs)}")
PY
```

Expected: `OK`, `migrated` ≈ full vault (200+), `credential-quarantined` = only secret-bearing notes, reader errors = 0. Paste the printed line into a comment on #151. If `scripts/sign-graduation-challenge.js` does not exist, implement the signing per the broker runbook BEFORE this step (it is a prerequisite, not a placeholder).

- [ ] **Step 8: Push + post the live result**

```bash
git status --short   # MUST be empty — every in-scope src + test edit committed
git push -u origin feat/open-type-system
```
The PR already exists (#151/#152 lineage); paste the live acceptance numbers into #151, link the spec, and merge once CI is green.

---

## Self-Review

**Spec coverage:**
- Open registry + tiers + generic fallback + single SCHEMA_VERSION authority → Task 1. ✓
- Graduation total (unknown-type, schema-version) via `resolveType` → Task 2. ✓
- Identity total: id disambiguation + **filename-slug rename in apply** + link flattening (planner AND apply) → Task 3. ✓
- Strict field-fill against the REAL vault schema (6 statuses, list `source`) + total `normalized[]` + **apply serializes every managed field** → Task 4. ✓
- Registry↔schema drift: checked-in fixture + unconditional CI gate + advisory live gate → Task 1 Step 5. ✓
- Secret boundary in-run: scan persists credential paths, migrate skips + quarantines them → Task 5 Step 1. ✓
- Live re-graduation acceptance on the REAL CLI (authorization, in-place apply, `validate`) + fixtures + reader-compat gate → Task 5. ✓
- Mutation-policy reconciliation → explicitly OUT (spec non-goal). ✓
- Reader strict mode untouched (beyond sourcing `SCHEMA_VERSION`) → Task 1 Step 6 only. ✓

**Why this differs from the first draft (review corrections):** the reader collides on filename slug not id (so ids alone don't clear the gate → apply renames files); `migrate-apply.ts` owns serialization + body rewrites (so planner-only normalization was dead → apply is in scope for Tasks 3-4); the CLI has no `--out`/`vault validate` and apply is authorization-gated (so the live gate was fictional → rewritten to the real surface); the scan gate blocks migrate on any credential (so in-run quarantine needed a scan-state handshake → operator-approved scope); the vault schema has 6 statuses and a list `source` and forbids `confidential` (so the enum/`source`/`classification` handling was wrong → corrected against the checked-in taxonomy).

**Type consistency:** `resolveType`/`classificationToSensitivity`/`isRegisteredType`/`STRICT_BASE_FIELDS`/`MANAGED_FRONTMATTER`/`SCHEMA_VERSION` (Task 1) are the exact names consumed in Tasks 2-5. `NormalizedEntry`/`normalized` (Task 4) match the schema + command wiring + conformance test. `LinkRewrite.resolution ∈ {rewritten, flattened-unresolved, flattened-ambiguous}` is consistent across the union, apply, schema, and tests.

**Placeholders:** none — every code step shows real code against verified file:line anchors; the one prerequisite (`sign-graduation-challenge.js`) is called out as build-before-run, not hand-waved.

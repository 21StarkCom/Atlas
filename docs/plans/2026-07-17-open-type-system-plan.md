# Open Type System Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make Atlas graduation ingest *every* note of the real vault's 11-type taxonomy (currently 122/206 refused for unrecognized type), normalizing any gap with deterministic judgement, while secrets remain the one quarantine boundary.

**Architecture:** A data-driven type registry in `@atlas/contracts` mirrors `main-vault/00_System/Vault Schema.md` (11 types, strict/loose tiers, classification→sensitivity). Graduation's `migrate-plan.ts` becomes a *total function*: the `unknown-type` and `unsupported-schema-version` refusals are removed (unknown → loose, kept; schema coerced), duplicate-identity/ambiguous-alias/incompatible-link stop quarantining and instead disambiguate / keep / migrate-verbatim, and strict-type base fields are filled with judgement defaults. A per-note `normalized[]` report records every applied default. The strict vault reader is untouched — it runs on the normalized, well-formed output.

**Tech Stack:** TypeScript (strict/ESM/NodeNext), Node ≥ 24, pnpm, vitest. Build per package with `../../node_modules/.bin/tsc -p tsconfig.json` (the pnpm global wrapper is broken — use tsc directly or `/opt/homebrew/bin/pnpm` only if healthy). Run tests with `npx vitest run` from the package dir.

## Global Constraints

- TypeScript strict / ESM / NodeNext; compile with `tsc` (no runtime type-stripping in prod).
- Commits authored `Aryeh Stark <aryeh@21stark.com>` (per-repo git config already set).
- Branch + PR for everything; every review finding lands on the PR. Merge to `main` once CI green (no canary).
- Graduation stays DETERMINISTIC: pure function of input vault + config, no wall-clock, no per-note LLM/egress calls. Byte-exact fixtures under `docs/specs/fixtures/bootstrap-migration/` remain the contract.
- Secret-scan boundary is unchanged: a detected credential still quarantines (this plan never touches `graduation/scan.ts` or the scan engine).
- Do NOT modify the spec-locked mutation-policy table (`policies/mutation-policy.ts`, `workflow-risk-contract.md`) — out of scope (spec non-goal).
- Exit codes unchanged: `0` ok · `1` validation · `2` config · `3` secret-scan · `4` internal · `5` usage · `6` action-required.

**Spec:** `docs/specs/2026-07-16-open-type-system-spec.md`. **Issue:** #151.

---

## File Structure

- **Create** `packages/contracts/src/type-registry.ts` — the type registry: the 11 vault types + V1's `note`/`concept`/`source`, each with `tier` and `defaultSensitivity`; `classificationToSensitivity()`; `resolveType()` (registered → its def; unknown → generic loose def). One responsibility: "what does Atlas know about a note type".
- **Modify** `packages/contracts/src/index.ts` — re-export the registry.
- **Create** `packages/contracts/test/type-registry.test.ts` — unit + drift test vs `Vault Schema.md`.
- **Modify** `apps/cli/src/graduation/migrate-plan.ts` — consume the registry; remove the two refusal branches; turn dup-identity/ambiguous-alias/incompatible-link total; fill strict base-field defaults; emit `normalized[]`.
- **Modify** `apps/cli/src/graduation/audit.ts` — `GRADUATION_KNOWN_TYPES` sources from the registry so the read-only audit's `unknown-type` inventory matches the open set.
- **Modify** `apps/cli/src/commands/graduation-migrate.ts` + `docs/specs/cli-contract/graduation-migrate.schema.json` — surface `normalized[]` in the command output + its schema.
- **Modify** fixtures under `docs/specs/fixtures/bootstrap-migration/` — update expectations for the now-total behavior; add a `full-taxonomy` fixture.
- **Modify** `apps/cli/test/graduation-migrate.cli.test.ts` and `apps/cli/test/*migrate*` — behavior assertions.

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

All Task 1-5 commits land on this branch; never commit on `main`.

---

## Task 1: Type registry in @atlas/contracts

**Files:**
- Create: `packages/contracts/src/type-registry.ts`
- Modify: `packages/contracts/src/index.ts`
- Test: `packages/contracts/test/type-registry.test.ts`

**Interfaces:**
- Consumes: `Sensitivity` from `./dtos.js` (`"public" | "internal" | "confidential" | "restricted"`).
- Produces:
  - `interface TypeDef { name: string; tier: "strict" | "loose"; defaultSensitivity: Sensitivity }`
  - `const STRICT_TYPES: readonly string[]` = `["project","repo","tool","cloud","person","team","meeting","conversation","memory"]`
  - `const LOOSE_TYPES: readonly string[]` = `["research","personal"]`
  - `note`/`concept`/`source` — V1 compat types folded into the sets above: `concept`/`source` strict, `note` loose.
  - `function resolveType(name: string | null | undefined): TypeDef` — registered name → its def; unknown/empty → `{ name: name||"note", tier: "loose", defaultSensitivity: "internal" }`.
  - `function classificationToSensitivity(classification: string | null | undefined): Sensitivity` — fail UP: `public`→`public`; `internal`/absent→`internal`; `personal` + any unrecognized non-empty value → `confidential`; explicit `confidential`/`restricted` preserved. Never downgrades a sensitive note to `internal`.
  - `const STRICT_BASE_FIELDS: readonly string[]` = `["id","type","status","title","aliases","tags","related","updated","confidence","classification","source"]`
  - `const LOOSE_BASE_FIELDS: readonly string[]` = `["id","type","title"]`
  - `function isRegisteredType(name: string): boolean`

- [ ] **Step 1: Write the failing test**

Create `packages/contracts/test/type-registry.test.ts`:

```typescript
import { describe, expect, it } from "vitest";
import {
  resolveType, classificationToSensitivity, isRegisteredType,
  STRICT_TYPES, LOOSE_TYPES,
} from "../src/type-registry.js";

describe("type-registry", () => {
  it("resolves each vault strict type to tier 'strict'", () => {
    for (const t of ["project","repo","tool","cloud","person","team","meeting","conversation","memory"]) {
      expect(resolveType(t)).toMatchObject({ name: t, tier: "strict" });
    }
  });
  it("resolves loose types to tier 'loose'", () => {
    for (const t of ["research","personal","note"]) {
      expect(resolveType(t).tier).toBe("loose");
    }
  });
  it("an UNKNOWN type is accepted as a loose def keeping its name (open registry)", () => {
    const d = resolveType("podcast");
    expect(d).toEqual({ name: "podcast", tier: "loose", defaultSensitivity: "internal" });
    expect(isRegisteredType("podcast")).toBe(false);
  });
  it("empty/absent type defaults to loose 'note'", () => {
    expect(resolveType("")).toMatchObject({ name: "note", tier: "loose" });
    expect(resolveType(null)).toMatchObject({ name: "note", tier: "loose" });
  });
  it("maps classification to sensitivity, failing up (public→public, personal/unknown→confidential)", () => {
    expect(classificationToSensitivity("public")).toBe("public");
    expect(classificationToSensitivity("internal")).toBe("internal");
    expect(classificationToSensitivity("personal")).toBe("confidential");
    expect(classificationToSensitivity("Restricted")).toBe("restricted");
    expect(classificationToSensitivity("weird-value")).toBe("confidential");
    expect(classificationToSensitivity(undefined)).toBe("internal");
  });
  it("registry covers exactly the vault's 11 types + V1 compat (14)", () => {
    expect(new Set([...STRICT_TYPES, ...LOOSE_TYPES]).size).toBeGreaterThanOrEqual(11);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/contracts && npx vitest run test/type-registry.test.ts`
Expected: FAIL — `Cannot find module '../src/type-registry.js'`.

- [ ] **Step 3: Write the registry**

Create `packages/contracts/src/type-registry.ts`:

```typescript
/**
 * The note-type registry (open type system, spec 2026-07-16). Mirrors the vault's
 * own `00_System/Vault Schema.md` taxonomy: strict types require the full base
 * frontmatter, loose types require only id/type/title. Any type NOT registered is
 * accepted as a generic LOOSE def keeping its asserted name — the door stays open
 * so a future 12th type ingests without a code change. Consumed by graduation
 * (type inference + field-fill) and the read-only audit; the mutation-policy table
 * is a separate, spec-locked concern (spec non-goal).
 */
import type { Sensitivity } from "./dtos.js";

export interface TypeDef {
  readonly name: string;
  readonly tier: "strict" | "loose";
  readonly defaultSensitivity: Sensitivity;
}

/** Strict vault types (all base fields required by the vault schema). */
export const STRICT_TYPES = ["project", "repo", "tool", "cloud", "person", "team", "meeting", "conversation", "memory", "concept", "source"] as const;
/** Loose types (only id/type/title required). Includes V1's `note`. */
export const LOOSE_TYPES = ["research", "personal", "note"] as const;

/** Canonical base frontmatter for a STRICT type (vault schema §"Required base fields"). */
export const STRICT_BASE_FIELDS = ["id", "type", "status", "title", "aliases", "tags", "related", "updated", "confidence", "classification", "source"] as const;
/** Base frontmatter for a LOOSE type. */
export const LOOSE_BASE_FIELDS = ["id", "type", "title"] as const;

const REGISTRY = new Map<string, TypeDef>();
for (const name of STRICT_TYPES) REGISTRY.set(name, { name, tier: "strict", defaultSensitivity: "internal" });
for (const name of LOOSE_TYPES) REGISTRY.set(name, { name, tier: "loose", defaultSensitivity: "internal" });

export function isRegisteredType(name: string): boolean {
  return REGISTRY.has(name);
}

/**
 * Resolve a note type to its def. A registered name returns its def; an unknown or
 * empty/absent name returns a generic LOOSE def keeping the asserted name (empty →
 * `note`), so ingestion is total.
 */
export function resolveType(name: string | null | undefined): TypeDef {
  const n = typeof name === "string" ? name.trim() : "";
  if (n !== "" && REGISTRY.has(n)) return REGISTRY.get(n)!;
  return { name: n === "" ? "note" : n, tier: "loose", defaultSensitivity: "internal" };
}

/**
 * Map the vault's `classification` to Atlas `declaredSensitivity`, failing UP so no
 * sensitive note is silently downgraded. `public`→`public`; `internal`/absent→
 * `internal`; explicit `confidential`/`restricted` preserved; `personal` and any
 * unrecognized non-empty value → `confidential` (personal/business content is treated
 * as sensitive, never flattened to org-wide `internal`).
 */
export function classificationToSensitivity(classification: string | null | undefined): Sensitivity {
  const c = typeof classification === "string" ? classification.trim().toLowerCase() : "";
  switch (c) {
    case "public": return "public";
    case "internal": return "internal";
    case "": return "internal";               // absent → internal floor
    case "confidential": return "confidential";
    case "restricted": return "restricted";
    default: return "confidential";           // personal + unknown → fail up, never down
  }
}
```

- [ ] **Step 4: Add the drift test vs the vault schema**

Append to `packages/contracts/test/type-registry.test.ts`:

```typescript
import { readFileSync, existsSync } from "node:fs";

describe("type-registry ↔ Vault Schema.md drift", () => {
  const SCHEMA = "/Users/aryeh/Code/Vaults/main-vault/00_System/Vault Schema.md";
  it.runIf(existsSync(SCHEMA))("every strict/loose type named in the vault schema is registered at the same tier", () => {
    const md = readFileSync(SCHEMA, "utf8");
    const section = (h: string) => (md.split(`## ${h}`)[1] ?? "").split("\n## ")[0];
    const listed = (h: string) => [...section(h).matchAll(/^-\s+([a-z]+)\s*$/gm)].map((m) => m[1]!);
    for (const t of listed("Strict note types")) expect(resolveType(t), `strict ${t}`).toMatchObject({ tier: "strict" });
    for (const t of listed("Loose note types")) expect(resolveType(t), `loose ${t}`).toMatchObject({ tier: "loose" });
  });
});
```

- [ ] **Step 5: Wire the export**

Modify `packages/contracts/src/index.ts` — add after the `dtos` export block:

```typescript
export {
  resolveType, classificationToSensitivity, isRegisteredType,
  STRICT_TYPES, LOOSE_TYPES, STRICT_BASE_FIELDS, LOOSE_BASE_FIELDS,
} from "./type-registry.js";
export type { TypeDef } from "./type-registry.js";
```

- [ ] **Step 6: Build + run tests to verify they pass**

Run: `cd packages/contracts && ../../node_modules/.bin/tsc -p tsconfig.json && npx vitest run test/type-registry.test.ts`
Expected: PASS (all cases incl. the drift test when the vault is present).

- [ ] **Step 7: Commit**

```bash
git add packages/contracts/src/type-registry.ts packages/contracts/src/index.ts packages/contracts/test/type-registry.test.ts
git commit -m "feat(contracts): open note-type registry mirroring the vault schema (#151)"
```

---

## Task 2: Graduation type gate becomes total (types + schema version)

**Files:**
- Modify: `apps/cli/src/graduation/migrate-plan.ts` (imports; `inferType`; the refusal loop ~lines 155-177)
- Modify: `apps/cli/src/graduation/audit.ts:21` (`GRADUATION_KNOWN_TYPES`)
- Test: `apps/cli/test/graduation-migrate.cli.test.ts` + a new `apps/cli/test/migrate-open-types.test.ts`

**Interfaces:**
- Consumes: `resolveType`, `isRegisteredType` from `@atlas/contracts` (Task 1).
- Produces: `planBootstrapMigration` no longer emits `refused` entries for `unknown-type` or `unsupported-schema-version`; every note reaches the migrable set. `NoteOutcome.type.source` gains no new variant (still frontmatter|folder|filename|default). Unknown asserted types keep their name with `source: "frontmatter"`.

- [ ] **Step 1: Write the failing test**

Create `apps/cli/test/migrate-open-types.test.ts`:

```typescript
import { describe, expect, it } from "vitest";
import { planBootstrapMigration, type MigrationInputFile } from "../src/graduation/migrate-plan.js";

const TS = "2026-07-17T00:00:00.000Z";
function note(path: string, fm: string, body = "# Body\n"): MigrationInputFile {
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

  it("an unsupported schema_version is coerced, never refused", () => {
    const plan = planBootstrapMigration([note("a.md", "id: note-a\ntype: note\ntitle: A\nschema_version: 99")], { bootstrapTimestamp: TS, supportedSchemaMax: 1 });
    expect(plan.refused).toEqual([]);
    expect(plan.notes[0]!.initializedFrontmatter.schema_version).toBe(1);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/cli && npx vitest run test/migrate-open-types.test.ts`
Expected: FAIL — `refused` is non-empty (`unknown-type` / `unsupported-schema-version`).

- [ ] **Step 3: Consume the registry in `inferType`**

In `apps/cli/src/graduation/migrate-plan.ts`, replace the local type sets + `inferType`:

Replace lines 14-17 (the `KNOWN_TYPES`/`FOLDER_TYPE` consts) with:

```typescript
import { resolveType, isRegisteredType } from "@atlas/contracts";

/** Top-level folder → type (§3, case-sensitive) — vault folders included. */
const FOLDER_TYPE: Record<string, string> = {
  People: "person", Concepts: "concept", Sources: "source", Projects: "project",
  Repos: "repo", Teams: "team", Meetings: "meeting", Conversations: "conversation", Tools: "tool",
};
```

Replace `inferType` (the `TypeResult` union + function) with a total version:

```typescript
type TypeResult = { value: string; source: NoteOutcome["type"]["source"] };
function inferType(d: Doc): TypeResult {
  const explicit = d.fm.type;
  if (explicit !== undefined && explicit !== null && explicit !== "") {
    // ANY asserted type is accepted (open registry): a registered name keeps its
    // tier; an unknown one is kept verbatim as a loose type. Never refused.
    return { value: String(explicit), source: "frontmatter" };
  }
  const top = d.path.includes("/") ? d.path.split("/")[0]! : "";
  if (top && FOLDER_TYPE[top]) return { value: FOLDER_TYPE[top]!, source: "folder" };
  const pfx = /^([a-z]+)-/.exec(stem(d.path));
  if (pfx && isRegisteredType(pfx[1]!)) return { value: pfx[1]!, source: "filename" };
  return { value: "note", source: "default" };
}
```

- [ ] **Step 4: Remove the two refusal branches**

In `planBootstrapMigration`, replace the refusal loop (the `for (const d of docs)` block that pushes `unsupported-schema-version` and `unknown-type`) with a total build of `migrable`:

```typescript
  const refused: RefusalEntry[] = []; // retained in the shape; now always empty for shape reasons
  const migrable: { doc: Doc; type: { value: string; source: NoteOutcome["type"]["source"] } }[] = [];
  for (const d of docs) {
    const t = inferType(d);
    migrable.push({ doc: d, type: { value: t.value, source: t.source } });
  }
```

Delete the now-unused `refusedPaths` set and the `supportedMax` refusal check. Keep `supportedMax` (Step 5 of Task 4 coerces with it). Remove the `import` of anything now unused.

- [ ] **Step 5: Point the audit at the registry**

In `apps/cli/src/graduation/audit.ts`, replace line 21 and its use:

```typescript
import { isRegisteredType } from "@atlas/contracts";
// GRADUATION_KNOWN_TYPES is retained ONLY for back-compat exports; the audit now
// treats any registered OR asserted type as known (open system). An "unknown-type"
// inventory entry is emitted only for a genuinely empty/absent type.
```

Update the `const known = new Set<string>(GRADUATION_KNOWN_TYPES)` usage (line ~72) so a note is `unknown-type` only when its asserted type is empty/absent (not when it is merely unregistered): replace the membership test with `type !== "" ` acceptance — a note with any non-empty `type` is known; keep the `missing-type` category for absent types.

- [ ] **Step 6: Run the new + existing migrate tests**

Run: `cd apps/cli && npx vitest run test/migrate-open-types.test.ts`
Expected: PASS.
Run: `cd apps/cli && npx vitest run test/graduation-migrate.cli.test.ts`
Expected: some existing cases FAIL (they asserted refusals) — that is expected; fix them in Step 7.

- [ ] **Step 7: Update existing behavior assertions**

In `apps/cli/test/graduation-migrate.cli.test.ts` (and any `*migrate*` test asserting `unknown-type`/`unsupported-schema-version` refusals), change those assertions to expect migration instead of refusal. Search: `grep -rn "unknown-type\|unsupported-schema-version" apps/cli/test`. For each, assert the note now appears in `notes` with the expected type/coerced schema.

- [ ] **Step 8: Rebuild + full graduation suite**

Run: `cd apps/cli && ../../node_modules/.bin/tsc -p tsconfig.json && npx vitest run test/migrate-open-types.test.ts test/graduation-migrate.cli.test.ts test/graduation.cli.test.ts`
Expected: PASS.

- [ ] **Step 9: Commit**

```bash
# Stage EVERY test the Step-7 search actually modified, not just the two named files.
git add apps/cli/src/graduation/migrate-plan.ts apps/cli/src/graduation/audit.ts apps/cli/test
git diff --check                                    # no conflict/whitespace markers
test -z "$(git status --short apps/cli/test | grep '^.M')" || { echo 'unstaged test edits remain'; exit 1; }
git commit -m "feat(graduation): open type gate — any type ingests, schema coerced, never refused (#151)"
```

---

## Task 3: Identity, links, and aliases become total (no more quarantine-for-shape)

**Files:**
- Modify: `apps/cli/src/graduation/migrate-plan.ts` (Pass 1 dup-id; the incompatible-link block; the ambiguous-alias tail)
- Test: `apps/cli/test/migrate-open-types.test.ts` (append)

**Interfaces:**
- Consumes: the total `migrable` set (Task 2).
- Produces: `planBootstrapMigration` returns `quarantined: []` for `duplicate-identity`/`ambiguous-alias`/`incompatible-link` shape defects — those notes now appear in `notes`. Duplicate explicit ids are numeric-suffix-disambiguated (same `collision` rule already used for derived ids). Incompatible/ambiguous links are flattened to plain display text (`resolution: "flattened-unresolved"|"flattened-ambiguous"`) and the note still migrates. `QuarantineEntry` is retained in the shape but produced ONLY by the secret-scan path (which lives in `graduation/scan.ts`, untouched).

- [ ] **Step 1: Write the failing test**

Append to `apps/cli/test/migrate-open-types.test.ts`:

```typescript
describe("graduation migrate — open type system (identity + links)", () => {
  it("two notes with the SAME explicit id both migrate, disambiguated (no duplicate-identity quarantine)", () => {
    const plan = planBootstrapMigration([
      note("a/dup.md", "id: repo-dup\ntype: repo\ntitle: Dup A"),
      note("b/dup.md", "id: repo-dup\ntype: repo\ntitle: Dup B"),
    ], { bootstrapTimestamp: TS });
    expect(plan.quarantined).toEqual([]);
    const ids = plan.notes.map((n) => n.newId).sort();
    expect(ids).toEqual(["repo-dup", "repo-dup-2"]);
  });

  it("a note with an unresolved wikilink migrates with the link flattened (no incompatible-link quarantine)", () => {
    const plan = planBootstrapMigration([
      note("x/a.md", "id: note-a\ntype: note\ntitle: A", "See [[Nonexistent Target]] here.\n"),
    ], { bootstrapTimestamp: TS });
    expect(plan.quarantined).toEqual([]);
    expect(plan.notes).toHaveLength(1);
    expect(plan.notes[0]!.linkRewrites[0]).toMatchObject({ resolution: "flattened-unresolved" });
    expect(plan.notes[0]!.body).not.toContain("[["); // flattened → reader-safe
  });

  it("an ambiguous-title note still migrates (no ambiguous-alias quarantine)", () => {
    const plan = planBootstrapMigration([note("x/weird.md", "type: memory\ntitle: '***'", "# ***\n")], { bootstrapTimestamp: TS });
    expect(plan.quarantined).toEqual([]);
    expect(plan.notes).toHaveLength(1);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/cli && npx vitest run test/migrate-open-types.test.ts -t "identity + links"`
Expected: FAIL — `quarantined` is non-empty for these shape defects.

- [ ] **Step 3: Disambiguate duplicate explicit ids instead of quarantining**

In `planBootstrapMigration` Pass 1, replace the `duplicate-identity` quarantine branch. Instead of pushing to `quarantined` + `dupIdPaths`, reserve only the FIRST (sorted-path) owner's id and let the rest fall through to Pass-2 derivation (which already numeric-suffixes against `assigned`):

```typescript
  const explicitById = new Map<string, string[]>();
  for (const { doc } of migrable) {
    const eid = doc.fm.id;
    if (typeof eid === "string" && eid.trim() !== "") (explicitById.get(eid) ?? explicitById.set(eid, []).get(eid)!).push(doc.path);
  }
  // Open system: a shared explicit id no longer quarantines. The first owner (sorted
  // path) keeps the bare id; each LATER owner keeps its OWN explicit id numeric-
  // suffixed (`repo-dup-2`, `repo-dup-3`, …) in sorted-path order — NOT re-derived
  // from the title (that would produce `repo-dup-b`, breaking the numeric-suffix rule).
  // `assigned` is the shared reservation set also consulted by Pass-2 derivation.
  const supersededExplicit = new Map<string, string>(); // path → its disambiguated explicit id
  for (const [id, paths] of explicitById) {
    const sorted = [...paths].sort();
    assigned.add(id); // first owner keeps the bare id
    let n = 2;
    for (const p of sorted.slice(1)) {
      let candidate = `${id}-${n}`;
      while (assigned.has(candidate)) candidate = `${id}-${++n}`;
      assigned.add(candidate);
      supersededExplicit.set(p, candidate);
      n++;
    }
  }
```

Delete the `dupIdPaths` set entirely. Everywhere `dupIdPaths.has(doc.path)` was used to SKIP a note, remove the skip (all migrable notes now produce outcomes). In Pass 2, treat a path in `supersededExplicit` as having no explicit id:

```typescript
  for (const { doc, type } of migrable) {
    const explicitId = typeof doc.fm.id === "string" && doc.fm.id.trim() !== "" ? doc.fm.id : null;
    let newId: string;
    if (explicitId !== null) {
      // First owner keeps the bare id; a superseded owner uses its pre-suffixed id.
      newId = supersededExplicit.get(doc.path) ?? explicitId;
    } else {
      const { slug, ambiguous } = slugify(doc.title);
      if (ambiguous) ambiguousAlias.add(doc.path); // recorded for the report, NOT quarantined
      const base = `${type.value}-${slug}`;
      newId = base;
      for (let n = 2; assigned.has(newId); n++) newId = `${base}-${n}`;
      assigned.add(newId);
      if (newId !== base) collisionByPath.set(doc.path, { derivedId: base, disambiguatedTo: newId, rule: "numeric-suffix-by-sorted-path" });
    }
    idMap[doc.path] = newId;
  }
```

- [ ] **Step 4: Migrate incompatible-link notes by FLATTENING the link (reader-safe)**

The unchanged strict `readVault()` rejects `broken-link`/`ambiguous-link`, so a preserved-verbatim wikilink would make the graduated vault un-rebuildable. Replace the `if (hasUnresolved && release === undefined) { incompatibleLink.add(...); continue; }` block so an unresolved link NEVER blocks migration AND never survives as a wikilink — it is FLATTENED to its plain display text in the emitted body (deterministic), and `linkRewrites` records the resolution:

```typescript
    // Open system: an unresolved/ambiguous `[[Target|Display]]` no longer blocks and
    // no longer survives as a wikilink (the strict reader would reject it). It is
    // flattened in-body to its display text (`Display`, else `Target`); linkRewrites
    // records `flattened-unresolved`/`flattened-ambiguous`. `released` stays supported
    // for provenance but is no longer REQUIRED to migrate.
    const release = released[doc.path];
    // (no `continue` — the link is flattened in the emitted body, then the note builds
    //  its outcome; the resulting note contains no unresolved wikilinks.)
```

Delete the `incompatibleLink` set and its quarantine tail (`for (const p of [...incompatibleLink].sort()) ...`).

- [ ] **Step 5: Drop the ambiguous-alias quarantine tail**

Remove the line `for (const p of [...ambiguousAlias].sort()) quarantined.push({ path: p, category: "ambiguous-alias" });`. Keep the `ambiguousAlias` set — it feeds the `normalized[]` report in Task 4 (rename it there if clearer). The `quarantined` array is now populated only by the secret-scan path elsewhere.

- [ ] **Step 6: Run tests**

Run: `cd apps/cli && npx vitest run test/migrate-open-types.test.ts`
Expected: PASS (types + identity + links).

- [ ] **Step 7: Update existing quarantine assertions**

Search `grep -rn "duplicate-identity\|ambiguous-alias\|incompatible-link" apps/cli/test`. For each test asserting these as quarantine outcomes, update to expect migration (disambiguated id / preserved link). The secret-scan `detected-credential` quarantine tests are unaffected — do NOT touch them.

- [ ] **Step 8: Rebuild + graduation suite**

Run: `cd apps/cli && ../../node_modules/.bin/tsc -p tsconfig.json && npx vitest run test/graduation-migrate.cli.test.ts test/migrate-open-types.test.ts test/graduation.cli.test.ts`
Expected: PASS.

- [ ] **Step 9: Commit**

```bash
# Stage every test touched by the Step-7 quarantine search, not just the named files.
git add apps/cli/src/graduation/migrate-plan.ts apps/cli/test
git diff --check
test -z "$(git status --short apps/cli/test | grep '^.M')" || { echo 'unstaged test edits remain'; exit 1; }
git commit -m "feat(graduation): identity/link/alias shape defects normalize instead of quarantine (#151)"
```

---

## Task 4: Strict base-field defaults + classification→sensitivity + normalized[] report

**Files:**
- Modify: `apps/cli/src/graduation/migrate-plan.ts` (`initializedFrontmatter` build; add `NormalizedEntry` + `normalized` to the return)
- Modify: `apps/cli/src/commands/graduation-migrate.ts` (surface `normalized` in JSON output)
- Modify: `docs/specs/cli-contract/graduation-migrate.schema.json` (add `normalized`)
- Test: `apps/cli/test/migrate-open-types.test.ts` (append)

**Interfaces:**
- Consumes: `resolveType`, `classificationToSensitivity`, `STRICT_BASE_FIELDS` from `@atlas/contracts` (Task 1); the total `migrable`/`notes` build (Tasks 2-3).
- Produces:
  - `interface NormalizedEntry { path: string; filled: string[]; coerced: string[]; note: string }` (capped list; `note` is a short human reason).
  - `MigrationPlan` gains `readonly normalized: NormalizedEntry[]`.
  - `NoteOutcome.initializedFrontmatter` for a STRICT type is filled/coerced for EVERY required base field (`STRICT_BASE_FIELDS`), so the strict reader always receives a well-formed note: `status: "active"`, `confidence: "medium"`, `classification: "internal"`, `source: <original vault path>`, `aliases: []`, `tags: []`, `related: []`, plus `declaredSensitivity` re-derived from the coerced `classification`. Present-but-malformed values (null, wrong shape, invalid enum, blank) are COERCED to the default, not copied through.

- [ ] **Step 1: Write the failing test**

Append to `apps/cli/test/migrate-open-types.test.ts`:

```typescript
describe("graduation migrate — strict field-fill + normalized report", () => {
  it("a strict 'repo' note missing base fields gets judgement defaults; report lists them", () => {
    const plan = planBootstrapMigration([note("Repos/x.md", "id: repo-x\ntype: repo\ntitle: X")], { bootstrapTimestamp: TS });
    const fm = plan.notes[0]!.initializedFrontmatter;
    expect(fm.status).toBe("active");
    expect(fm.confidence).toBe("medium");
    expect(fm.classification).toBe("internal");
    expect(fm.aliases).toEqual([]);
    expect(fm.source).toBe("Repos/x.md"); // required strict field, never omitted
    const rep = plan.normalized.find((n) => n.path === "Repos/x.md");
    expect(rep?.filled).toEqual(expect.arrayContaining(["status", "confidence", "classification", "source"]));
  });

  it("declaredSensitivity derives from classification: public→public, else internal", () => {
    const pub = planBootstrapMigration([note("a.md", "id: note-a\ntype: note\ntitle: A\nclassification: public")], { bootstrapTimestamp: TS });
    expect(pub.notes[0]!.initializedFrontmatter.declaredSensitivity).toBe("public");
    const inter = planBootstrapMigration([note("b.md", "id: note-b\ntype: note\ntitle: B\nclassification: personal")], { bootstrapTimestamp: TS });
    expect(inter.notes[0]!.initializedFrontmatter.declaredSensitivity).toBe("internal");
  });

  it("a loose 'research' note is NOT force-filled with strict base fields", () => {
    const plan = planBootstrapMigration([note("R/x.md", "id: research-x\ntype: research\ntitle: X")], { bootstrapTimestamp: TS });
    expect(plan.notes[0]!.initializedFrontmatter.confidence).toBeUndefined();
  });

  it("present-but-malformed strict fields are COERCED, not copied through (null aliases, bad enum)", () => {
    const plan = planBootstrapMigration([note("Repos/m.md", "id: repo-m\ntype: repo\ntitle: M\naliases:\nstatus: bogus\nconfidence: '   '")], { bootstrapTimestamp: TS });
    const fm = plan.notes[0]!.initializedFrontmatter;
    expect(fm.aliases).toEqual([]);      // null → []
    expect(fm.status).toBe("active");    // invalid enum → default
    expect(fm.confidence).toBe("medium"); // whitespace → default
    const rep = plan.normalized.find((n) => n.path === "Repos/m.md");
    expect(rep?.coerced).toEqual(expect.arrayContaining(["aliases", "status", "confidence"]));
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/cli && npx vitest run test/migrate-open-types.test.ts -t "field-fill"`
Expected: FAIL — defaults not present, `plan.normalized` undefined.

- [ ] **Step 3: Add the NormalizedEntry type + return field**

In `migrate-plan.ts`, add near the other interfaces:

```typescript
export interface NormalizedEntry {
  readonly path: string;
  /** Base fields judgement FILLED (were absent). */
  readonly filled: string[];
  /** Fields judgement COERCED (present but adjusted, e.g. schema_version). */
  readonly coerced: string[];
  /** Short human reason (capped). */
  readonly note: string;
}
```

Add `readonly normalized: NormalizedEntry[]` to the `MigrationPlan` interface, and initialize `const normalized: NormalizedEntry[] = [];` in `planBootstrapMigration`.

- [ ] **Step 4: Fill strict base-field defaults + sensitivity when building each outcome**

Replace the `initialized` object build with a tier-aware version using the registry:

```typescript
    const def = resolveType(type.value);
    const classification = typeof doc.fm.classification === "string" ? doc.fm.classification : undefined;
    const initialized: Record<string, unknown> = {
      id: newId,
      type: type.value,
      schema_version: 1,
      title: doc.title,
      created: opts.bootstrapTimestamp,
      updated: opts.bootstrapTimestamp,
      declaredSensitivity: classificationToSensitivity(classification),
    };
    const filled: string[] = [];
    const coerced: string[] = [];
    // Coercion: an unsupported schema_version was clamped to 1 (Task 2 keeps supportedMax).
    const sv = doc.fm.schema_version;
    if (typeof sv === "number" && sv > (opts.supportedSchemaMax ?? DEFAULT_SCHEMA_MAX)) coerced.push("schema_version");
    // Strict types: every required base field is FILLED if absent or COERCED if
    // present-but-malformed (null, wrong shape, invalid enum, blank/whitespace), so
    // the strict reader always receives a well-formed note. Driven off the required
    // set so no field (e.g. `source`) can be silently omitted.
    if (def.tier === "strict") {
      const ENUM = { status: ["active", "archived", "draft"], confidence: ["low", "medium", "high"], classification: ["public", "internal", "personal"] } as const;
      const DEFAULT: Record<string, string> = { status: "active", confidence: "medium", classification: "internal", source: doc.path };
      for (const k of ["status", "confidence", "classification", "source"] as const) {
        const raw = doc.fm[k];
        if (raw === undefined) { initialized[k] = DEFAULT[k]; filled.push(k); }
        else if (typeof raw !== "string" || raw.trim() === "" || (k in ENUM && !ENUM[k as keyof typeof ENUM].includes(raw.trim() as never))) {
          initialized[k] = DEFAULT[k]; coerced.push(k);
        } else initialized[k] = raw.trim();
      }
      for (const k of ["aliases", "tags", "related"] as const) {
        const raw = doc.fm[k];
        if (raw === undefined) { initialized[k] = []; filled.push(k); }
        else if (!Array.isArray(raw)) { initialized[k] = []; coerced.push(k); } // null / scalar → []
        else initialized[k] = raw;
      }
      // Re-derive sensitivity from the COERCED classification (not the raw frontmatter).
      initialized.declaredSensitivity = classificationToSensitivity(initialized.classification as string);
    }
    if (filled.length > 0 || coerced.length > 0) {
      normalized.push({ path: doc.path, filled: filled.sort(), coerced, note: `${def.tier} type '${type.value}'` });
    }
```

Add `normalized` to the returned object: `return { idMap, notes, quarantined, refused, releases, normalized };`.

- [ ] **Step 5: Surface `normalized` in the command output + schema**

In `apps/cli/src/commands/graduation-migrate.ts`, add `normalized: plan.normalized` to the emitted preview/applied JSON object (find where `quarantined`/`refused` are emitted and mirror them).

In `docs/specs/cli-contract/graduation-migrate.schema.json`, add a `normalized` property mirroring the `refused` array shape:

```json
"normalized": {
  "type": "array",
  "description": "Per-note record of the base fields judgement filled or coerced on ingest (open type system).",
  "items": {
    "type": "object",
    "required": ["path", "filled", "coerced", "note"],
    "properties": {
      "path": { "type": "string" },
      "filled": { "type": "array", "items": { "type": "string" } },
      "coerced": { "type": "array", "items": { "type": "string" } },
      "note": { "type": "string" }
    }
  }
}
```

- [ ] **Step 6: Run tests + contract lint**

Run: `cd apps/cli && ../../node_modules/.bin/tsc -p tsconfig.json && npx vitest run test/migrate-open-types.test.ts`
Expected: PASS.
Run: `cd tools && npx vitest run` (contract lint — the schema must stay valid + the registry↔fixture consistency holds)
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add apps/cli/src/graduation/migrate-plan.ts apps/cli/src/commands/graduation-migrate.ts docs/specs/cli-contract/graduation-migrate.schema.json apps/cli/test/migrate-open-types.test.ts
git commit -m "feat(graduation): strict base-field judgement defaults + classification→sensitivity + normalized[] report (#151)"
```

---

## Task 5: Fixtures, full suite, and the live real-vault acceptance run

**Files:**
- Modify: `docs/specs/fixtures/bootstrap-migration/*` (update expectations for total behavior)
- Create: `docs/specs/fixtures/bootstrap-migration/full-taxonomy/` (a fixture exercising all 11 types + one unknown)
- Test: existing migrate/apply fixture tests

**Interfaces:**
- Consumes: everything from Tasks 1-4.
- Produces: green byte-exact fixtures + a recorded live-drive acceptance result.

- [ ] **Step 1: Identify fixture drift**

Run: `cd apps/cli && npx vitest run 2>&1 | grep -iE "fixture|byte|migrate" | head -40`
List every fixture-backed test now failing because behavior changed (refusals/quarantines that became migrations). Read `docs/specs/fixtures/bootstrap-migration/manifest.json` to see how expected artifacts are keyed.

- [ ] **Step 2: Regenerate the affected fixture expectations**

For each drifted fixture (`explicit-collision`, `guards`, and any asserting `unknown-type`/incompatible-link), update its expected `plan`/output artifact to the new total outcome (migrated + disambiguated + `normalized[]`). If the repo has an update-golden mechanism (check `grep -rn "UPDATE_GOLDEN\|updateSnapshot" apps/cli tools`), use it; otherwise hand-edit the expected JSON to match the actual (verify each diff is a *deliberate* behavior change, not a regression).

- [ ] **Step 3: Add the full-taxonomy fixture**

Create `docs/specs/fixtures/bootstrap-migration/full-taxonomy/input/` with one note per type (`person`, `repo`, `research`, `project`, `memory`, `meeting`, `conversation`, `personal`, `team`, `cloud`, `tool`, plus one `podcast` unknown, one no-frontmatter file, one strict note missing ALL base fields, one note with a duplicate explicit id, and one with an unresolved `[[link]]`), and the expected `plan.json`. Wire it into the fixture test loop (follow the existing `basic`/`collision` pattern).

Also add the **reader-compatibility gate** (the proof the normalized output is well-formed): a test that APPLIES the full-taxonomy plan into a temp copy, runs `readVault()` + strict rebuild over the result, and asserts ZERO reader errors — no `broken-link`, `ambiguous-link`, `identity-collision`, or schema errors survive. This is what makes "total ingestion" real rather than reported.

- [ ] **Step 4: Run the entire affected suite**

Run: `cd apps/cli && ../../node_modules/.bin/tsc -p tsconfig.json && npx vitest run`
Expected: PASS (all, incl. updated fixtures).
Run: `cd packages/contracts && npx vitest run && cd ../../tools && npx vitest run`
Expected: PASS.

- [ ] **Step 5: Commit the fixtures**

```bash
git add docs/specs/fixtures/bootstrap-migration
git commit -m "test(graduation): fixtures for total open-type ingestion incl. full-taxonomy (#151)"
```

- [ ] **Step 6: Live real-vault acceptance (the gate)**

With the production broker running against a fresh graduation copy (see the 2026-07-16 drive runbook: `~/Code/Vaults/atlas-graduation-2026-07-16/` pattern — broker `testMode=false`, custody seam env), run:

```bash
cd <graduation-work-dir>
ATLAS_TEST_MODE=1 ATLAS_CUSTODY_TEST_DIR=<custody> \
  node ~/Code/21Stark/atlas/apps/cli/dist/bin.js graduation scan --source ~/Code/Vaults/main-vault --copy <copy> --json
ATLAS_TEST_MODE=1 ATLAS_CUSTODY_TEST_DIR=<custody> \
  node ~/Code/21Stark/atlas/apps/cli/dist/bin.js graduation migrate --json | python3 -c "import json,sys; d=json.load(sys.stdin); print('refused', len(d['refused']), '| migrating', len(d['notes']), '| quarantined', len(d['quarantined']), '| normalized', len(d['normalized']))"
```

Then APPLY the plan and run the strict reader over the result — the migrate summary alone can hide notes missing `source` or carrying malformed fields:

```bash
ATLAS_TEST_MODE=1 ATLAS_CUSTODY_TEST_DIR=<custody> \
  node ~/Code/21Stark/atlas/apps/cli/dist/bin.js graduation migrate --apply --out <migrated-copy> --json
# Strict-reader gate: the graduated vault MUST rebuild with zero errors.
node ~/Code/21Stark/atlas/apps/cli/dist/bin.js vault validate --source <migrated-copy> --json \
  | python3 -c "import json,sys; d=json.load(sys.stdin); assert not d['errors'], d['errors']; print('reader OK', d.get('noteCount'))"
```

Expected: `refused 0`, `migrating` ≈ full vault (200+), `quarantined` = only secret-bearing notes, reader errors `0`, and exact conservation — `scanned == written + credential-quarantines` with no unexplained omissions. Record the numbers in a comment on #151.

- [ ] **Step 7: Open the PR + post the live result**

```bash
git status --short   # MUST be empty — every in-scope src + test edit committed
git push -u origin feat/open-type-system
```
Open the PR (title "feat: open type system — full-vault ingestion (#151)"), paste the live acceptance numbers, and link the spec. Merge once CI is green.

---

## Self-Review

**Spec coverage:**
- Open registry + tiers + generic fallback → Task 1. ✓
- Graduation total (unknown-type, schema-version) → Task 2. ✓
- Identity/link/alias total → Task 3. ✓
- Strict field-fill by judgement + classification→sensitivity + normalized[] → Task 4. ✓
- Registry↔schema drift test → Task 1 Step 4. ✓
- Live re-graduation acceptance + fixtures → Task 5. ✓
- Secrets unchanged → Global Constraints + never touching `scan.ts`. ✓
- Mutation-policy reconciliation → explicitly OUT (spec non-goal). ✓
- Reader strict mode untouched → not in any task's file list. ✓

**Type consistency:** `resolveType`/`classificationToSensitivity`/`isRegisteredType`/`STRICT_BASE_FIELDS` (Task 1) are the exact names consumed in Tasks 2-4. `NormalizedEntry`/`normalized` (Task 4) match the schema + command wiring. `TypeResult` simplified in Task 2 is consumed only inside `migrate-plan.ts`.

**Placeholders:** none — every code step shows real code; fixture regeneration (Task 5 Step 2) names the exact mechanism to discover (`UPDATE_GOLDEN`) rather than hand-waving.

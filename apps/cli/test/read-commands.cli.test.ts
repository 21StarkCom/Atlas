/**
 * `read-commands.cli.test` — per-command contract fixtures for the Task 2.9 read/
 * maintenance surface not covered by `pagination.contract.test`: `source show`,
 * `source trust show` (default untrusted), `note show`/`note related`, and
 * `git cleanup` (terminal-only pruning, dry-run, idempotency). Every `--json`
 * success validates against the committed schema; error paths assert exit codes.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync, existsSync, symlinkSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import _Ajv2020 from "ajv/dist/2020.js";
import { runCli } from "../src/main.js";
import { openStore, SourceRepo, type Store } from "@atlas/sqlite-store";
import { openRepo } from "@atlas/git";
import { normalizeIdentityKey } from "@atlas/contracts";

const REPO_ROOT = join(import.meta.dirname, "..", "..", "..");
const Ajv = ((_Ajv2020 as unknown as { default?: unknown }).default ?? _Ajv2020) as new (opts?: unknown) => {
  compile: (s: unknown) => ((v: unknown) => boolean) & { errors?: unknown };
  errorsText: (e?: unknown) => string;
};
function validateSchema(name: string, value: unknown): void {
  const ajv = new Ajv({ strict: false, allErrors: true });
  const schema = JSON.parse(readFileSync(join(REPO_ROOT, "docs/specs/cli-contract", `${name}.schema.json`), "utf8"));
  const validate = ajv.compile(schema);
  if (!validate(value)) throw new Error(`${name} failed schema: ${ajv.errorsText(validate.errors)}\n${JSON.stringify(value)}`);
}

const hash = (n: number): string => n.toString(16).padStart(64, "0");
const iso = "2026-07-13T10:00:00.000Z";
const ulid = (n: number): string => `01J9Z8Q${"0".repeat(17)}${String(n).padStart(2, "0")}`;

let root: string;
let cwd: string;
let vaultDir: string;
let env: NodeJS.ProcessEnv;
let dbPath: string;

async function cli(argv: string[]): Promise<{ code: number; out: string }> {
  let out = "";
  const realOut = process.stdout.write.bind(process.stdout);
  const realErr = process.stderr.write.bind(process.stderr);
  (process.stdout as unknown as { write: (s: string) => boolean }).write = (s: string) => ((out += s), true);
  (process.stderr as unknown as { write: (s: string) => boolean }).write = () => true;
  try {
    const code = await runCli(argv, env, { cwd, root: REPO_ROOT });
    return { code, out };
  } finally {
    process.stdout.write = realOut;
    process.stderr.write = realErr;
  }
}

beforeEach(async () => {
  root = mkdtempSync(join("/tmp", "atlas-rc-"));
  cwd = join(root, "work");
  mkdirSync(join(cwd, ".atlas"), { recursive: true });
  vaultDir = join(cwd, "vault");
  mkdirSync(vaultDir, { recursive: true });
  const config = [
    "vault:", `  path: ${vaultDir}`,
    "sqlite:", "  path: ./.atlas/atlas.db", "  ledger_backup:", "    dir: ./.atlas/backups",
    "lancedb:", "  dir: ./.atlas/lancedb",
    "indexing:", "  chunker_version: 1", "  embedding_model: gemini-embedding-001", "  dimensions: 768",
    "git:", "  worktrees_path: ./.atlas/worktrees", `  audit_anchor_path: ${join(root, "anchor")}`,
    "models: {}", "policies: {}", "logs:", "  dir: ./.atlas/logs",
    "broker:", `  socket_path: ${join(root, "b.sock")}`, `  egress_socket_path: ${join(root, "e.sock")}`, "",
  ].join("\n");
  writeFileSync(join(cwd, "brain.config.yaml"), config, "utf8");
  env = { ...process.env, NO_COLOR: "1" };
  dbPath = join(cwd, ".atlas", "atlas.db");
  await cli(["db", "migrate", "--json"]);
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

/** Seed one v2 `source` registry row; returns its id + unique locator. */
function seedSource(store: Store): { id: string; locator: string } {
  const id = "src-a";
  const locator = "sources/a.txt";
  new SourceRepo(store.db).insert({ id, kind: "file", locator, title: "Source A", addedAt: iso });
  return { id, locator };
}

describe("source show", () => {
  it("source show validates + reports the registry row, resolvable by id AND by locator", async () => {
    const store = openStore({ path: dbPath });
    let s: { id: string; locator: string };
    try { s = seedSource(store); } finally { store.close(); }
    const r = await cli(["source", "show", s.id, "--json"]);
    expect(r.code, r.out).toBe(0);
    const out = JSON.parse(r.out);
    validateSchema("source-show", out);
    expect(out.source).toMatchObject({ id: s.id, kind: "file", locator: s.locator, title: "Source A", addedAt: iso });
    // The UNIQUE locator resolves to the same row (source show resolves id-then-locator).
    const byLoc = await cli(["source", "show", s.locator, "--json"]);
    expect(byLoc.code, byLoc.out).toBe(0);
    expect(JSON.parse(byLoc.out).source.id).toBe(s.id);
  });

  it("missing arg ⇒ usage (5); an unknown id/locator ⇒ source-not-found (1)", async () => {
    expect((await cli(["source", "show", "--json"])).code).toBe(5);
    const missing = await cli(["source", "show", "no-such-source", "--json"]);
    expect(missing.code).toBe(1);
    expect(JSON.parse(missing.out).code).toBe("source-not-found");
  });
});

describe("note show / note related", () => {
  function writeNote(name: string, body: string): void {
    writeFileSync(join(vaultDir, `${name}.md`), body, "utf8");
  }

  it("note show validates + emits sections in document order + link resolution", async () => {
    writeNote("atlas", ["---", "id: concept-atlas", "title: Atlas", "type: concept", "status: active", "schema_version: 1", "created: 2026-07-13", "updated: 2026-07-13", "aliases: [Atlas Engine]", "---", "# Overview", "See [[vault]].", "## Goals", "# Details"].join("\n"));
    writeNote("vault", ["---", "id: concept-vault", "title: Vault", "type: concept", "status: active", "schema_version: 1", "created: 2026-07-13", "updated: 2026-07-13", "---", "body"].join("\n"));
    const r = await cli(["note", "show", "concept-atlas", "--json"]);
    expect(r.code, r.out).toBe(0);
    const out = JSON.parse(r.out);
    validateSchema("note-show", out);
    expect(out.note.sections).toEqual(["Overview", "Overview/Goals", "Details"]);
    expect(out.note.aliases).toEqual(["Atlas Engine"]);
    const link = out.note.links.find((l: { target: string }) => l.target === "vault");
    expect(link.resolved).toBe(true);
  });

  it("note show: not-found ⇒ 1; ambiguous (duplicate id) ⇒ 1", async () => {
    writeNote("a", ["---", "id: dup", "title: A", "type: concept", "status: active", "schema_version: 1", "created: 2026-07-13", "updated: 2026-07-13", "---", "x"].join("\n"));
    writeNote("b", ["---", "id: dup", "title: B", "type: concept", "status: active", "schema_version: 1", "created: 2026-07-13", "updated: 2026-07-13", "---", "y"].join("\n"));
    expect((await cli(["note", "show", "nope", "--json"])).code).toBe(1);
    const amb = await cli(["note", "show", "dup", "--json"]);
    expect(amb.code).toBe(1);
    expect(JSON.parse(amb.out).code).toBe("ambiguous-note");
  });

  it("note related validates against schema", async () => {
    const store = openStore({ path: dbPath });
    try {
      const mk = (id: string) => store.projections.insertNote({ note_id: id, slug: id, title: id, type: "concept", schema_version: 1, status: "active", file_path: `${id}.md`, content_hash: `sha256:${hash(1)}`, created: iso, updated: iso });
      ["concept-atlas", "concept-vault"].forEach(mk);
      store.projections.insertLink({ source_note_id: "concept-atlas", target_note_id: "concept-vault", predicate: "references", ordinal: 0 });
    } finally { store.close(); }
    const r = await cli(["note", "related", "concept-atlas", "--json"]);
    expect(r.code, r.out).toBe(0);
    validateSchema("note-related", JSON.parse(r.out));
    expect(JSON.parse(r.out).related[0].noteId).toBe("concept-vault");
  });
});

describe("note lookup precedence (tiered: exact id → exact slug → unique alias)", () => {
  function writeNote(name: string, body: string): void {
    writeFileSync(join(vaultDir, `${name}.md`), body, "utf8");
  }
  function fm(id: string, opts: { aliases?: string } = {}): string[] {
    return ["---", `id: ${id}`, `title: ${id}`, "type: concept", "status: active", "schema_version: 1",
      "created: 2026-07-13", "updated: 2026-07-13", ...(opts.aliases ? [`aliases: ${opts.aliases}`] : []), "---", "body"];
  }

  it("note show: an exact id that is ALSO another note's slug resolves to the id (not ambiguous)", async () => {
    // File `collide.md` gives note B the filename slug "collide"; note A's id is "collide".
    writeNote("a", fm("collide").join("\n"));
    writeNote("collide", fm("concept-b").join("\n"));
    const r = await cli(["note", "show", "collide", "--json"]);
    expect(r.code, r.out).toBe(0);
    expect(JSON.parse(r.out).note.id).toBe("collide"); // exact-id tier wins over slug tier
  });

  it("note show: an exact id that is ALSO another note's alias resolves to the id", async () => {
    writeNote("a", fm("aliascollide").join("\n"));
    writeNote("c", fm("concept-c", { aliases: "[aliascollide]" }).join("\n"));
    const r = await cli(["note", "show", "aliascollide", "--json"]);
    expect(r.code, r.out).toBe(0);
    expect(JSON.parse(r.out).note.id).toBe("aliascollide");
  });

  it("note related: an exact id that is ALSO another note's slug resolves to the id", async () => {
    const store = openStore({ path: dbPath });
    try {
      store.projections.insertNote({ note_id: "collideid", slug: "other", title: "A", type: "concept", schema_version: 1, status: "active", file_path: "a.md", content_hash: `sha256:${hash(1)}`, created: iso, updated: iso });
      store.projections.insertNote({ note_id: "concept-b", slug: "collideid", title: "B", type: "concept", schema_version: 1, status: "active", file_path: "b.md", content_hash: `sha256:${hash(2)}`, created: iso, updated: iso });
    } finally { store.close(); }
    const r = await cli(["note", "related", "collideid", "--json"]);
    expect(r.code, r.out).toBe(0);
    expect(JSON.parse(r.out).noteId).toBe("collideid"); // exact-id tier wins, never ambiguous
  });

  it("note history: an exact id that is ALSO another note's slug resolves to the id", async () => {
    const store = openStore({ path: dbPath });
    try {
      store.projections.insertNote({ note_id: "histcollide", slug: "other-h", title: "A", type: "concept", schema_version: 1, status: "active", file_path: "a.md", content_hash: `sha256:${hash(1)}`, created: iso, updated: iso });
      store.projections.insertNote({ note_id: "concept-b", slug: "histcollide", title: "B", type: "concept", schema_version: 1, status: "active", file_path: "b.md", content_hash: `sha256:${hash(2)}`, created: iso, updated: iso });
    } finally { store.close(); }
    const r = await cli(["note", "history", "histcollide", "--json"]);
    expect(r.code, r.out).toBe(0);
    expect(JSON.parse(r.out).noteId).toBe("histcollide");
  });
});

describe("alias resolution is identical across note show / related / history (finding #1)", () => {
  it("a declared alias that normalizes to the note's own slug resolves the SAME across all three", async () => {
    // The note's declared alias "Atlas Engine" and its filename slug "atlas-engine"
    // BOTH fold to the identity key "atlas engine" — a slug-equivalent alias. `note
    // show` reads this vault directly, so it resolves the alias via the vault's alias
    // tier.
    writeFileSync(
      join(vaultDir, "atlas-engine.md"),
      ["---", "id: concept-atlas", "title: Atlas Engine", "type: concept", "status: active", "schema_version: 1", "created: 2026-07-13", "updated: 2026-07-13", "aliases: [Atlas Engine]", "---", "body"].join("\n"),
      "utf8",
    );
    // The projection AS `db rebuild` writes it: a slug-equivalent alias COLLAPSES into
    // the single required kind='slug' identity row (the `one-slug-per-note` verify
    // invariant permits exactly one slug key per note and `normalized_key` is the PK),
    // so there is NO kind='alias' row for "Atlas Engine". `note related`/`note history`
    // resolve the seed against THIS projection — pre-fix they filtered kind='alias' and
    // returned note-not-found while `note show` resolved it, diverging the three.
    const store = openStore({ path: dbPath });
    try {
      store.projections.insertNote({ note_id: "concept-atlas", slug: "atlas-engine", title: "Atlas Engine", type: "concept", schema_version: 1, status: "active", file_path: "atlas-engine.md", content_hash: `sha256:${hash(1)}`, created: iso, updated: iso });
      store.projections.insertIdentityKey({ normalized_key: normalizeIdentityKey("atlas-engine"), note_id: "concept-atlas", kind: "slug", normalizer_version: 1 });
    } finally { store.close(); }

    // Sequential — the `cli` helper swaps the shared process.stdout.write, so
    // overlapping invocations would clobber each other's captured output.
    const alias = "Atlas Engine";
    const show = await cli(["note", "show", alias, "--json"]);
    const related = await cli(["note", "related", alias, "--json"]);
    const history = await cli(["note", "history", alias, "--json"]);
    expect(show.code, `show: ${show.out}`).toBe(0);
    expect(related.code, `related: ${related.out}`).toBe(0);
    expect(history.code, `history: ${history.out}`).toBe(0);
    // All three resolve the SAME alias to the SAME note id.
    expect(JSON.parse(show.out).note.id).toBe("concept-atlas");
    expect(JSON.parse(related.out).noteId).toBe("concept-atlas");
    expect(JSON.parse(history.out).noteId).toBe("concept-atlas");
  });

  it("NO-ALIAS PARITY: a bare slug (no declared alias) is NOT accepted as an alias by any of the three", async () => {
    // A note with filename slug "atlas-engine" and NO declared aliases. Its projection
    // is a single kind='slug' identity row keyed on normalizeIdentityKey("atlas-engine")
    // — BYTE-IDENTICAL to the slug-equivalent-alias case above, since that alias
    // collapses into the same row. `note show` resolves the seed "Atlas Engine" against
    // the vault, whose alias tier consults only DECLARED aliases (none here), so it
    // returns note-not-found. Round-1's "match ANY kind" would have let `note related`/
    // `note history` accept the bare slug row as an alias — diverging from `note show`.
    // Resolution must consult declared-alias evidence, so all three return not-found.
    writeFileSync(
      join(vaultDir, "atlas-engine.md"),
      ["---", "id: concept-atlas", "title: Atlas Engine", "type: concept", "status: active", "schema_version: 1", "created: 2026-07-13", "updated: 2026-07-13", "---", "body"].join("\n"),
      "utf8",
    );
    const store = openStore({ path: dbPath });
    try {
      store.projections.insertNote({ note_id: "concept-atlas", slug: "atlas-engine", title: "Atlas Engine", type: "concept", schema_version: 1, status: "active", file_path: "atlas-engine.md", content_hash: `sha256:${hash(1)}`, created: iso, updated: iso });
      store.projections.insertIdentityKey({ normalized_key: normalizeIdentityKey("atlas-engine"), note_id: "concept-atlas", kind: "slug", normalizer_version: 1 });
    } finally { store.close(); }

    // Sanity: the EXACT slug still resolves via the slug tier on all three (only the
    // normalized-but-inexact "Atlas Engine" spelling — an alias-only spelling — must miss).
    expect((await cli(["note", "show", "atlas-engine", "--json"])).code).toBe(0);
    expect((await cli(["note", "related", "atlas-engine", "--json"])).code).toBe(0);
    expect((await cli(["note", "history", "atlas-engine", "--json"])).code).toBe(0);

    const alias = "Atlas Engine";
    const show = await cli(["note", "show", alias, "--json"]);
    const related = await cli(["note", "related", alias, "--json"]);
    const history = await cli(["note", "history", alias, "--json"]);
    // Identical across all three: note-not-found (exit 1).
    expect(show.code, `show: ${show.out}`).toBe(1);
    expect(related.code, `related: ${related.out}`).toBe(1);
    expect(history.code, `history: ${history.out}`).toBe(1);
    expect(JSON.parse(show.out).code).toBe("note-not-found");
    expect(JSON.parse(related.out).code).toBe("note-not-found");
    expect(JSON.parse(history.out).code).toBe("note-not-found");
  });

  it("STALE PROJECTION ALIAS: a persisted kind='alias' row for an alias since REMOVED from the vault resolves NOWHERE (round-3)", async () => {
    // The vault note declares NO "legacy" alias (it was removed), but the projection
    // still carries a stale kind='alias' row from before the removal. `note show` reads
    // the vault and returns not-found. Pre-fix, `note related`/`note history` UNIONed the
    // stale row into tier 3 and still resolved it — diverging from `note show`. Current
    // vault declarations are authoritative, so all three must return not-found.
    writeFileSync(
      join(vaultDir, "atlas-note.md"),
      ["---", "id: concept-atlas", "title: Atlas", "type: concept", "status: active", "schema_version: 1", "created: 2026-07-13", "updated: 2026-07-13", "---", "body"].join("\n"),
      "utf8",
    );
    const store = openStore({ path: dbPath });
    try {
      store.projections.insertNote({ note_id: "concept-atlas", slug: "atlas-note", title: "Atlas", type: "concept", schema_version: 1, status: "active", file_path: "atlas-note.md", content_hash: `sha256:${hash(1)}`, created: iso, updated: iso });
      store.projections.insertIdentityKey({ normalized_key: normalizeIdentityKey("atlas-note"), note_id: "concept-atlas", kind: "slug", normalizer_version: 1 });
      // STALE: a kind='alias' row lingering from before "legacy" was removed in the vault.
      store.projections.insertIdentityKey({ normalized_key: normalizeIdentityKey("legacy"), note_id: "concept-atlas", kind: "alias", normalizer_version: 1 });
    } finally { store.close(); }

    const alias = "legacy";
    const show = await cli(["note", "show", alias, "--json"]);
    const related = await cli(["note", "related", alias, "--json"]);
    const history = await cli(["note", "history", alias, "--json"]);
    // Identical across all three: the removed alias resolves nowhere (exit 1).
    expect(show.code, `show: ${show.out}`).toBe(1);
    expect(related.code, `related: ${related.out}`).toBe(1);
    expect(history.code, `history: ${history.out}`).toBe(1);
    expect(JSON.parse(show.out).code).toBe("note-not-found");
    expect(JSON.parse(related.out).code).toBe("note-not-found");
    expect(JSON.parse(history.out).code).toBe("note-not-found");
  });

  it("REMAPPED PROJECTION ALIAS: an alias moved to another note resolves to the CURRENT vault owner, never ambiguous (round-3)", async () => {
    // The vault now declares alias "shared" on note B; note A no longer declares it.
    // The projection still carries a STALE kind='alias' row pointing "shared" at note A.
    // `note show` reads the vault and resolves "shared" to B. Pre-fix, `note related`/
    // `note history` UNIONed the stale A row with the vault's B row → two distinct owners
    // → ambiguous-note, diverging from `note show`. Current vault declarations are
    // authoritative, so all three resolve to B (the current owner) with no ambiguity.
    writeFileSync(
      join(vaultDir, "a-note.md"),
      ["---", "id: concept-a", "title: A", "type: concept", "status: active", "schema_version: 1", "created: 2026-07-13", "updated: 2026-07-13", "---", "body"].join("\n"),
      "utf8",
    );
    writeFileSync(
      join(vaultDir, "b-note.md"),
      ["---", "id: concept-b", "title: B", "type: concept", "status: active", "schema_version: 1", "created: 2026-07-13", "updated: 2026-07-13", "aliases: [shared]", "---", "body"].join("\n"),
      "utf8",
    );
    const store = openStore({ path: dbPath });
    try {
      store.projections.insertNote({ note_id: "concept-a", slug: "a-note", title: "A", type: "concept", schema_version: 1, status: "active", file_path: "a-note.md", content_hash: `sha256:${hash(1)}`, created: iso, updated: iso });
      store.projections.insertNote({ note_id: "concept-b", slug: "b-note", title: "B", type: "concept", schema_version: 1, status: "active", file_path: "b-note.md", content_hash: `sha256:${hash(2)}`, created: iso, updated: iso });
      store.projections.insertIdentityKey({ normalized_key: normalizeIdentityKey("a-note"), note_id: "concept-a", kind: "slug", normalizer_version: 1 });
      store.projections.insertIdentityKey({ normalized_key: normalizeIdentityKey("b-note"), note_id: "concept-b", kind: "slug", normalizer_version: 1 });
      // STALE/REMAPPED: `normalized_key` is the PK, so the projection holds exactly ONE
      // "shared" row — here still pointing at the OLD owner A, not yet re-projected to B.
      store.projections.insertIdentityKey({ normalized_key: normalizeIdentityKey("shared"), note_id: "concept-a", kind: "alias", normalizer_version: 1 });
    } finally { store.close(); }

    const alias = "shared";
    const show = await cli(["note", "show", alias, "--json"]);
    const related = await cli(["note", "related", alias, "--json"]);
    const history = await cli(["note", "history", alias, "--json"]);
    expect(show.code, `show: ${show.out}`).toBe(0);
    expect(related.code, `related: ${related.out}`).toBe(0);
    expect(history.code, `history: ${history.out}`).toBe(0);
    // All three resolve to the CURRENT vault owner (B), never the stale A, never ambiguous.
    expect(JSON.parse(show.out).note.id).toBe("concept-b");
    expect(JSON.parse(related.out).noteId).toBe("concept-b");
    expect(JSON.parse(history.out).noteId).toBe("concept-b");
  });
});

describe("note history: `commit` is the canonical SHA (git_operations), on an integrated run", () => {
  it("an integrated run surfaces its integrated commit_sha; a non-integrated run omits commit", async () => {
    // v2 (#338): the audit ledger is retired — note history projects one entry per
    // `agent_runs` row that targeted the note, its kind derived from the run status.
    const canonical = hash(0xca); // git_operations integrated commit_sha (the canonical SHA)
    const store = openStore({ path: dbPath });
    try {
      store.projections.insertNote({ note_id: "concept-atlas", slug: "atlas", title: "Atlas", type: "concept", schema_version: 1, status: "active", file_path: "atlas.md", content_hash: `sha256:${hash(1)}`, created: iso, updated: iso });
      store.ledger.upsertAgentRun({ run_id: ulid(9), operation: "ingest", status: "integrated", tier: 1, target_note_id: "concept-atlas", started_at: iso, updated_at: iso, finished_at: iso });
      store.db
        .prepare(`INSERT INTO git_operations (git_op_id, run_id, op_type, ref_name, commit_sha, created_at) VALUES (?, ?, 'integrated', ?, ?, ?)`)
        .run(`gop-int-${ulid(9)}`, ulid(9), "refs/heads/main", canonical, iso);
    } finally { store.close(); }

    const r = await cli(["note", "history", "concept-atlas", "--json"]);
    expect(r.code, r.out).toBe(0);
    const out = JSON.parse(r.out);
    validateSchema("note-history", out);
    const integrated = out.events.find((e: { kind: string }) => e.kind === "run.integrated");
    expect(integrated.commit).toBe(canonical); // canonical SHA from git_operations
  });

  it("a run that never integrated omits commit entirely (inapplicable)", async () => {
    const store = openStore({ path: dbPath });
    try {
      store.projections.insertNote({ note_id: "concept-open", slug: "open", title: "Open", type: "concept", schema_version: 1, status: "active", file_path: "open.md", content_hash: `sha256:${hash(1)}`, created: iso, updated: iso });
      store.ledger.upsertAgentRun({ run_id: ulid(8), operation: "ingest", status: "planned", tier: 2, target_note_id: "concept-open", started_at: iso, updated_at: iso });
    } finally { store.close(); }
    const r = await cli(["note", "history", "concept-open", "--json"]);
    expect(r.code, r.out).toBe(0);
    validateSchema("note-history", JSON.parse(r.out));
    expect(JSON.parse(r.out).events.every((e: { commit?: string }) => e.commit === undefined)).toBe(true);
  });
});

describe("note related/history surface a vault-read failure as a CONTRACT-DECLARED error (finding #2)", () => {
  it("a broken vault path yields `internal` (exit 4), never the undeclared `vault-error`", async () => {
    // The declared-alias resolution tier reads the current vault (loadVaultSnapshot). Its
    // read failure must map to a class the immutable note-related/note-history contracts
    // declare — internal/note-not-found/usage — NOT `vault-error` (which they don't list;
    // that code belongs to db-rebuild/doctor/git-*). Make the vault path unreadable: a file
    // where a directory is expected makes readVault throw ENOTDIR.
    rmSync(vaultDir, { recursive: true, force: true });
    writeFileSync(vaultDir, "not a directory", "utf8");

    for (const cmd of ["related", "history"]) {
      const r = await cli(["note", cmd, "anything", "--json"]);
      expect(r.code, `${cmd}: ${r.out}`).toBe(4);
      const code = JSON.parse(r.out).code;
      expect(code, `${cmd} code`).toBe("internal");
      expect(code).not.toBe("vault-error"); // undeclared for these commands
    }
  });
});


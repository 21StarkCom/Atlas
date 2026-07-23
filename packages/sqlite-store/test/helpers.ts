/**
 * Shared test helpers for `@atlas/sqlite-store`: in-memory `VaultSnapshot`
 * builders and the data-dictionary parser used by the migration-ownership test.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import type { ParsedNote, VaultSnapshot } from "@atlas/contracts";

const here = dirname(fileURLToPath(import.meta.url));
/** Repo root: packages/sqlite-store/test → ../../../ */
export const REPO_ROOT = join(here, "..", "..", "..");
export const DICTIONARY_PATH = join(REPO_ROOT, "docs", "specs", "sqlite-data-dictionary.md");

/** Build a minimal `ParsedNote` with sensible defaults for projection tests. */
export function makeNote(overrides: Partial<ParsedNote> & { id: string; path: string }): ParsedNote {
  return {
    type: "concept",
    schemaVersion: 1,
    title: overrides.id,
    status: "active",
    created: "2026-07-11",
    updated: "2026-07-11",
    aliases: [],
    sources: [],
    declaredSensitivity: "internal",
    links: [],
    relationships: [],
    sections: { heading: "", level: 0, path: "", children: [] },
    contentHash: "0".repeat(64),
    raw: "",
    ...overrides,
  };
}

/** Wrap notes into a `VaultSnapshot` (no errors). */
export function snapshot(notes: ParsedNote[]): VaultSnapshot {
  return { notes, errors: [] };
}

/**
 * Parse the data dictionary for `(table, owningMigration)` pairs. Recognizes
 * both the numbered-migration headings (`### \`notes\` — \`0001_core\` …`) and
 * the runner-bootstrap heading (`### \`db_schema_migrations\` — (runner bootstrap)`).
 */
export function parseDictionaryOwnership(): Map<string, string> {
  const md = readFileSync(DICTIONARY_PATH, "utf8");
  const map = new Map<string, string>();
  const re = /^###\s+`(\w+)`\s+—\s+(?:`(\w+)`|\(runner bootstrap\))/gm;
  let m: RegExpExecArray | null;
  while ((m = re.exec(md)) !== null) {
    const table = m[1]!;
    const owner = m[2] ?? "(runner bootstrap)";
    map.set(table, owner);
  }
  return map;
}

/** Tables the dictionary attributes to a given migration id. */
export function dictionaryTablesFor(owner: string): Set<string> {
  const set = new Set<string>();
  for (const [table, o] of parseDictionaryOwnership()) if (o === owner) set.add(table);
  return set;
}

/** User tables currently present in a connection (excludes SQLite internals). */
export function userTables(db: {
  prepare(sql: string): { all(): unknown[] };
}): Set<string> {
  const rows = db
    .prepare(
      `SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name`,
    )
    .all() as { name: string }[];
  return new Set(rows.map((r) => r.name));
}

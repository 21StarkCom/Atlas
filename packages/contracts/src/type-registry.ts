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

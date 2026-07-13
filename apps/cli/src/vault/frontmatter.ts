/**
 * Frontmatter parsing + validation (Task 1.3). Turns a note's leading YAML block
 * into the typed fields the reader needs — `id`, `type`, `schema_version`,
 * `aliases`, `sources`, `declaredSensitivity`, `data_categories`. Validation is a
 * VALUE, never a throw: `parseFrontmatter` returns either the parsed fields or a
 * structured failure the reader lifts into a `VaultError` (errors-as-values,
 * §2.5 / review hint).
 */
import { parse as parseYaml } from "yaml";
import { z } from "zod";
import type { Sensitivity } from "@atlas/contracts";

/** Sensitivity classes (plan §2.5; unlabeled content defaults to `internal`). */
const SENSITIVITY = ["public", "internal", "confidential", "restricted"] as const;

/** The only schema version this reader understands (schema-v1 fixture note). */
export const SUPPORTED_SCHEMA_VERSION = 1;

/**
 * Frontmatter schema. Extra keys (`title`, `status`, `created`, `updated`, …) are
 * passed through untouched — the reader only consumes the fields below. Optional
 * list/label fields default to empty; `declaredSensitivity` defaults to `internal`.
 *
 * `data_categories` is parsed and validated here per the plan, but the D14
 * `ParsedNote` DTO carries no field for it, so the reader does not surface it on
 * the note (it is validated-and-dropped until a DTO field exists).
 */
const FrontmatterSchema = z
  .object({
    id: z.string().min(1),
    type: z.string().min(1),
    schema_version: z.number().int(),
    aliases: z.array(z.string()).default([]),
    sources: z.array(z.string()).default([]),
    declaredSensitivity: z.enum(SENSITIVITY).default("internal"),
    data_categories: z.array(z.string()).default([]),
  })
  .passthrough();

/** The typed fields lifted out of a note's frontmatter. */
export interface Frontmatter {
  readonly id: string;
  readonly type: string;
  readonly schemaVersion: number;
  readonly aliases: readonly string[];
  readonly sources: readonly string[];
  readonly declaredSensitivity: Sensitivity;
}

/** A discriminated parse outcome — success carries fields, failure carries a typed reason. */
export type FrontmatterResult =
  | { readonly ok: true; readonly frontmatter: Frontmatter }
  | { readonly ok: false; readonly kind: FrontmatterErrorKind; readonly message: string };

export type FrontmatterErrorKind =
  | "missing-frontmatter"
  | "invalid-frontmatter"
  | "unsupported-schema-version";

/**
 * Parse + validate a note's raw frontmatter text. Never throws: malformed YAML,
 * schema violations, and unsupported schema versions all come back as
 * `{ ok: false }` with a specific `kind`.
 */
export function parseFrontmatter(frontmatter: string | null): FrontmatterResult {
  if (frontmatter === null) {
    return { ok: false, kind: "missing-frontmatter", message: "note has no YAML frontmatter block" };
  }

  let doc: unknown;
  try {
    doc = parseYaml(frontmatter);
  } catch (e) {
    return { ok: false, kind: "invalid-frontmatter", message: `frontmatter is not valid YAML: ${(e as Error).message}` };
  }
  if (doc === null || typeof doc !== "object" || Array.isArray(doc)) {
    return { ok: false, kind: "invalid-frontmatter", message: "frontmatter must be a YAML mapping" };
  }

  const parsed = FrontmatterSchema.safeParse(doc);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    const key = issue && issue.path.length > 0 ? issue.path.join(".") : undefined;
    return {
      ok: false,
      kind: "invalid-frontmatter",
      message: `frontmatter validation failed${key ? ` at \`${key}\`` : ""}: ${issue?.message ?? "unknown"}`,
    };
  }

  // Reader refuses any unsupported or newer schema version (schema-v1 fixture).
  if (parsed.data.schema_version !== SUPPORTED_SCHEMA_VERSION) {
    return {
      ok: false,
      kind: "unsupported-schema-version",
      message: `unsupported schema_version ${parsed.data.schema_version} (this reader supports ${SUPPORTED_SCHEMA_VERSION})`,
    };
  }

  return {
    ok: true,
    frontmatter: {
      id: parsed.data.id,
      type: parsed.data.type,
      schemaVersion: parsed.data.schema_version,
      aliases: parsed.data.aliases,
      sources: parsed.data.sources,
      declaredSensitivity: parsed.data.declaredSensitivity,
    },
  };
}

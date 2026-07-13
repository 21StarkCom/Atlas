/**
 * `loadConfig` — read + validate `brain.config.yaml`, apply `ATLAS_<SECTION>_<KEY>`
 * env overrides, and return a typed `AtlasConfig` (Task 1.2 / #18). Any failure throws
 * `ConfigError` (exit code 2) naming the offending file + key.
 */
import { readFileSync } from "node:fs";
import { join, isAbsolute } from "node:path";
import { parse as parseYaml } from "yaml";
import { canonicalSerialize } from "@atlas/contracts";
import {
  AtlasConfigSchema,
  CONFIG_SECTIONS,
  ConfigError,
  type AtlasConfig,
  type ConfigSection,
} from "./schema.js";

const CONFIG_BASENAME = "brain.config.yaml";

export interface LoadedConfig {
  config: AtlasConfig;
  /** Absolute path the config was read from. */
  path: string;
  /** Canonical hash of the effective (post-override) config, for run manifests / audit. */
  hash: string;
}

/** Coerce an env-string override into the JSON type of the existing value it replaces. */
function coerceLike(current: unknown, raw: string): unknown {
  if (typeof current === "boolean") {
    if (raw === "true") return true;
    if (raw === "false") return false;
    return raw; // let schema validation reject it with a clear message
  }
  if (typeof current === "number") {
    const n = Number(raw);
    return Number.isNaN(n) ? raw : n;
  }
  if (Array.isArray(current)) {
    return raw
      .split(",")
      .map((s) => s.trim())
      .map((s) => {
        const n = Number(s);
        return Number.isNaN(n) ? s : n;
      });
  }
  return raw;
}

/**
 * Apply `ATLAS_<SECTION>_<KEY>` overrides onto the parsed doc. `<SECTION>` is a
 * top-level section; `<KEY>` addresses a scalar/array field within it (dotted keys
 * lower-case, e.g. `ATLAS_SQLITE_LEDGER_BACKUP_KEEP` → `sqlite.ledger_backup.keep`).
 */
function applyEnvOverrides(doc: Record<string, unknown>, env: NodeJS.ProcessEnv): void {
  for (const [name, value] of Object.entries(env)) {
    if (value === undefined || !name.startsWith("ATLAS_")) continue;
    const rest = name.slice("ATLAS_".length).toLowerCase();
    const section = CONFIG_SECTIONS.find((s) => rest === s || rest.startsWith(`${s}_`));
    if (!section) continue;
    const keyPath = rest.slice(section.length + 1); // may be "" for whole-section (skip)
    if (!keyPath) continue;

    // Resolve the key path against the existing section object, longest-known-prefix first,
    // so nested objects (ledger_backup) match before falling back to a flat key.
    const sectionObj = (doc[section] ??= {}) as Record<string, unknown>;
    if (!setByUnderscorePath(sectionObj, keyPath, value)) {
      // Unknown override target: place it flat so schema `.strict()` surfaces it as an error.
      sectionObj[keyPath] = value;
    }
  }
}

/** Walk an object choosing the longest existing-key prefix at each step; set the leaf. */
function setByUnderscorePath(obj: Record<string, unknown>, path: string, raw: string): boolean {
  const parts = path.split("_");
  let cur: Record<string, unknown> = obj;
  let i = 0;
  while (i < parts.length) {
    // Greedily match the longest join that names an existing object key (to descend) or any key (leaf).
    let matched = -1;
    for (let j = parts.length; j > i; j--) {
      const candidate = parts.slice(i, j).join("_");
      if (candidate in cur) {
        matched = j;
        if (j === parts.length) {
          cur[candidate] = coerceLike(cur[candidate], raw);
          return true;
        }
        const next = cur[candidate];
        if (next && typeof next === "object" && !Array.isArray(next)) {
          cur = next as Record<string, unknown>;
          i = j;
          break;
        }
      }
    }
    if (matched === -1) {
      // No existing prefix: set the remaining path as a single flat key (schema will validate).
      cur[parts.slice(i).join("_")] = raw;
      return true;
    }
  }
  return false;
}

/**
 * Load + validate config. `configPathOverride` (from `--config`) wins; otherwise
 * `<cwd>/brain.config.yaml`.
 */
export function loadConfig(
  cwd: string,
  env: NodeJS.ProcessEnv,
  configPathOverride?: string,
): LoadedConfig {
  const path = configPathOverride
    ? isAbsolute(configPathOverride)
      ? configPathOverride
      : join(cwd, configPathOverride)
    : join(cwd, CONFIG_BASENAME);

  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch {
    throw new ConfigError(`config file not found or unreadable: ${path}`, { file: path });
  }

  let doc: unknown;
  try {
    doc = parseYaml(text);
  } catch (e) {
    throw new ConfigError(`config is not valid YAML: ${(e as Error).message}`, { file: path });
  }
  if (doc === null || typeof doc !== "object" || Array.isArray(doc)) {
    throw new ConfigError("config must be a YAML mapping", { file: path });
  }

  applyEnvOverrides(doc as Record<string, unknown>, env);

  const parsed = AtlasConfigSchema.safeParse(doc);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    const key = issue && issue.path.length > 0 ? issue.path.join(".") : undefined;
    const location = key !== undefined ? { file: path, key } : { file: path };
    throw new ConfigError(
      `config validation failed${key ? ` at \`${key}\`` : ""}: ${issue?.message ?? "unknown"}`,
      location,
    );
  }

  const hash = `sha256:${sha256Hex(canonicalSerialize(parsed.data))}`;
  return { config: parsed.data, path, hash };
}

// Local sha256 (avoid pulling a dep into the config module for a hash).
import { createHash } from "node:crypto";
function sha256Hex(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

export type { AtlasConfig, ConfigSection };
export { ConfigError };

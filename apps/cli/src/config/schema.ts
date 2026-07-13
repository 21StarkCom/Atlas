/**
 * `config` internal module — the typed schema for `brain.config.yaml` (Task 1.2 / #18).
 *
 * `brain.config.yaml` is the single owner of every threshold/path the plan names
 * (D4 chunker_version, D7 dimensions, D8 audit_anchor_path, D10 broker sockets).
 * Modules consume `AtlasConfig`, never literals. Validation is strict: unknown keys
 * and malformed values fail startup with a `ConfigError` (plan §2.5 exit code 2).
 */
import { z } from "zod";

/** Content sensitivity classes (plan §2.5; default `internal` for unlabeled content). */
export const Sensitivity = z.enum(["public", "internal", "confidential", "restricted"]);
export type Sensitivity = z.infer<typeof Sensitivity>;

/** Risk tiers 0–3 (plan §2.5); `auto_commit_risk_levels` lists the auto-integrated tiers. */
export const RiskTier = z.union([z.literal(0), z.literal(1), z.literal(2), z.literal(3)]);

const VaultConfig = z
  .object({
    path: z.string().min(1),
  })
  .strict();

const LedgerBackupConfig = z
  .object({
    dir: z.string().min(1),
    keep: z.number().int().positive().default(10), // keep-N + keep-forever-latest (ledger-backup-contract.md)
  })
  .strict();

const SqliteConfig = z
  .object({
    path: z.string().min(1),
    ledger_backup: LedgerBackupConfig,
    ledger_retention: z.enum(["keep-forever"]).default("keep-forever"), // plan §2.5 default
    raw_payload_store: z.boolean().default(false), // opt-in AEAD raw store, default off (plan §2.5)
  })
  .strict();

const LancedbConfig = z
  .object({
    dir: z.string().min(1),
  })
  .strict();

const IndexingConfig = z
  .object({
    chunker_version: z.number().int().positive().default(1), // D4
    embedding_model: z.string().min(1).default("gemini-embedding-001"),
    dimensions: z.number().int().positive().default(768), // D7 (changing it opens a new index generation)
  })
  .strict();

const GitConfig = z
  .object({
    worktrees_path: z.string().min(1),
    auto_commit_risk_levels: z.array(RiskTier).default([1, 2]), // Tier-1/2 auto-integrate; Tier-3 review
    audit_anchor_path: z.string().min(1), // D8 (broker-owned, outside vault+repo)
  })
  .strict();

const ModelsConfig = z
  .object({
    generation_model: z.string().min(1).default("gemini-3-5-flash"),
    embedding_model: z.string().min(1).default("gemini-embedding-001"),
  })
  .strict();

const PoliciesConfig = z
  .object({
    // Tier-2 auto-commit thresholds (plan §2.5). Owned here so tasks read config, not literals.
    tier2_min_confidence: z.number().min(0).max(1).default(0.8),
    tier2_max_changed_lines: z.number().int().positive().default(50),
    tier2_max_sections: z.number().int().positive().default(3),
    default_sensitivity: Sensitivity.default("internal"),
    require_sources_for_synthesis: z.boolean().default(true),
  })
  .strict();

const LogsConfig = z
  .object({
    dir: z.string().min(1),
    max_files: z.number().int().positive().default(10),
    max_bytes: z.number().int().positive().default(10_485_760), // 10 MiB per file
  })
  .strict();

const BrokerConfig = z
  .object({
    socket_path: z.string().min(1), // D10
    egress_socket_path: z.string().min(1), // D10
  })
  .strict();

/** The full `brain.config.yaml` schema. Every section is required; keys default per the plan. */
export const AtlasConfigSchema = z
  .object({
    vault: VaultConfig,
    sqlite: SqliteConfig,
    lancedb: LancedbConfig,
    indexing: IndexingConfig,
    git: GitConfig,
    models: ModelsConfig,
    policies: PoliciesConfig,
    logs: LogsConfig,
    broker: BrokerConfig,
  })
  .strict();

export type AtlasConfig = z.infer<typeof AtlasConfigSchema>;

/** The top-level config section names, used for `ATLAS_<SECTION>_<KEY>` env overrides. */
export const CONFIG_SECTIONS = [
  "vault",
  "sqlite",
  "lancedb",
  "indexing",
  "git",
  "models",
  "policies",
  "logs",
  "broker",
] as const;
export type ConfigSection = (typeof CONFIG_SECTIONS)[number];

/**
 * Startup config failure — maps to plan §2.5 exit code 2 (config/vault). Carries the
 * offending file + key path + location so the operator sees exactly what to fix.
 */
export class ConfigError extends Error {
  readonly exitCode = 2 as const;
  constructor(
    message: string,
    readonly location: { file: string; key?: string },
  ) {
    super(message);
    this.name = "ConfigError";
  }
}

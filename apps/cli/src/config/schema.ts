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
    // D9 custody: the identity-scoped key DIRECTORY holding per-keyId AEAD key
    // files (`<keyId>.key`, base64 32 bytes). Defaults to the per-OS location.
    // The key is NEVER read from an environment variable (round-2 finding).
    key_dir: z.string().min(1).optional(),
    // The CURRENT AEAD key id (§7 rotation). Backups are stamped with it; prior
    // ids remain readable from `key_dir` so rotated-out backups still decrypt.
    key_id: z.string().min(1).default("cli-custody-v1"),
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

/**
 * Retrieval / hybrid-search tuning (retrieval-index-contract.md §5/§6). Single owner of the RRF
 * weights/bounds + the FTS-maturity fallback switch — code reads these, never inlines them.
 * `retrieval.rrf.weights.vector` is bounded strictly-positive: the §6 fallback fuses over the vector
 * layer alone, so a zero vector weight would annihilate the only surviving statistical layer.
 */
const RetrievalConfig = z
  .object({
    rrf: z
      .object({
        k: z.number().int().min(1).max(1000).default(60), // §5 RRF k, bounds [1,1000]
        weights: z
          .object({
            fts: z.number().min(0).max(10).default(1.0), // may be 0 (disable FTS by weight)
            // strictly-positive: `.gt(0)` — the vector-only FTS fallback (§6) must still fuse
            vector: z.number().gt(0).max(10).default(1.0),
          })
          .strict()
          .default({}),
      })
      .strict()
      .default({}),
    fts: z
      .object({
        // LanceDB FTS participation (§6). false → hybrid degrades to vector + id/alias with RRF.
        enabled: z.boolean().default(true),
      })
      .strict()
      .default({}),
  })
  .strict()
  .default({});

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

/**
 * Jobs queue tuning (jobs-contract.md §2/§3). Single owner of the attempt budget
 * + backoff constants — the runner reads these, never inlines them. Defaults per
 * the contract; the whole section defaults so an existing config loads unchanged.
 */
const JobsConfig = z
  .object({
    max_attempts: z.number().int().min(1).max(20).default(5), // §2 default 5, bounds [1,20]
    backoff_base_ms: z.number().int().positive().default(1000), // §3
    backoff_factor: z.number().min(1).default(2), // §3
    backoff_max_ms: z.number().int().positive().default(300_000), // §3
  })
  .strict()
  .default({});

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

/**
 * Encrypted-quarantine store (Task 2.2 / #28). The store holds AEAD-sealed,
 * detected-secret content. `dir` MUST be OUTSIDE the repo + vault (the plan requires
 * an outside-repository location — `.gitignore` is not an isolation boundary); it is
 * created mode 0700 with no symlink components. LEFT UNSET (the default), it resolves
 * to an OS state directory (`quarantine/config.ts#quarantineDir`); a configured value
 * is validated to be outside the repo + vault. The AEAD key is trusted-CLI-only +
 * parser/model-denied (ACL matrix row `quarantine-aead`) and is read from platform
 * custody by `key_id` — never from config/env. `revoked_key_ids` fail closed on read.
 * The whole section defaults, so an existing config loads unchanged.
 */
/** A quarantine key id must be a single safe path component (mirrors quarantine/config `SAFE_KEY_ID`). */
const SAFE_KEY_ID = /^[A-Za-z0-9._-]{1,64}$/;
const isSafeKeyId = (id: string): boolean => SAFE_KEY_ID.test(id) && id !== "." && id !== "..";

export const QuarantineConfig = z
  .object({
    // Optional: unset ⇒ OS state dir; a set value is validated outside repo + vault.
    dir: z.string().min(1).optional(),
    keep: z.number().int().positive().default(200), // keep-N most-recent
    retention_days: z.number().int().positive().default(30), // TTL → expiresAt
    key_id: z.string().min(1).default("cli-custody-v1"), // current key id (§7 rotation)
    revoked_key_ids: z.array(z.string().min(1)).default([]), // ids that fail closed on read
  })
  .strict()
  // Finding: a config could revoke the CURRENT key_id (or carry unsafe/duplicate ids),
  // so the store would write new bundles under a key `keyForRead` immediately rejects —
  // making freshly quarantined data unreadable. Enforce safe syntax, uniqueness, and
  // that the current key_id is never revoked.
  .superRefine((q, ctx) => {
    if (!isSafeKeyId(q.key_id)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["key_id"],
        message: `quarantine.key_id ${JSON.stringify(q.key_id)} is not a safe key id (must match [A-Za-z0-9._-]{1,64})`,
      });
    }
    const seen = new Set<string>();
    q.revoked_key_ids.forEach((id, i) => {
      if (!isSafeKeyId(id)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["revoked_key_ids", i],
          message: `quarantine.revoked_key_ids[${i}] ${JSON.stringify(id)} is not a safe key id (must match [A-Za-z0-9._-]{1,64})`,
        });
      }
      if (seen.has(id)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["revoked_key_ids", i],
          message: `quarantine.revoked_key_ids contains a duplicate id ${JSON.stringify(id)}`,
        });
      }
      seen.add(id);
      if (id === q.key_id) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["revoked_key_ids", i],
          message: `quarantine.key_id ${JSON.stringify(q.key_id)} cannot appear in revoked_key_ids — new bundles would be unreadable`,
        });
      }
    });
  })
  .default({});

/** The full `brain.config.yaml` schema. Every section is required; keys default per the plan. */
export const AtlasConfigSchema = z
  .object({
    vault: VaultConfig,
    sqlite: SqliteConfig,
    lancedb: LancedbConfig,
    indexing: IndexingConfig,
    retrieval: RetrievalConfig,
    git: GitConfig,
    models: ModelsConfig,
    policies: PoliciesConfig,
    jobs: JobsConfig,
    logs: LogsConfig,
    broker: BrokerConfig,
    quarantine: QuarantineConfig,
  })
  .strict();

export type AtlasConfig = z.infer<typeof AtlasConfigSchema>;

/** The top-level config section names, used for `ATLAS_<SECTION>_<KEY>` env overrides. */
export const CONFIG_SECTIONS = [
  "vault",
  "sqlite",
  "lancedb",
  "indexing",
  "retrieval",
  "git",
  "models",
  "policies",
  "jobs",
  "logs",
  "broker",
  "quarantine",
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

/**
 * `graduation/audit` — the read-only bootstrap audit (Task 5.2 / #58). Before a copied vault
 * is graduated, its ledger state is verified through the AUTHORITATIVE read-only surfaces — the
 * broker's live audit-chain verdict, the backup watermark, and the open-run census — so a
 * partially-migrated or tampered copy is caught before any privileged graduation step runs.
 * Purely read-only + fail-closed: any unhealthy signal makes the whole audit `ok: false`.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";
import { watermarkHealth, type SqliteDatabase, type WatermarkHealth } from "@atlas/sqlite-store";
import { STRICT_TYPES, LOOSE_TYPES, type VaultSnapshot } from "@atlas/contracts";
import { splitFrontmatter } from "../markdown/parse.js";

/** Back-compat export, now DERIVED from the registry (open system). Consumers that
 *  imported this constant keep working; it now reflects the full registered set. */
export const GRADUATION_KNOWN_TYPES: readonly string[] = [...STRICT_TYPES, ...LOOSE_TYPES];

/** The bootstrap-migration §7 quarantine categories the graduation audit inventories. */
export const GRADUATION_CATEGORIES = [
  "missing-id",
  "missing-type",
  "missing-schema-version",
  "ambiguous-alias",
  "duplicate-identity",
  "incompatible-link",
  "detected-credential",
  "unknown-type",
  "unsupported-schema-version",
] as const;
export type GraduationCategory = (typeof GRADUATION_CATEGORIES)[number];

/** Per-category repo-relative note-path lists (§7). Every key is always present (empty if none). */
export type GraduationCategories = Record<GraduationCategory, string[]>;

/** Split which required frontmatter field(s) an unparseable/invalid note is missing. */
function classifyMissing(vaultPath: string, rel: string): GraduationCategory[] {
  let raw: string;
  try {
    raw = readFileSync(join(vaultPath, rel), "utf8");
  } catch {
    return ["missing-id"]; // unreadable ⇒ no id derivable
  }
  const { frontmatter } = splitFrontmatter(raw);
  if (frontmatter === null) return ["missing-id"];
  let fm: Record<string, unknown> | null = null;
  try {
    fm = parseYaml(frontmatter) as Record<string, unknown>;
  } catch {
    return ["missing-id"]; // malformed YAML ⇒ treat as missing id
  }
  const out: GraduationCategory[] = [];
  if (fm == null || fm.id == null) out.push("missing-id");
  if (fm == null || fm.type == null) out.push("missing-type");
  if (fm == null || fm.schema_version == null) out.push("missing-schema-version");
  return out.length > 0 ? out : ["missing-id"]; // invalid for some other reason ⇒ default
}

/**
 * Inventory a graduation copy by the §7 categories (Task 5.2), read-only. Maps every vault-reader
 * defect (parse errors, duplicate ids, identity collisions, broken/ambiguous links, unsupported
 * schema versions) to its §7 category, splits the missing-field defects per re-parsed frontmatter,
 * and flags notes with an empty/absent `type` as `unknown-type` (open registry, #151: any
 * non-empty asserted type — registered or not — is "known"). `detected-credential` is always
 * empty here — the fail-closed scan-state gate guarantees a CLEAN scan precedes the audit.
 */
export function categorizeGraduationCopy(vaultPath: string, snapshot: VaultSnapshot): { totalNotes: number; categories: GraduationCategories } {
  const cats = Object.fromEntries(GRADUATION_CATEGORIES.map((c) => [c, [] as string[]])) as GraduationCategories;
  // Open system: registration no longer gates the audit. Any non-empty asserted type
  // is "known" (the migrator keeps unknown types as loose, never refused). An empty/
  // absent type still falls through to the existing missing-type category.
  const isKnown = (type: string): boolean => type.trim() !== "";

  for (const e of snapshot.errors) {
    switch (e.kind) {
      case "duplicate-id":
        cats["duplicate-identity"].push(e.path);
        break;
      case "identity-collision":
        cats["ambiguous-alias"].push(e.path);
        break;
      case "broken-link":
      case "ambiguous-link":
        cats["incompatible-link"].push(e.path);
        break;
      case "unsupported-schema-version":
        cats["unsupported-schema-version"].push(e.path);
        break;
      case "missing-frontmatter":
      case "invalid-frontmatter":
      case "read-error":
        for (const m of classifyMissing(vaultPath, e.path)) cats[m].push(e.path);
        break;
      default:
        break; // an unrecognized reader-error kind is not force-fit into a §7 category
    }
  }
  for (const n of snapshot.notes) if (!isKnown(n.type)) cats["unknown-type"].push(n.path);

  for (const c of GRADUATION_CATEGORIES) cats[c] = [...new Set(cats[c])].sort();
  const totalNotes = snapshot.notes.length + new Set(snapshot.errors.map((e) => e.path)).size;
  return { totalNotes, categories: cats };
}

/** The broker's read-only audit-chain health verdict (mirrors `BrokerClient.getAuditChainStatus`). */
export interface AuditChainStatus {
  readonly ok: boolean;
  readonly head: string;
  readonly count: number;
  readonly detail?: string;
}

/** The aggregated bootstrap-audit report. */
export interface GraduationAuditReport {
  /** `true` iff EVERY checked signal is healthy — the only state that permits graduation. */
  readonly ok: boolean;
  readonly auditChain: AuditChainStatus;
  readonly backup: WatermarkHealth;
  /** Count of runs that are neither finalized nor terminal (must be zero to graduate cleanly). */
  readonly openRuns: number;
  /** Human-readable reasons the audit is not ok (empty iff ok). */
  readonly blockers: readonly string[];
}

/** Count runs still in flight (not finalized and not a terminal state). */
function openRunCount(db: SqliteDatabase): number {
  const row = db
    .prepare(
      `SELECT COUNT(*) AS n FROM agent_runs
        WHERE status NOT IN ('finalized','rejected','rolled-back','failed','cancelled')`,
    )
    .get() as { n: number };
  return row.n;
}

/**
 * Run the read-only bootstrap audit over a copied vault's ledger. `auditChain` is the broker's
 * AUTHORITATIVE live-chain verdict (injected — the broker owns `refs/audit/runs`), verified
 * against the SQLite-side backup watermark + open-run census. Fail-closed: an unhealthy chain,
 * a blocked/unhealthy backup, or any open run blocks graduation with named blockers.
 */
export function graduationAudit(db: SqliteDatabase, auditChain: AuditChainStatus): GraduationAuditReport {
  const backup = watermarkHealth(db);
  const openRuns = openRunCount(db);
  const blockers: string[] = [];
  if (!auditChain.ok) blockers.push(`audit chain unhealthy: ${auditChain.detail ?? "broken"}`);
  if (!backup.healthy) blockers.push(`backup watermark unhealthy (covered ${backup.coveredSeq} of ${backup.seq})`);
  if (openRuns > 0) blockers.push(`${openRuns} run(s) still in flight (must reach a terminal/finalized state before graduation)`);
  return { ok: blockers.length === 0, auditChain, backup, openRuns, blockers };
}

/**
 * `claims/fold` — `foldClaimManifests(snapshot, tx)`: the retained-PR-A rebuild
 * reader that reconstructs the `claims` + `claim_evidence` projections from the
 * canonical Markdown `claims:` blocks in a `VaultSnapshot` (dictionary §5 / §8).
 * Registered into {@link import("../rebuild.js").rebuildProjections} and run
 * inside its transaction (the "`tx`" of the signature is the transaction-scoped
 * `db`), AFTER the provenance fold so evidence can pin existing renditions.
 *
 * ## Why this is a fold over canonical Markdown
 * Retained PR-A discipline (plan §1 / §4.1): a Phase-4 feature revert must never
 * orphan claims projections. Because the vault Markdown is the system of record,
 * `db rebuild` reproduces every claim/evidence row from the `claims:` blocks
 * alone — so a claims-bearing vault rebuilds losslessly with ONLY `0004_claims`
 * (PR-A) applied, no feature code present (acceptance §Acceptance-Criteria).
 *
 * ## Fail-closed rebuild
 * The fold NEVER commits a partial projection. It runs after `clearAll()` inside
 * the rebuild transaction, so any thrown error rolls the whole rebuild back and
 * leaves the PRE-EXISTING claims projection intact (dictionary §8). Every
 * malformed `claims:` block is a {@link MalformedClaimError}; every evidence
 * entry naming a rendition absent from the rebuilt provenance projection is a
 * {@link DanglingEvidenceError} — never a silent skip.
 *
 * ## The normative `claims:` block (owning-note frontmatter)
 * A note OWNS a claim iff its frontmatter carries a `claims:` list. Each entry:
 *
 * ```yaml
 * claims:
 *   - claim_id: claim-meridian-2025
 *     text: "Project Meridian launched in 2025."
 *     status: active                 # optional; default 'active'
 *     created_at: 2026-07-11T00:00:00Z   # optional; defaults to the note's `created`
 *     evidence:                      # optional
 *       - rendition: "sha256:<64hex>:text/plain:1:1"   # a renditionId handle (5-segment)
 *         locator: "char:10-42"      # optional; sentinel '(none)' when absent
 *         quote_hash: "<64hex>"      # optional; sentinel '(none)' when absent
 *         verification: valid        # optional; default 'pending' (Markdown is SSOT)
 *         current: true              # optional; default true
 *         tombstoned_at: ...         # required iff current: false
 *         evidence_id: ...           # optional explicit surrogate
 *         lineage_id: ...            # optional explicit lineage key
 *         supersedes_evidence_id: ...# optional prior head
 * ```
 *
 * `owning_note_id` is the note's own id. Markdown is the SSOT for `verification`
 * (Review-Hint), so the fold folds the persisted state back verbatim.
 */
import { parse as parseYaml } from "yaml";
import { parseSourceHandle, type VaultSnapshot } from "@atlas/contracts";
import type { SqliteDatabase } from "../connection.js";
import { ClaimsRepo, type EvidenceVerification } from "../repos/claims.js";
import type { RenditionComponents } from "../repos/provenance.js";
import { registerProjectionFold, registerPreClear } from "../rebuild.js";

/** The verification states permitted by the `claim_evidence` CHECK (dictionary §5). */
const VERIFICATIONS: ReadonlySet<string> = new Set(["valid", "stale", "pending", "failed"]);

/**
 * Raised when a note's `claims:` block is malformed: a missing/invalid required
 * field on a claim or an evidence entry. Thrown inside the rebuild transaction so
 * it rolls back (fail-closed).
 */
export class MalformedClaimError extends Error {
  constructor(readonly notePath: string, readonly reason: string) {
    super(`malformed claims block \`${notePath}\`: ${reason} — rolling back rebuild`);
    this.name = "MalformedClaimError";
  }
}

/**
 * Raised when an evidence entry pins a rendition that no source manifest in this
 * snapshot reconstructed (the composite FK would reject it too; this typed throw
 * names the offending reference). Thrown inside the rebuild transaction so it
 * rolls back (dictionary §5: a rendition cited by evidence must exist).
 */
export class DanglingEvidenceError extends Error {
  constructor(readonly claimId: string, readonly reference: string, readonly reason: string) {
    super(
      `dangling evidence on claim \`${claimId}\`: "${reference}" ${reason} — rolling back rebuild`,
    );
    this.name = "DanglingEvidenceError";
  }
}

/** Extract and YAML-parse the leading `---` frontmatter block of a note's raw text. */
function parseFrontmatter(raw: string): Record<string, unknown> | undefined {
  const m = /^﻿?\s*---\r?\n([\s\S]*?)\r?\n---\s*(?:\r?\n|$)/.exec(raw);
  if (!m) return undefined;
  try {
    const parsed = parseYaml(m[1]!) as unknown;
    return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : undefined;
  } catch {
    return undefined;
  }
}

function asString(v: unknown): string | undefined {
  if (typeof v === "string") return v;
  if (v instanceof Date) return v.toISOString();
  if (typeof v === "number") return String(v);
  return undefined;
}

/**
 * Reconstruct the claims projections from `snapshot` inside the rebuild
 * transaction `db`. A self-guarded no-op when `0004_claims` has not been applied
 * (Phase-1/2 DBs rebuild unchanged). Clears the two claims tables then re-derives
 * every row from the canonical `claims:` blocks. Any malformed block or dangling
 * evidence rendition throws, rolling the rebuild back (fail-closed).
 */
export function foldClaimManifests(snapshot: VaultSnapshot, db: SqliteDatabase): void {
  if (!ClaimsRepo.isApplied(db)) return;
  const repo = new ClaimsRepo(db);
  repo.clearAll();

  const renditionExists = db.prepare(
    `SELECT 1 FROM source_renditions
      WHERE raw_content_hash = ? AND canonical_media_type = ?
        AND extractor_version = ? AND normalizer_version = ?`,
  );

  for (const note of snapshot.notes) {
    const fm = parseFrontmatter(note.raw);
    if (!fm) continue;
    const claimsRaw = fm.claims;
    if (claimsRaw === undefined) continue; // not a claim-owning note
    if (!Array.isArray(claimsRaw)) {
      throw new MalformedClaimError(note.path, "`claims:` must be a list");
    }

    for (const c of claimsRaw) {
      if (!c || typeof c !== "object" || Array.isArray(c)) {
        throw new MalformedClaimError(note.path, "each `claims:` entry must be a map");
      }
      const cc = c as Record<string, unknown>;
      const claimId = asString(cc.claim_id);
      if (claimId === undefined || claimId.length === 0) {
        throw new MalformedClaimError(note.path, "a claim entry is missing `claim_id`");
      }
      const text = asString(cc.text);
      if (text === undefined) {
        throw new MalformedClaimError(note.path, `claim "${claimId}" is missing \`text\``);
      }
      const status = asString(cc.status) ?? "active";
      const createdAt = asString(cc.created_at) ?? note.created;

      repo.upsertClaim({
        claim_id: claimId,
        owning_note_id: note.id,
        text,
        status,
        created_at: createdAt,
      });

      const evidenceRaw = cc.evidence;
      if (evidenceRaw === undefined) continue;
      if (!Array.isArray(evidenceRaw)) {
        throw new MalformedClaimError(note.path, `claim "${claimId}" \`evidence\` must be a list`);
      }
      for (const e of evidenceRaw) {
        if (!e || typeof e !== "object" || Array.isArray(e)) {
          throw new MalformedClaimError(note.path, `claim "${claimId}" evidence entry must be a map`);
        }
        const ee = e as Record<string, unknown>;
        const renditionRef = asString(ee.rendition);
        if (renditionRef === undefined) {
          throw new MalformedClaimError(note.path, `claim "${claimId}" evidence is missing \`rendition\``);
        }
        let handle;
        try {
          handle = parseSourceHandle(renditionRef);
        } catch (err) {
          throw new MalformedClaimError(
            note.path,
            `claim "${claimId}" evidence rendition "${renditionRef}" is invalid (${(err as Error).message})`,
          );
        }
        if (handle.kind !== "rendition") {
          throw new MalformedClaimError(
            note.path,
            `claim "${claimId}" evidence must pin a rendition handle (5-segment), got "${renditionRef}"`,
          );
        }
        const rendition: RenditionComponents = {
          raw_content_hash: handle.rawContentHash,
          canonical_media_type: handle.canonicalMediaType,
          extractor_version: handle.extractorVersion,
          normalizer_version: handle.normalizerVersion,
        };
        if (
          renditionExists.get(
            rendition.raw_content_hash,
            rendition.canonical_media_type,
            rendition.extractor_version,
            rendition.normalizer_version,
          ) === undefined
        ) {
          throw new DanglingEvidenceError(
            claimId,
            renditionRef,
            "names a rendition absent from the rebuilt provenance projection",
          );
        }

        const verification = ee.verification === undefined ? undefined : asString(ee.verification);
        if (verification !== undefined && !VERIFICATIONS.has(verification)) {
          throw new MalformedClaimError(
            note.path,
            `claim "${claimId}" evidence verification "${verification}" is not a valid state`,
          );
        }

        // `current` defaults to true; the `(current = 1) = (tombstoned_at IS NULL)`
        // CHECK requires a tombstoned entry (current: false) to carry
        // `tombstoned_at` AND a current entry to omit it. Both violations are
        // rejected here (never silently normalized — Markdown is SSOT, dictionary
        // §5) so a bad block rolls the rebuild back with a clear message.
        const currentRaw = ee.current;
        const current = currentRaw === undefined ? true : currentRaw === true;
        if (currentRaw !== undefined && typeof currentRaw !== "boolean") {
          throw new MalformedClaimError(note.path, `claim "${claimId}" evidence \`current\` must be a boolean`);
        }
        const tombstonedAt = asString(ee.tombstoned_at) ?? null;
        if (!current && tombstonedAt === null) {
          throw new MalformedClaimError(
            note.path,
            `claim "${claimId}" tombstoned evidence (current: false) requires \`tombstoned_at\``,
          );
        }
        if (current && tombstonedAt !== null) {
          throw new MalformedClaimError(
            note.path,
            `claim "${claimId}" current evidence (current: true) must not carry \`tombstoned_at\``,
          );
        }

        const locator = asString(ee.locator);
        const quoteHash = asString(ee.quote_hash);
        repo.attachEvidence({
          claim_id: claimId,
          rendition,
          locator: locator ?? null,
          quote_hash: quoteHash ?? null,
          verification: verification as EvidenceVerification | undefined,
          created_at: asString(ee.created_at) ?? createdAt,
          evidence_id: asString(ee.evidence_id),
          lineage_id: asString(ee.lineage_id),
          supersedes_evidence_id: asString(ee.supersedes_evidence_id) ?? null,
          current,
          tombstoned_at: tombstonedAt,
        });
      }
    }
  }

  // Every lineage MUST have EXACTLY ONE current head (dictionary §5). The partial
  // UNIQUE index `idx_claim_evidence_current_head` enforces AT MOST one; it cannot
  // enforce AT LEAST one, so a tombstoned-only lineage (all rows current: false)
  // would slip past the index. Reject it here, inside the rebuild transaction, so
  // the whole rebuild rolls back and the prior projection survives.
  const badLineages = db
    .prepare(
      `SELECT lineage_id, SUM(current) AS heads
         FROM claim_evidence
        GROUP BY lineage_id
       HAVING heads <> 1
        ORDER BY lineage_id`,
    )
    .all() as { lineage_id: string; heads: number }[];
  if (badLineages.length > 0) {
    const bad = badLineages[0]!;
    throw new MalformedClaimError(
      `lineage:${bad.lineage_id}`,
      `evidence lineage "${bad.lineage_id}" has ${bad.heads} current head(s), expected exactly one ` +
        `(a lineage must retain one current head — a tombstoned-only lineage is invalid)`,
    );
  }
}

/**
 * Clear the claims projection at the START of the rebuild transaction (registered
 * as a pre-clear). Guarded so a DB without `0004_claims` is a no-op. Runs before
 * `ProjectionRepo.clearAll()` deletes `notes` (cascade → `claims` →
 * `claim_evidence`) and before the provenance fold deletes `source_renditions`, so
 * `claim_evidence`'s self-`RESTRICT` supersession FK and its `RESTRICT` FK onto
 * `source_renditions` cannot abort a rebuild of a claim carrying a supersession
 * chain.
 */
export function clearClaimsProjection(db: SqliteDatabase): void {
  if (!ClaimsRepo.isApplied(db)) return;
  new ClaimsRepo(db).clearAll();
}

/** Register the claims fold + pre-clear into the rebuild pipeline (idempotent). */
registerProjectionFold(foldClaimManifests);
registerPreClear(clearClaimsProjection);

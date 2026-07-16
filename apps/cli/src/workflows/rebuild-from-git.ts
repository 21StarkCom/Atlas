/**
 * `workflows/rebuild-from-git` — the DR rebuild-from-git fold (Task 4.11). When SQLite AND its
 * backups are lost, the projection is reconstructed from the canonical git state (Markdown is the
 * SSOT), and every fact git CANNOT reconstruct is surfaced as a GAP — never silently dropped.
 *
 * Two classes of state (design §"Two classes of state"):
 *  - **Projection state** (notes, links, identity keys, claims, provenance) IS derivable from the
 *    committed Markdown — `rebuildProjections` reproduces it.
 *  - **Ledger/audit state** (run history, the signed audit chain, caller-idempotency) lives on
 *    `refs/audit/runs` + the SQLite ledger, NOT in canonical Markdown — it is recoverable only
 *    from the audit ref / a backup, so it is reported as a gap (best-effort, fail-loud).
 *
 * Fail-loud, never fail-silent: a tampered/unparseable vault file or a dangling link becomes a
 * named gap and the CLEAN subset is still rebuilt — a partial history can never masquerade as a
 * complete one.
 */
import type { VaultSnapshot } from "@atlas/contracts";
import { rebuildProjections, DanglingLinkError, type SqliteDatabase } from "@atlas/sqlite-store";

/** A fact the from-git rebuild could not reconstruct (surfaced, never dropped). */
export interface FromGitGap {
  readonly storageClass: string;
  readonly reason: string;
  readonly detail?: string;
}

/** The DR rebuild report: what was rebuilt from Markdown + every surfaced gap. */
export interface FromGitReport {
  readonly rebuilt: { readonly notes: number; readonly links: number; readonly identityKeys: number };
  readonly gaps: readonly FromGitGap[];
  /** `true` iff NO gap requires operator attention beyond the always-present ledger classes. */
  readonly clean: boolean;
}

/** The ledger/audit classes that are never derivable from canonical Markdown (always reported). */
const LEDGER_GAPS: readonly FromGitGap[] = [
  { storageClass: "agent_runs", reason: "run history is ledger/audit-ref state, not derivable from canonical Markdown — recover best-effort from refs/audit/runs" },
  { storageClass: "audit_events", reason: "the signed audit chain lives on refs/audit/runs, not canonical Markdown" },
  { storageClass: "workflow_idempotency", reason: "caller-idempotency is ledger-only, not reconstructible from git" },
];

/**
 * Rebuild the projection from the canonical vault `snapshot` (the committed git state), surfacing
 * every gap. Vault read errors and dangling links become named gaps; the clean note subset is
 * still rebuilt (best-effort). The three ledger/audit classes are always reported as gaps (they
 * require the audit ref / a backup). `clean` is true only when the sole gaps are those ledger
 * classes (no data-loss gap from the vault itself).
 */
export function rebuildFromGit(db: SqliteDatabase, snapshot: VaultSnapshot): FromGitReport {
  const gaps: FromGitGap[] = [];

  // Vault read/parse errors are gaps — a tampered/unreadable file is never silently skipped.
  for (const e of snapshot.errors) {
    gaps.push({ storageClass: "notes", reason: "vault file could not be read/parsed (tampered/partial history)", detail: `${e.path}: ${e.kind}` });
  }

  // Rebuild the CLEAN subset (drop only the errored files, which are recorded as gaps above).
  const clean: VaultSnapshot = { notes: snapshot.notes, errors: [] };
  let rebuilt = { notes: 0, links: 0, identityKeys: 0 };
  try {
    const r = rebuildProjections(db, clean);
    rebuilt = { notes: r.notes, links: r.links, identityKeys: r.identityKeys };
  } catch (e) {
    if (e instanceof DanglingLinkError) {
      gaps.push({ storageClass: "note_links", reason: "a link names a target absent from the rebuilt notes (dangling)", detail: e.message });
    } else {
      throw e; // an identity ambiguity / unexpected fold error is not a recoverable gap
    }
  }

  const vaultGaps = gaps.length; // gaps found BEFORE appending the always-present ledger classes
  gaps.push(...LEDGER_GAPS);
  return { rebuilt, gaps, clean: vaultGaps === 0 };
}

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
import type { ParsedNote, VaultSnapshot } from "@atlas/contracts";
import { rebuildProjections, DanglingLinkError, noteIdentityKeys, type SqliteDatabase } from "@atlas/sqlite-store";

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

/**
 * Partition `notes` into the survivors that carry NO cross-note id/identity-key
 * collision and the gaps for every note that does (#147). A note is dropped if
 * either (a) its `note_id` is shared by another note (`notes` PK), or (b) any of
 * its normalized identity keys — slug + aliases, per {@link noteIdentityKeys} — is
 * claimed by another note (`note_identity_keys` PK). Both members of a colliding
 * pair are dropped: with each individually valid, git alone cannot say which is
 * canonical, so neither is silently kept. Deterministic (input order preserved).
 */
function dropIdentityCollisions(notes: readonly ParsedNote[]): {
  survivors: ParsedNote[];
  collisionGaps: FromGitGap[];
} {
  const idOwners = new Map<string, string[]>(); // note_id → [paths claiming it]
  const keyOwners = new Map<string, string[]>(); // normalized identity key → [paths claiming it]
  const push = (m: Map<string, string[]>, k: string, path: string): void => {
    const list = m.get(k);
    if (list === undefined) m.set(k, [path]);
    else list.push(path);
  };
  for (const n of notes) {
    push(idOwners, n.id, n.path);
    for (const key of noteIdentityKeys(n)) push(keyOwners, key, n.path);
  }

  const survivors: ParsedNote[] = [];
  const collisionGaps: FromGitGap[] = [];
  for (const n of notes) {
    const idPeers = (idOwners.get(n.id) ?? []).filter((p) => p !== n.path);
    if (idPeers.length > 0) {
      collisionGaps.push({ storageClass: "notes", reason: "duplicate note id — pairwise identity collision (each note valid alone; git cannot pick the canonical one)", detail: `${n.path}: note id \`${n.id}\` also claimed by ${idPeers.join(", ")}` });
      continue;
    }
    const collidingKey = noteIdentityKeys(n).find((key) => (keyOwners.get(key) ?? []).some((p) => p !== n.path));
    if (collidingKey !== undefined) {
      const keyPeers = (keyOwners.get(collidingKey) ?? []).filter((p) => p !== n.path);
      collisionGaps.push({ storageClass: "note_identity_keys", reason: "identity-key collision — pairwise conflict (each note valid alone; git cannot pick the canonical one)", detail: `${n.path}: normalized key \`${collidingKey}\` also claimed by ${keyPeers.join(", ")}` });
      continue;
    }
    survivors.push(n);
  }
  return { survivors, collisionGaps };
}

/** The operational classes that are never derivable from canonical Markdown (always reported).
 * v2 (#338): the audit ledger is retired — `agent_runs` is a plain operational table (run
 * history, still not in Markdown) and `workflow_idempotency` is caller-idempotency state. */
const LEDGER_GAPS: readonly FromGitGap[] = [
  { storageClass: "agent_runs", reason: "run history is operational state, not derivable from canonical Markdown" },
  { storageClass: "workflow_idempotency", reason: "caller-idempotency is operational-only, not reconstructible from git" },
];

/**
 * Rebuild the projection from the canonical vault `snapshot` (the committed git state), surfacing
 * every gap. Vault read errors and dangling links become named gaps; the clean note subset is
 * still rebuilt (best-effort). The operational classes ({@link LEDGER_GAPS}) are always reported
 * as gaps (they are not derivable from Markdown). `clean` is true only when the sole gaps are
 * those operational classes (no data-loss gap from the vault itself).
 */
export function rebuildFromGit(db: SqliteDatabase, snapshot: VaultSnapshot): FromGitReport {
  const gaps: FromGitGap[] = [];

  // Vault read/parse errors are gaps — a tampered/unreadable file is never silently skipped.
  for (const e of snapshot.errors) {
    gaps.push({ storageClass: "notes", reason: "vault file could not be read/parsed (tampered/partial history)", detail: `${e.path}: ${e.kind}` });
  }

  // Cross-note identity collisions (#147). `note_identity_keys.normalized_key` and
  // `notes.note_id` are global PKs, but every note here individually parsed cleanly —
  // the conflict is PAIRWISE (two notes claiming the same id or normalized key, e.g.
  // template stubs both asserting the literal `<slug>`). `rebuildProjections` is
  // strict all-or-nothing, so a raw PK violation would abort the entire DR rebuild.
  // Best-effort instead: drop EVERY note involved in a collision as a gap and rebuild
  // the survivors. (A per-note dangling link to a dropped note is then handled by the
  // DanglingLinkError path below.)
  const { survivors, collisionGaps } = dropIdentityCollisions(snapshot.notes);
  gaps.push(...collisionGaps);

  // Rebuild the CLEAN subset (errored files + collision offenders already recorded as gaps).
  const clean: VaultSnapshot = { notes: survivors, errors: [] };
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

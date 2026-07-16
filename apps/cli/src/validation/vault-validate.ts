/**
 * `validation/vault-validate` — the deterministic read-only vault validator behind
 * `brain validate` (Task 4.11 / 4.4). It audits a {@link VaultSnapshot} for the structural
 * invariants the projection depends on — parse/schema errors, dangling wiki-link references, and
 * identity-key collisions (duplicate id/slug/alias) — and reports typed findings + the Tier-2
 * eligibility gate. Read-only: it never mutates the vault or the projection.
 */
import { normalizeIdentityKey, type VaultSnapshot } from "@atlas/contracts";

/** A validation finding (codes + severity are the `validate.schema.json` enums). */
export interface VaultFinding {
  readonly code: "schema-invalid" | "identity-collision" | "dangling-reference";
  readonly severity: "error" | "warning";
  readonly message: string;
  /** The note the finding concerns (used for scoping; not emitted in the finding itself). */
  readonly note?: string;
}

/** The vault-validation report (mirrors `validate.schema.json`). */
export interface VaultValidationReport {
  readonly ok: boolean;
  readonly findings: readonly VaultFinding[];
  readonly gates: { readonly tier2Eligible: boolean; readonly modelConfidence: number; readonly validationConfidence: number };
}

/**
 * Validate `snapshot` (optionally scoped to `noteId`). Reports parse/schema errors, dangling
 * wiki-link targets, and identity-key collisions. `ok` iff no error finding; the gate mirrors it
 * (a vault audit involves no model, so `modelConfidence` is 1; `validationConfidence` is 1 iff ok).
 */
export function validateVault(snapshot: VaultSnapshot, noteId?: string): VaultValidationReport {
  const findings: VaultFinding[] = [];

  // Parse/read errors surfaced by the reader are schema-invalid findings.
  for (const e of snapshot.errors) {
    findings.push({ code: "schema-invalid", severity: "error", message: `${e.path}: ${e.kind}`, note: e.path });
  }

  // Build the identity-key → owning-note index; a key claimed by >1 note is a collision.
  const owners = new Map<string, string[]>();
  const claim = (key: string, note: string): void => {
    const norm = normalizeIdentityKey(key);
    const list = owners.get(norm) ?? [];
    if (!list.includes(note)) list.push(note);
    owners.set(norm, list);
  };
  const noteIds = new Set<string>();
  for (const n of snapshot.notes) {
    noteIds.add(n.id);
    claim(n.id, n.id);
    for (const a of n.aliases) claim(a, n.id);
  }
  for (const [key, ns] of owners) {
    if (ns.length > 1) {
      findings.push({ code: "identity-collision", severity: "error", message: `identity key "${key}" is claimed by ${ns.length} notes: ${ns.sort().join(", ")}` });
    }
  }

  // Dangling references: a wiki-link whose target resolves to no note id/alias.
  const resolvable = new Set<string>();
  for (const n of snapshot.notes) {
    resolvable.add(normalizeIdentityKey(n.id));
    for (const a of n.aliases) resolvable.add(normalizeIdentityKey(a));
  }
  for (const n of snapshot.notes) {
    for (const link of n.links) {
      if (!resolvable.has(normalizeIdentityKey(link.target))) {
        findings.push({ code: "dangling-reference", severity: "error", message: `note "${n.id}" links to "${link.target}", which resolves to no note`, note: n.id });
      }
    }
  }
  void noteIds;

  const scoped = noteId === undefined ? findings : findings.filter((f) => f.note === noteId);
  const ok = !scoped.some((f) => f.severity === "error");
  return { ok, findings: scoped, gates: { tier2Eligible: ok, modelConfidence: 1, validationConfidence: ok ? 1 : 0 } };
}

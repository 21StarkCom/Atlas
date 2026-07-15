/**
 * `evidence` (Task 4.6) — the claim/evidence op executors serialize into the owning
 * note's canonical `claims:` block, and `rebuildProjections` re-derives the `claims` +
 * `claim_evidence` rows from that Markdown alone (Markdown is the SSOT for verification;
 * SQLite only mirrors it). Evidence pins the concrete rendition components, never the
 * mutable sourceId alias. The verification lifecycle (attach → re-anchor/supersede) is
 * driven ONLY through the ChangePlan op path — there is no bare projection write.
 */
import { describe, expect, it } from "vitest";
import type { ParsedNote, VaultSnapshot } from "@atlas/contracts";
import { openStore, rebuildProjections, type Store } from "@atlas/sqlite-store";
import { buildSectionTree } from "../src/markdown/sections.js";
import { splitFrontmatter } from "../src/markdown/parse.js";
import { executeCreateClaim } from "../src/workflows/ops/claims.js";
import { executeAttachEvidence, executeUpdateEvidenceVerification } from "../src/workflows/ops/evidence.js";
import { OpExecutionError, type OpContext } from "../src/workflows/ops/index.js";

const HEX_A = "a".repeat(64);
const HEX_B = "b".repeat(64);
const CONTENT_A = `sha256:${HEX_A}:text/plain`;
const REND_A_11 = `sha256:${HEX_A}:text/plain:1:1`;
const REND_A_21 = `sha256:${HEX_A}:text/plain:2:1`;
const NOW = "2026-07-16T00:00:00.000Z";

function makeNote(raw: string, over: Partial<ParsedNote> = {}): ParsedNote {
  const { body } = splitFrontmatter(raw);
  const id = /id:\s*(\S+)/.exec(raw)?.[1] ?? "n";
  return {
    id, path: `${id}.md`, type: "concept", schemaVersion: 1, title: id, status: "active",
    created: "2026-07-11", updated: "2026-07-11", aliases: [], sources: [], declaredSensitivity: "internal",
    links: [], sections: buildSectionTree(body), contentHash: "sha256:0", raw, ...over,
  };
}

/** A source-manifest note whose provenance fold reconstructs rendition 1:1 (and 2:1) of blob A. */
function sourceNote(): ParsedNote {
  const raw = [
    "---", "id: s-a", "type: source", "schema_version: 1", "title: s-a",
    "created: 2026-07-11", "updated: 2026-07-11",
    `contentId: "${CONTENT_A}"`, "origin: notes/a.txt", "provenance:",
    "  vault_path: sources/a.txt", "  size_bytes: 12", "  renditions:",
    `    - { extractor_version: 1, normalizer_version: 1, normalized_content_hash: "${HEX_B}", size_bytes: 10, locator_scheme: char }`,
    `    - { extractor_version: 2, normalizer_version: 1, normalized_content_hash: "${HEX_B}", size_bytes: 10, locator_scheme: char }`,
    "---", "", "# s-a", "",
  ].join("\n");
  return makeNote(raw, { type: "source", id: "s-a", path: "sources/s-a.md" });
}

const TARGET_RAW = ["---", "id: note-a", "type: concept", "schema_version: 1", "title: Alpha",
  "created: 2026-07-11", "updated: 2026-07-11", "---", "", "# Alpha", "Body.", ""].join("\n");

function ctx(note: ParsedNote): OpContext {
  return {
    note,
    // Pinned renditions resolve to themselves; a contentId resolves to the active 1:1.
    resolveRendition: (h) => (h === CONTENT_A ? REND_A_11 : h),
    hasClaim: () => false,
    hasNote: () => true,
    now: NOW,
  };
}

function snap(notes: ParsedNote[]): VaultSnapshot {
  return { notes, errors: [] };
}

function claimsStore(): Store {
  const store = openStore({ path: ":memory:" });
  store.migrate();
  return store;
}

describe("claims/evidence op executors (Task 4.6)", () => {
  it("CreateClaim → claims block that rebuilds into the claim + pinned-rendition evidence", () => {
    const out = executeCreateClaim(
      { op: "CreateClaim", opVersion: 1, claimKey: "claim/x", claimText: "Alpha launched.", provenance: [CONTENT_A] },
      ctx(makeNote(TARGET_RAW)),
    );
    const store = claimsStore();
    try {
      rebuildProjections(store.db, snap([sourceNote(), makeNote(out.nextText, { id: "note-a", path: "note-a.md" })]));
      const claim = store.db.prepare(`SELECT claim_id, owning_note_id, text, status FROM claims WHERE claim_id = ?`).get("claim/x") as { claim_id: string; owning_note_id: string; text: string; status: string };
      expect(claim).toMatchObject({ claim_id: "claim/x", owning_note_id: "note-a", text: "Alpha launched.", status: "active" });
      // Evidence pins the concrete rendition COMPONENTS (never the contentId alias).
      const ev = store.db.prepare(`SELECT raw_content_hash, canonical_media_type, extractor_version, normalizer_version, verification FROM claim_evidence`).all() as Record<string, unknown>[];
      expect(ev).toHaveLength(1);
      expect(ev[0]).toMatchObject({ raw_content_hash: HEX_A, canonical_media_type: "text/plain", extractor_version: 1, normalizer_version: 1, verification: "pending" });
    } finally {
      store.close();
    }
  });

  it("AttachEvidence valid (with anchor) rebuilds as valid + persists locator/quoteHash", () => {
    let note = makeNote(TARGET_RAW);
    note = makeNote(executeCreateClaim({ op: "CreateClaim", opVersion: 1, claimKey: "claim/x", claimText: "Alpha.", provenance: [REND_A_11] }, ctx(note)).nextText, { id: "note-a", path: "note-a.md" });
    const out = executeAttachEvidence(
      { op: "AttachEvidence", opVersion: 1, claimKey: "claim/x", renditionId: REND_A_11, locator: "char:0-5", quoteHash: HEX_B, verification: "valid" },
      ctx(note),
    );
    const store = claimsStore();
    try {
      rebuildProjections(store.db, snap([sourceNote(), makeNote(out.nextText, { id: "note-a", path: "note-a.md" })]));
      const rows = store.db.prepare(`SELECT locator, quote_hash, verification FROM claim_evidence WHERE verification = 'valid'`).all() as Record<string, unknown>[];
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ locator: "char:0-5", quote_hash: HEX_B, verification: "valid" });
    } finally {
      store.close();
    }
  });

  it("UpdateEvidenceVerification re-anchors: prior head tombstoned, one current head on the lineage", () => {
    // Build a claim with a single current head on rendition 1:1 (from CreateClaim).
    let note = makeNote(TARGET_RAW);
    note = makeNote(executeCreateClaim({ op: "CreateClaim", opVersion: 1, claimKey: "claim/x", claimText: "Alpha.", provenance: [REND_A_11] }, ctx(note)).nextText, { id: "note-a", path: "note-a.md" });
    const out = executeUpdateEvidenceVerification(
      { op: "UpdateEvidenceVerification", opVersion: 1, claimKey: "claim/x", lineageId: "lin-1", supersedesEvidenceId: "ev-old", expectedSupersededRenditionId: REND_A_11, toVerification: "valid", replacementRenditionId: REND_A_21, locator: "char:0-5", quoteHash: HEX_B },
      ctx(note),
    );
    const store = claimsStore();
    try {
      rebuildProjections(store.db, snap([sourceNote(), makeNote(out.nextText, { id: "note-a", path: "note-a.md" })]));
      // Exactly one CURRENT head, pinned to the replacement rendition 2:1.
      const heads = store.db.prepare(`SELECT extractor_version, current FROM claim_evidence WHERE current = 1`).all() as Record<string, unknown>[];
      expect(heads).toHaveLength(1);
      expect(heads[0]).toMatchObject({ extractor_version: 2 });
      // The prior head is retained but tombstoned.
      const tomb = store.db.prepare(`SELECT COUNT(*) AS n FROM claim_evidence WHERE current = 0 AND tombstoned_at IS NOT NULL`).get() as { n: number };
      expect(tomb.n).toBe(1);
    } finally {
      store.close();
    }
  });

  it("rejects a duplicate claim (claim-exists) and unresolved provenance", () => {
    expect(() =>
      executeCreateClaim({ op: "CreateClaim", opVersion: 1, claimKey: "claim/x", claimText: "x", provenance: [REND_A_11] }, { ...ctx(makeNote(TARGET_RAW)), hasClaim: () => true }),
    ).toThrow(OpExecutionError);
    expect(() =>
      executeCreateClaim({ op: "CreateClaim", opVersion: 1, claimKey: "claim/y", claimText: "x", provenance: ["sha256:" + "c".repeat(64) + ":text/plain:1:1"] }, { ...ctx(makeNote(TARGET_RAW)), resolveRendition: () => null }),
    ).toThrow(/no captured rendition/);
  });
});

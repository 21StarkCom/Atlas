/**
 * `evidence-reverification` (Task 4.7) — a rendition bump enqueues ONE re-verification
 * job per owning note (non-colliding, idempotent), transitionally marks the affected
 * valid heads `stale`, and the re-anchor classifier yields the three staleness-protocol
 * outcomes (exact ⇒ valid, ambiguous/moved ⇒ pending + Tier-3, not-found ⇒ failed).
 */
import { describe, expect, it } from "vitest";
import type { ParsedNote, VaultSnapshot } from "@atlas/contracts";
import { openStore, rebuildProjections, type Store } from "@atlas/sqlite-store";
import { bindEnqueueContext, productionEnqueueContext, registerJobsMigration, jobIdsInStates } from "@atlas/jobs";
import { buildSectionTree } from "../src/markdown/sections.js";
import { splitFrontmatter } from "../src/markdown/parse.js";
import { enqueueReverification, classifyReanchor, type RenditionBump } from "../src/workflows/reverify.js";

const HEX_A = "a".repeat(64);
const HEX_B = "b".repeat(64);
const CONTENT_A = `sha256:${HEX_A}:text/plain`;
const REND_A_21 = `sha256:${HEX_A}:text/plain:2:1`;

function makeNote(raw: string, over: Partial<ParsedNote> = {}): ParsedNote {
  const { body } = splitFrontmatter(raw);
  const id = /id:\s*(\S+)/.exec(raw)?.[1] ?? "n";
  return {
    id, path: `${id}.md`, type: "concept", schemaVersion: 1, title: id, status: "active",
    created: "2026-07-11", updated: "2026-07-11", aliases: [], sources: [], declaredSensitivity: "internal",
    links: [], sections: buildSectionTree(body), contentHash: "sha256:0", raw, ...over,
  };
}

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

/** A note owning one claim with a VALID evidence head pinned to rendition 1:1. */
function claimNote(noteId: string, claimId: string): ParsedNote {
  const raw = [
    "---", `id: ${noteId}`, "type: concept", "schema_version: 1", `title: ${noteId}`,
    "created: 2026-07-11", "updated: 2026-07-11", "claims:",
    `  - claim_id: ${claimId}`, `    text: "Claim ${claimId}."`, "    evidence:",
    `      - rendition: "${CONTENT_A}:1:1"`, "        locator: \"char:0-5\"", `        quote_hash: "${HEX_B}"`, "        verification: valid",
    "---", "", `# ${noteId}`, "",
  ].join("\n");
  return makeNote(raw, { id: noteId, path: `${noteId}.md` });
}

function snap(notes: ParsedNote[]): VaultSnapshot {
  return { notes, errors: [] };
}

function store(): Store {
  const s = openStore({ path: ":memory:" });
  registerJobsMigration(s);
  s.migrate();
  let n = 0;
  bindEnqueueContext(s.db, productionEnqueueContext({ nextJobId: () => `job-${n++}`, now: () => "2026-07-16T00:00:00.000Z" }));
  return s;
}

const BUMP: RenditionBump = {
  contentId: { rawContentHash: HEX_A, canonicalMediaType: "text/plain" },
  previous: { extractorVersion: 1, normalizerVersion: 1 },
  newRenditionId: REND_A_21,
};

describe("rendition-bump re-verification (Task 4.7)", () => {
  it("enqueues one non-colliding job per owning note and marks affected valid heads stale", () => {
    const s = store();
    try {
      rebuildProjections(s.db, snap([sourceNote(), claimNote("note-a", "claim-a"), claimNote("note-b", "claim-b")]));
      const jobs = enqueueReverification(s.db, BUMP);
      expect(jobs).toHaveLength(2); // N=2 owning notes
      expect(new Set(jobs).size).toBe(2); // non-colliding
      expect(jobIdsInStates(s.db, ["pending"]).sort()).toEqual(jobs.slice().sort());
      // The affected valid heads are now transitionally stale (blocks Tier-2 grounding).
      const stale = s.db.prepare(`SELECT COUNT(*) AS n FROM claim_evidence WHERE verification = 'stale' AND current = 1`).get() as { n: number };
      expect(stale.n).toBe(2);
    } finally {
      s.close();
    }
  });

  it("is idempotent: a repeat bump returns the same job ids and creates no duplicates", () => {
    const s = store();
    try {
      rebuildProjections(s.db, snap([sourceNote(), claimNote("note-a", "claim-a")]));
      const first = enqueueReverification(s.db, BUMP);
      const second = enqueueReverification(s.db, BUMP);
      expect(second).toEqual(first);
      expect(jobIdsInStates(s.db, ["pending"])).toHaveLength(1);
    } finally {
      s.close();
    }
  });

  it("classifies re-anchor outcomes: exact ⇒ valid, everything else ⇒ failed (v2 #335: no Tier-3 pending park)", () => {
    expect(classifyReanchor("exact")).toEqual({ verification: "valid" });
    expect(classifyReanchor("ambiguous")).toEqual({ verification: "failed" });
    expect(classifyReanchor("moved")).toEqual({ verification: "failed" });
    expect(classifyReanchor("not-found")).toEqual({ verification: "failed" });
  });
});

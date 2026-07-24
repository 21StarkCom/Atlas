/**
 * `evidence-fold` — the v2 vault-derived `evidence` projection folds from note
 * frontmatter (Phase-4 task 4-4), on both the whole-vault rebuild and the
 * incremental folds, with REPLACE semantics + a fold-stamped `sourceNoteHash`.
 */
import { describe, expect, it } from "vitest";
import { openStore, EvidenceRepo, foldNotesV2, foldNotesForPaths } from "../src/index.js";
import { EvidenceFoldError } from "../src/evidence/fold.js";
import { makeNote, snapshot } from "./helpers.js";
import type { ParsedNote } from "@atlas/contracts";

/** A note whose raw frontmatter carries an `evidence:` block (+ a distinct contentHash). */
function noteWithEvidence(id: string, contentHash: string, evidenceYaml: string): ParsedNote {
  const raw = `---\nid: ${id}\ntitle: ${id}\n${evidenceYaml}\n---\n\n# ${id}\n\nbody\n`;
  return makeNote({ id, path: `${id}.md`, raw, contentHash });
}

function open() {
  const store = openStore({ path: ":memory:" });
  store.migrate();
  return store;
}

describe("evidence-fold (v2 vault-derived projection)", () => {
  it("rebuildProjections folds evidence rows from a note's frontmatter, stamping sourceNoteHash", () => {
    const store = open();
    try {
      const hash = "a".repeat(64);
      const note = noteWithEvidence(
        "n-1",
        hash,
        [
          "evidence:",
          "  - id: ev-1",
          "    claim: Meridian launched in 2025.",
          "    citation: sources/launch.md",
          "    status: pending",
          "    sectionPath: Overview",
          "  - id: ev-2",
          "    claim: Budget was approved.",
          "    status: resolved",
          "    verdict: verified",
          "    attempts: 2",
        ].join("\n"),
      );
      store.rebuildProjections(snapshot([note]));

      const rows = new EvidenceRepo(store.db).forNote("n-1");
      expect(rows.map((r) => r.id)).toEqual(["ev-1", "ev-2"]);
      const ev1 = rows.find((r) => r.id === "ev-1")!;
      expect(ev1).toMatchObject({
        noteId: "n-1",
        sectionPath: "Overview",
        claim: "Meridian launched in 2025.",
        citation: "sources/launch.md",
        status: "pending",
        verdict: null,
        attempts: 0,
        sourceNoteHash: hash, // stamped from the note's content hash at fold time
      });
      const ev2 = rows.find((r) => r.id === "ev-2")!;
      expect(ev2).toMatchObject({ status: "resolved", verdict: "verified", attempts: 2 });
    } finally {
      store.close();
    }
  });

  it("REPLACE semantics: a re-fold with an entry removed drops the vanished row (rebuild)", () => {
    const store = open();
    try {
      const two = noteWithEvidence("n-1", "b".repeat(64), "evidence:\n  - id: ev-a\n    claim: A\n  - id: ev-b\n    claim: B");
      store.rebuildProjections(snapshot([two]));
      expect(new EvidenceRepo(store.db).forNote("n-1").map((r) => r.id)).toEqual(["ev-a", "ev-b"]);

      const one = noteWithEvidence("n-1", "c".repeat(64), "evidence:\n  - id: ev-a\n    claim: A");
      store.rebuildProjections(snapshot([one]));
      const rows = new EvidenceRepo(store.db).forNote("n-1");
      expect(rows.map((r) => r.id)).toEqual(["ev-a"]);
      expect(rows[0]!.sourceNoteHash).toBe("c".repeat(64)); // re-stamped
    } finally {
      store.close();
    }
  });

  it("a note with no `evidence:` block folds no rows", () => {
    const store = open();
    try {
      store.rebuildProjections(snapshot([makeNote({ id: "n-1", path: "n-1.md", raw: "---\nid: n-1\n---\n\nbody" })]));
      expect(new EvidenceRepo(store.db).all()).toEqual([]);
    } finally {
      store.close();
    }
  });

  it("the incremental foldNotesV2 folds + re-folds a note's evidence from frontmatter", () => {
    const store = open();
    try {
      const note = noteWithEvidence("n-1", "d".repeat(64), "evidence:\n  - id: ev-x\n    claim: X\n    status: failed");
      // Seed the note row first (foldNotesV2 needs a resolvable note).
      store.rebuildProjections(snapshot([note]));
      // Re-fold incrementally with an edited frontmatter (status flip + new hash).
      const edited = noteWithEvidence("n-1", "e".repeat(64), "evidence:\n  - id: ev-x\n    claim: X\n    status: needs-review");
      foldNotesV2(store, ["n-1"], () => edited);
      const rows = new EvidenceRepo(store.db).forNote("n-1");
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ id: "ev-x", status: "needs-review", sourceNoteHash: "e".repeat(64) });
    } finally {
      store.close();
    }
  });

  it("foldNotesForPaths folds evidence too (the link/enrich refresh path)", () => {
    const store = open();
    try {
      const note = noteWithEvidence("n-1", "f".repeat(64), "evidence:\n  - id: ev-y\n    claim: Y");
      foldNotesForPaths(store, ["n-1"], () => note);
      expect(new EvidenceRepo(store.db).forNote("n-1").map((r) => r.id)).toEqual(["ev-y"]);
    } finally {
      store.close();
    }
  });

  it("a malformed evidence block (missing id) throws EvidenceFoldError and rolls the rebuild back", () => {
    const store = open();
    try {
      const good = noteWithEvidence("n-1", "1".repeat(64), "evidence:\n  - id: ev-keep\n    claim: keep");
      store.rebuildProjections(snapshot([good]));
      const bad = noteWithEvidence("n-1", "2".repeat(64), "evidence:\n  - claim: no id here");
      expect(() => store.rebuildProjections(snapshot([bad]))).toThrow(EvidenceFoldError);
      // Fail-closed: the prior projection survives.
      expect(new EvidenceRepo(store.db).forNote("n-1").map((r) => r.id)).toEqual(["ev-keep"]);
    } finally {
      store.close();
    }
  });

  it("an out-of-enum status is rejected (fail-closed)", () => {
    const store = open();
    try {
      const bad = noteWithEvidence("n-1", "3".repeat(64), "evidence:\n  - id: ev-1\n    status: bogus");
      expect(() => store.rebuildProjections(snapshot([bad]))).toThrow(EvidenceFoldError);
    } finally {
      store.close();
    }
  });
});

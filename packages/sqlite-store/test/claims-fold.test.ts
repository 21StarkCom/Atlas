/**
 * `claims-fold` — `foldClaimManifests` reconstructs the `claims` + `claim_evidence`
 * projections from canonical Markdown `claims:` blocks, and a `db rebuild` on the
 * committed `conflicting-claims` fixture reproduces the claim rows from the
 * manifests alone with the retained PR-A migrations applied (acceptance
 * §Acceptance-Criteria: a claims-bearing vault rebuilds losslessly).
 *
 * The evidence idempotency guard is asserted under sentinel encoding: two
 * attaches that both omit `locator`/`quote_hash` collapse to ONE row (the
 * `(none)` sentinel feeds `payload_hash`, so NULL-distinctness can never bypass
 * the UNIQUE index — plan Review-Hint). The fold is fail-closed: a malformed
 * `claims:` block or a dangling evidence rendition rolls the rebuild back and
 * preserves the prior projection.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parse as parseYaml } from "yaml";
import type { NoteType, ParsedNote, VaultSnapshot } from "@atlas/contracts";
import {
  openStore,
  payloadHash,
  evidenceIdFor,
  SENTINEL_NONE,
  MalformedClaimError,
  DanglingEvidenceError,
} from "../src/index.js";
import type { Store } from "../src/index.js";
import { makeNote, REPO_ROOT } from "./helpers.js";

const HEX_A = "a".repeat(64);
const HEX_B = "b".repeat(64);
const CONTENT_A = `sha256:${HEX_A}:text/plain`;
const REND_A_11 = `sha256:${HEX_A}:text/plain:1:1`;

/** Open a store and apply the retained PR-A migrations via the PUBLIC path. */
function claimsStore(): Store {
  const store = openStore({ path: ":memory:" });
  const report = store.migrate();
  expect(new Set(report.newlyApplied)).toEqual(
    new Set(["0001_core", "0003_provenance", "0004_claims"]),
  );
  return store;
}

function snap(notes: ParsedNote[]): VaultSnapshot {
  return { notes, errors: [] };
}

/** A note carrying an arbitrary frontmatter body (id/type/created boilerplate + `extra`). */
function fmNote(id: string, path: string, extra: string, over: Partial<ParsedNote> = {}): ParsedNote {
  const raw = `---\nid: ${id}\ntype: concept\nschema_version: 1\ntitle: ${id}\ncreated: 2026-07-11\nupdated: 2026-07-11\n${extra}\n---\n\n# ${id}\n`;
  return makeNote({ id, path, raw, ...over });
}

/** A source manifest note (provenance) exposing a single 1:1 rendition of blob A. */
function sourceManifestWithRendition(): ParsedNote {
  const extra = [
    `contentId: "${CONTENT_A}"`,
    `origin: notes/a.txt`,
    `provenance:`,
    `  vault_path: sources/a.txt`,
    `  size_bytes: 12`,
    `  renditions:`,
    `    - { extractor_version: 1, normalizer_version: 1, normalized_content_hash: "${HEX_B}", size_bytes: 10, locator_scheme: char }`,
  ].join("\n");
  return fmNote("s-a", "sources/s-a.md", extra, { type: "source" });
}

const CONFLICTING = join(REPO_ROOT, "fixtures", "conflicting-claims");

function scalar(v: unknown): string {
  if (typeof v === "string") return v;
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  return String(v);
}

/** Build a `ParsedNote` from a COMMITTED `conflicting-claims` fixture (real manifest path). */
function readFixtureNote(relPath: string): ParsedNote {
  const raw = readFileSync(join(CONFLICTING, relPath), "utf8");
  const m = /^---\r?\n([\s\S]*?)\r?\n---/.exec(raw);
  const fm = (m ? (parseYaml(m[1]!) as Record<string, unknown>) : {}) ?? {};
  return makeNote({
    id: String(fm.id),
    path: relPath,
    type: (fm.type as NoteType) ?? "concept",
    title: scalar(fm.title ?? fm.id),
    created: scalar(fm.created ?? "2026-07-11"),
    updated: scalar(fm.updated ?? "2026-07-11"),
    raw,
  });
}

describe("claims-fold", () => {
  it("db rebuild on the COMMITTED conflicting-claims fixture reproduces the claim rows from manifests ALONE", () => {
    const store = claimsStore();
    try {
      const c25 = readFixtureNote("meridian-launch-2025.md");
      const c26 = readFixtureNote("meridian-launch-2026.md");
      store.rebuildProjections(snap([c25, c26]));

      const claims = store.claims.allClaims();
      expect(claims).toEqual([
        {
          claim_id: "claim-meridian-launch-2025",
          owning_note_id: "meridian-launch-2025",
          text: "Project Meridian launched in 2025.",
          status: "active",
          created_at: "2026-07-11T00:00:00Z",
        },
        {
          claim_id: "claim-meridian-launch-2026",
          owning_note_id: "meridian-launch-2026",
          text: "Project Meridian launched in 2026.",
          status: "active",
          created_at: "2026-07-11T00:00:00Z",
        },
      ]);
      // Two conflicting claims coexist as `active` rows (conflict detection is a
      // later phase; the projection is lossless here). No evidence in the fixture.
      expect(store.claims.allEvidence()).toHaveLength(0);
      expect(store.verify().ok).toBe(true);
    } finally {
      store.close();
    }
  });

  it("status defaults to 'active' and created_at defaults to the note's `created`", () => {
    const store = claimsStore();
    try {
      const note = fmNote(
        "n",
        "n.md",
        [`claims:`, `  - claim_id: c-min`, `    text: "minimal claim"`].join("\n"),
      );
      store.rebuildProjections(snap([note]));
      expect(store.claims.allClaims()).toEqual([
        {
          claim_id: "c-min",
          owning_note_id: "n",
          text: "minimal claim",
          status: "active",
          created_at: "2026-07-11",
        },
      ]);
    } finally {
      store.close();
    }
  });

  it("evidence fold: a claim pinning an existing rendition rebuilds to one evidence row", () => {
    const store = claimsStore();
    try {
      const source = sourceManifestWithRendition();
      const claimNote = fmNote(
        "cn",
        "cn.md",
        [
          `claims:`,
          `  - claim_id: c-1`,
          `    text: "cited claim"`,
          `    evidence:`,
          `      - rendition: "${REND_A_11}"`,
          `        locator: "char:1-5"`,
          `        quote_hash: "${HEX_B}"`,
          `        verification: valid`,
        ].join("\n"),
      );
      store.rebuildProjections(snap([source, claimNote]));

      const ev = store.claims.allEvidence();
      expect(ev).toHaveLength(1);
      expect(ev[0]).toMatchObject({
        claim_id: "c-1",
        raw_content_hash: HEX_A,
        canonical_media_type: "text/plain",
        extractor_version: 1,
        normalizer_version: 1,
        locator: "char:1-5",
        quote_hash: HEX_B,
        verification: "valid",
        current: 1,
        tombstoned_at: null,
      });
      // A lineage-founding row: lineage_id == evidence_id.
      expect(ev[0]!.lineage_id).toBe(ev[0]!.evidence_id);
      // evidenceForRendition(contentId) surfaces it.
      expect(
        store.claims.evidenceForRendition({
          kind: "content",
          rawContentHash: HEX_A,
          canonicalMediaType: "text/plain",
        }),
      ).toHaveLength(1);
    } finally {
      store.close();
    }
  });

  it("evidence idempotency under sentinel encoding: absent locator/quoteHash never bypasses uniqueness", () => {
    const store = claimsStore();
    try {
      // Seed a claim + rendition so the composite FK is satisfiable.
      const source = sourceManifestWithRendition();
      const claimNote = fmNote("cn", "cn.md", [`claims:`, `  - claim_id: c-1`, `    text: "t"`].join("\n"));
      store.rebuildProjections(snap([source, claimNote]));

      const rendition = {
        raw_content_hash: HEX_A,
        canonical_media_type: "text/plain",
        extractor_version: 1,
        normalizer_version: 1,
      };

      // Attach with BOTH locator and quote_hash absent — twice.
      const first = store.claims.attachEvidence({ claim_id: "c-1", rendition, created_at: "2026-07-11T00:00:00Z" });
      const second = store.claims.attachEvidence({ claim_id: "c-1", rendition, created_at: "2026-07-11T09:00:00Z" });

      // Idempotent: the second attach resolves to the SAME row (by evidence_id),
      // and only ONE evidence row exists (the sentinel-fed payload_hash matched).
      expect(second.evidence_id).toBe(first.evidence_id);
      expect(store.claims.allEvidence()).toHaveLength(1);
      // Sentinels are stored, never NULL.
      expect(first.locator).toBe(SENTINEL_NONE);
      expect(first.quote_hash).toBe(SENTINEL_NONE);
      // The derived surrogate is a function of the sentinel-encoded payload.
      expect(first.evidence_id).toBe(
        evidenceIdFor(payloadHash("c-1", rendition, SENTINEL_NONE, SENTINEL_NONE)),
      );

      // A DIFFERENT payload (a present locator) is a distinct row — the sentinel
      // does not collapse real values into the absent case.
      const third = store.claims.attachEvidence({
        claim_id: "c-1",
        rendition,
        locator: "char:1-5",
        created_at: "2026-07-11T10:00:00Z",
      });
      expect(third.evidence_id).not.toBe(first.evidence_id);
      expect(store.claims.allEvidence()).toHaveLength(2);
    } finally {
      store.close();
    }
  });

  it("Markdown is SSOT for verification; setEvidenceVerification updates the persisted state", () => {
    const store = claimsStore();
    try {
      const source = sourceManifestWithRendition();
      const claimNote = fmNote("cn", "cn.md", [`claims:`, `  - claim_id: c-1`, `    text: "t"`].join("\n"));
      store.rebuildProjections(snap([source, claimNote]));

      const rendition = {
        raw_content_hash: HEX_A,
        canonical_media_type: "text/plain",
        extractor_version: 1,
        normalizer_version: 1,
      };
      const ev = store.claims.attachEvidence({ claim_id: "c-1", rendition, created_at: "2026-07-11T00:00:00Z" });
      expect(ev.verification).toBe("pending"); // DDL default

      store.claims.setEvidenceVerification(ev.evidence_id, "failed");
      expect(store.claims.allEvidence()[0]!.verification).toBe("failed");
      expect(() => store.claims.setEvidenceVerification("no-such-id", "valid")).toThrow();
    } finally {
      store.close();
    }
  });

  it("rebuild is convergent + lossless (folding the same claims twice yields identical rows)", () => {
    const store = claimsStore();
    try {
      const source = sourceManifestWithRendition();
      const claimNote = fmNote(
        "cn",
        "cn.md",
        [
          `claims:`,
          `  - claim_id: c-1`,
          `    text: "cited claim"`,
          `    evidence:`,
          `      - rendition: "${REND_A_11}"`,
          `        verification: stale`,
        ].join("\n"),
      );
      const notes = [source, claimNote];
      store.rebuildProjections(snap(notes));
      const first = JSON.stringify([store.claims.allClaims(), store.claims.allEvidence()]);
      store.rebuildProjections(snap(notes));
      const second = JSON.stringify([store.claims.allClaims(), store.claims.allEvidence()]);
      expect(second).toEqual(first);
    } finally {
      store.close();
    }
  });

  it("fail-closed: a malformed claims block THROWS and preserves the prior projection", () => {
    const store = claimsStore();
    try {
      const good = fmNote("g", "g.md", [`claims:`, `  - claim_id: c-ok`, `    text: "ok"`].join("\n"));
      store.rebuildProjections(snap([good]));
      expect(store.claims.allClaims()).toHaveLength(1);

      // A claim missing the required `text` → throw, roll back.
      const bad = fmNote("b", "b.md", [`claims:`, `  - claim_id: c-bad`].join("\n"));
      expect(() => store.rebuildProjections(snap([bad]))).toThrow(MalformedClaimError);

      // The prior projection survives (fail-closed rebuild — dictionary §8).
      const claims = store.claims.allClaims();
      expect(claims).toHaveLength(1);
      expect(claims[0]!.claim_id).toBe("c-ok");
    } finally {
      store.close();
    }
  });

  it("supersession chain: predecessor + successor share ONE lineage with exactly one current head, and rebuilds twice", () => {
    const store = claimsStore();
    try {
      const source = sourceManifestWithRendition();
      // Predecessor: explicit evidence_id, tombstoned. Successor: supersedes it
      // with NO explicit lineage_id — it MUST inherit the predecessor's lineage
      // (dictionary §5), not start a fresh one. They pin the same rendition but
      // differ in locator (distinct payload_hash → two rows, not idempotent).
      const claimNote = fmNote(
        "cn",
        "cn.md",
        [
          `claims:`,
          `  - claim_id: c-sup`,
          `    text: "superseded claim"`,
          `    evidence:`,
          `      - rendition: "${REND_A_11}"`,
          `        locator: "char:1-5"`,
          `        evidence_id: ev-pred`,
          `        current: false`,
          `        tombstoned_at: 2026-07-12T00:00:00Z`,
          `      - rendition: "${REND_A_11}"`,
          `        locator: "char:1-9"`,
          `        supersedes_evidence_id: ev-pred`,
        ].join("\n"),
      );
      const notes = [source, claimNote];

      // First rebuild: the chain reconstructs cleanly.
      store.rebuildProjections(snap(notes));
      const ev = store.claims.allEvidence();
      expect(ev).toHaveLength(2);
      // Both rows share ONE lineage (the predecessor's evidence_id) — the
      // successor inherited it despite omitting `lineage_id`.
      expect(new Set(ev.map((e) => e.lineage_id))).toEqual(new Set(["ev-pred"]));
      // Exactly one current head; the predecessor is tombstoned.
      const heads = ev.filter((e) => e.current === 1);
      expect(heads).toHaveLength(1);
      expect(heads[0]!.supersedes_evidence_id).toBe("ev-pred");
      const pred = ev.find((e) => e.evidence_id === "ev-pred")!;
      expect(pred.current).toBe(0);
      expect(pred.tombstoned_at).toBe("2026-07-12T00:00:00Z");

      // Second rebuild MUST succeed: clearing `claim_evidence` (whose successor
      // references the predecessor via the self-`RESTRICT` FK) and the cascade
      // from `notes`/`source_renditions` must not abort. Convergent + lossless.
      const first = JSON.stringify(store.claims.allEvidence());
      store.rebuildProjections(snap(notes));
      expect(JSON.stringify(store.claims.allEvidence())).toEqual(first);
    } finally {
      store.close();
    }
  });

  it("fail-closed: a tombstoned-only lineage (no current head) THROWS and rolls back", () => {
    const store = claimsStore();
    try {
      const good = fmNote("g", "g.md", [`claims:`, `  - claim_id: c-ok`, `    text: "ok"`].join("\n"));
      store.rebuildProjections(snap([good]));

      const source = sourceManifestWithRendition();
      // A single evidence row, tombstoned — the lineage has ZERO current heads,
      // violating the exactly-one-current-head invariant (dictionary §5).
      const bad = fmNote(
        "b",
        "b.md",
        [
          `claims:`,
          `  - claim_id: c-tomb`,
          `    text: "tombstoned only"`,
          `    evidence:`,
          `      - rendition: "${REND_A_11}"`,
          `        current: false`,
          `        tombstoned_at: 2026-07-12T00:00:00Z`,
        ].join("\n"),
      );
      expect(() => store.rebuildProjections(snap([source, bad]))).toThrow(MalformedClaimError);

      // Prior projection intact; no evidence committed.
      expect(store.claims.allClaims().map((c) => c.claim_id)).toEqual(["c-ok"]);
      expect(store.claims.allEvidence()).toHaveLength(0);
    } finally {
      store.close();
    }
  });

  it("fail-closed: `current: true` carrying `tombstoned_at` THROWS (Markdown timestamp never discarded)", () => {
    const store = claimsStore();
    try {
      const good = fmNote("g", "g.md", [`claims:`, `  - claim_id: c-ok`, `    text: "ok"`].join("\n"));
      store.rebuildProjections(snap([good]));

      const source = sourceManifestWithRendition();
      const bad = fmNote(
        "b",
        "b.md",
        [
          `claims:`,
          `  - claim_id: c-bad`,
          `    text: "inconsistent"`,
          `    evidence:`,
          `      - rendition: "${REND_A_11}"`,
          `        current: true`,
          `        tombstoned_at: 2026-07-12T00:00:00Z`,
        ].join("\n"),
      );
      expect(() => store.rebuildProjections(snap([source, bad]))).toThrow(MalformedClaimError);

      // Prior projection intact; the inconsistent row was never normalized in.
      expect(store.claims.allClaims().map((c) => c.claim_id)).toEqual(["c-ok"]);
      expect(store.claims.allEvidence()).toHaveLength(0);
    } finally {
      store.close();
    }
  });

  it("fail-closed: evidence pinning a rendition absent from the snapshot THROWS", () => {
    const store = claimsStore();
    try {
      const good = fmNote("g", "g.md", [`claims:`, `  - claim_id: c-ok`, `    text: "ok"`].join("\n"));
      store.rebuildProjections(snap([good]));

      // A claim whose evidence pins a rendition no source manifest reconstructed.
      const dangling = fmNote(
        "d",
        "d.md",
        [
          `claims:`,
          `  - claim_id: c-d`,
          `    text: "dangling"`,
          `    evidence:`,
          `      - rendition: "${REND_A_11}"`,
        ].join("\n"),
      );
      expect(() => store.rebuildProjections(snap([dangling]))).toThrow(DanglingEvidenceError);

      // Prior projection intact; no evidence committed.
      expect(store.claims.allClaims().map((c) => c.claim_id)).toEqual(["c-ok"]);
      expect(store.claims.allEvidence()).toHaveLength(0);
    } finally {
      store.close();
    }
  });
});

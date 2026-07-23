/**
 * `reverify-recover` (#217) — the production `recoverAnchor` seam: recover the exact
 * quoted span an evidence head recorded, by re-normalizing the owning blob through the
 * REAL `@atlas/sources` sandbox at the new rendition version and hash-verifying the
 * span at its recorded locator range against `quote_hash`.
 *
 * Fail-closed contract (every doubt ⇒ `null` ⇒ the handler routes the head to
 * `pending`/Tier-3, never a fabricated `exact`):
 *   - an offsetless/malformed locator (`page:`/`dom:`/`(none)`) recovers nothing;
 *   - a `newRenditionId` the CURRENT code cannot reproduce (version pair or
 *     normalized-hash mismatch) recovers nothing;
 *   - a blob whose canonical bytes no longer hash to `raw_content_hash` (tamper)
 *     recovers nothing;
 *   - a span whose bytes at the recorded range no longer hash to `quote_hash`
 *     (vanished/shifted quote) recovers nothing;
 *   - a secret detected while re-normalizing quarantines and throws a PERMANENT
 *     (`validation`-classified) failure — never a transient that burns the retry
 *     budget (the #216 bug class).
 *
 * The blob is read from the CANONICAL ref (git), not the working tree — canonical is
 * the SSOT and the working tree may drift (#260).
 */
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// The sandbox worker costs seconds per normalize; the 5s default flakes under
// parallel-suite load (review round-1 finding).
vi.setConfig({ testTimeout: 30_000 });
import { openStore, type Store } from "@atlas/sqlite-store";
import { openRepo, type Repo } from "@atlas/git";
import { normalize } from "@atlas/sources";
import { recoverAnchorFrom, parseLocatorRange, type RecoverAnchorEnv } from "../src/workflows/reverify-recover.js";
import type { EvidenceHeadRow } from "../src/workflows/reverify-handler.js";

// v2 (#334): the sandbox jail + scan guard are retired — re-normalization is an
// in-process pure parse, so these rows run unconditionally.
const describeIfSandbox = describe;

const CANONICAL_REF = "refs/heads/main";
const CONTENT = "# Alpha\n\nThe quick brown fox jumps over the lazy dog.\n";
const NOTE_ID = "src-alpha";
const VAULT_PATH = `sources/${NOTE_ID}.blob`;

const sha256 = (s: string | Uint8Array): string => createHash("sha256").update(s).digest("hex");

let base: string;
let repo: Repo;
let store: Store;

/** Commit `bytes` at the blob's vault path on the canonical ref. */
function commitBlob(bytes: string | Buffer, path = VAULT_PATH): void {
  const abs = join(base, "vault", path);
  mkdirSync(join(base, "vault", "sources"), { recursive: true });
  writeFileSync(abs, bytes);
  execFileSync("git", ["-C", join(base, "vault"), "add", "-A"]);
  execFileSync("git", ["-C", join(base, "vault"), "commit", "-q", "-m", "blob"], {
    env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" },
  });
}

/** Seed content_blobs + a source_renditions row for the blob. */
function seedProjection(rawHash: string, normalizedHash: string, extractor = 1, normalizer = 1): void {
  store.db
    .prepare(
      `INSERT OR REPLACE INTO content_blobs (raw_content_hash, canonical_media_type, size_bytes, vault_path, first_seen_at)
       VALUES (?, 'text/markdown', ?, ?, '2026-07-20T00:00:00.000Z')`,
    )
    .run(rawHash, CONTENT.length, VAULT_PATH);
  store.db
    .prepare(
      `INSERT OR REPLACE INTO source_renditions (raw_content_hash, canonical_media_type, extractor_version, normalizer_version, normalized_content_hash, size_bytes, locator_scheme, created_at)
       VALUES (?, 'text/markdown', ?, ?, ?, ?, 'char', '2026-07-20T00:00:00.000Z')`,
    )
    .run(rawHash, extractor, normalizer, normalizedHash, CONTENT.length);
}

function env(): RecoverAnchorEnv {
  return { repo, canonicalRef: CANONICAL_REF, db: store.db };
}

function head(over: Partial<EvidenceHeadRow> = {}): EvidenceHeadRow {
  return {
    evidence_id: "ev-1",
    claim_id: "c-1",
    lineage_id: "ev-1",
    raw_content_hash: sha256(CONTENT),
    canonical_media_type: "text/markdown",
    extractor_version: 1,
    normalizer_version: 1,
    locator: "char:10-15",
    quote_hash: sha256(CONTENT.slice(10, 15)),
    ...over,
  };
}

const rendId = (e = 1, n = 1, raw = sha256(CONTENT)): string => `sha256:${raw}:text/markdown:${e}:${n}`;

/** Normalize CONTENT through the real sandbox once to learn the true rendition facts. */
async function realRendition(): Promise<{ normalizedHash: string; text: string; extractor: number; normalizer: number }> {
  const dir = mkdtempSync(join(tmpdir(), "atlas-rr-norm-"));
  const p = join(dir, "probe.md");
  writeFileSync(p, CONTENT, "utf8");
  try {
    const r = await normalize({ path: p });
    if (!r.ok) throw new Error(`probe normalize rejected: ${r.rejection.code}`);
    return {
      normalizedHash: r.rendition.normalizedContentHash,
      text: r.rendition.text,
      extractor: r.rendition.extractorVersion,
      normalizer: r.rendition.normalizerVersion,
    };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

beforeEach(() => {
  base = mkdtempSync(join(tmpdir(), "atlas-rr-"));
  mkdirSync(join(base, "vault"));
  execFileSync("git", ["-C", join(base, "vault"), "init", "-q", "-b", "main"]);
  repo = openRepo(join(base, "vault"));
  store = openStore({ path: ":memory:" });
  store.migrate();
});
afterEach(() => {
  store.close();
  rmSync(base, { recursive: true, force: true });
});

describe("parseLocatorRange", () => {
  it("parses char:/byte: strict integer ranges and rejects everything else", () => {
    expect(parseLocatorRange("char:10-15")).toEqual({ scheme: "char", start: 10, end: 15 });
    expect(parseLocatorRange("byte:0-5")).toEqual({ scheme: "byte", start: 0, end: 5 });
    expect(parseLocatorRange("page:1-2")).toBeNull();
    expect(parseLocatorRange("dom:/html/body")).toBeNull();
    expect(parseLocatorRange("(none)")).toBeNull();
    expect(parseLocatorRange("char:5-5")).toBeNull(); // empty span
    expect(parseLocatorRange("char:15-10")).toBeNull(); // inverted
    expect(parseLocatorRange("char:-1-5")).toBeNull();
    expect(parseLocatorRange("char:1.5-9")).toBeNull();
    expect(parseLocatorRange("char:1-")).toBeNull();
  });
});

describeIfSandbox("recoverAnchorFrom (#217, real sandbox)", () => {
  it("recovers the exact span (hash-verified) from the re-normalized blob at the canonical ref", async () => {
    const real = await realRendition();
    commitBlob(CONTENT);
    seedProjection(sha256(CONTENT), real.normalizedHash, real.extractor, real.normalizer);

    const start = real.text.indexOf("quick");
    const quote = real.text.slice(start, start + 5);
    const anchor = await recoverAnchorFrom(
      env(),
      head({ locator: `char:${start}-${start + 5}`, quote_hash: sha256(quote) }),
      rendId(real.extractor, real.normalizer),
    );
    expect(anchor).not.toBeNull();
    expect(anchor!.quote).toBe(quote);
    expect(anchor!.previousStart).toBe(start);
    expect(anchor!.newText).toBe(real.text);
  });

  it("byte: locators fail closed to pending — byte offsets verified in string space could stamp exact with a stale byte locator", async () => {
    const real = await realRendition();
    commitBlob(CONTENT);
    seedProjection(sha256(CONTENT), real.normalizedHash, real.extractor, real.normalizer);
    const start = real.text.indexOf("brown");
    // Even a would-be-verifiable ASCII span is refused: nothing in production
    // emits byte: (md/txt are char-offset), and multibyte content shifts byte
    // offsets off string indices — recovery never approximates byte space.
    const anchor = await recoverAnchorFrom(
      env(),
      head({ locator: `byte:${start}-${start + 5}`, quote_hash: sha256("brown") }),
      rendId(real.extractor, real.normalizer),
    );
    expect(anchor).toBeNull();
  });

  it("a range splitting a surrogate pair recovers nothing even when the lossy hash matches", async () => {
    const emojiContent = "# Alpha\n\nmark \u{1F600} end of note.\n";
    const dir2 = mkdtempSync(join(tmpdir(), "atlas-rr-sg-"));
    const p2 = join(dir2, "probe.md");
    writeFileSync(p2, emojiContent, "utf8");
    let text: string;
    let normalizedHash: string;
    let ext: number;
    let norm: number;
    try {
      const r = await normalize({ path: p2 });
      if (!r.ok) throw new Error(`probe rejected: ${r.rejection.code}`);
      text = r.rendition.text;
      normalizedHash = r.rendition.normalizedContentHash;
      ext = r.rendition.extractorVersion;
      norm = r.rendition.normalizerVersion;
    } finally {
      rmSync(dir2, { recursive: true, force: true });
    }
    const rawHash = sha256(emojiContent);
    commitBlob(emojiContent);
    seedProjection(rawHash, normalizedHash, ext, norm);

    // End the range between the emoji's high and low surrogate; the recorded hash
    // is computed over the exact LOSSY slice (what an attacker would supply) — the
    // boundary guard must refuse regardless of the hash matching.
    const emojiStart = text.indexOf("\u{1F600}");
    const start = text.indexOf("mark");
    const end = emojiStart + 1; // splits the pair
    const lossySlice = text.slice(start, end);
    const anchor = await recoverAnchorFrom(
      env(),
      head({ raw_content_hash: rawHash, locator: `char:${start}-${end}`, quote_hash: sha256(lossySlice) }),
      rendId(ext, norm, rawHash),
    );
    expect(anchor).toBeNull();
  });

  it("a quote_hash that matches nothing at the recorded range recovers nothing (vanished/shifted ⇒ pending)", async () => {
    const real = await realRendition();
    commitBlob(CONTENT);
    seedProjection(sha256(CONTENT), real.normalizedHash, real.extractor, real.normalizer);
    const anchor = await recoverAnchorFrom(
      env(),
      head({ quote_hash: "f".repeat(64) }),
      rendId(real.extractor, real.normalizer),
    );
    expect(anchor).toBeNull();
  });

  it("an offsetless locator scheme recovers nothing", async () => {
    const real = await realRendition();
    commitBlob(CONTENT);
    seedProjection(sha256(CONTENT), real.normalizedHash, real.extractor, real.normalizer);
    for (const locator of ["page:1-2", "dom:/html/body/p[1]", "(none)"]) {
      expect(await recoverAnchorFrom(env(), head({ locator }), rendId(real.extractor, real.normalizer))).toBeNull();
    }
  });

  it("a range past the end of the normalized text recovers nothing", async () => {
    const real = await realRendition();
    commitBlob(CONTENT);
    seedProjection(sha256(CONTENT), real.normalizedHash, real.extractor, real.normalizer);
    const end = real.text.length + 10;
    const anchor = await recoverAnchorFrom(
      env(),
      head({ locator: `char:${real.text.length - 2}-${end}`, quote_hash: sha256("x") }),
      rendId(real.extractor, real.normalizer),
    );
    expect(anchor).toBeNull();
  });

  it("a newRenditionId the current code cannot reproduce recovers nothing (version mismatch)", async () => {
    const real = await realRendition();
    commitBlob(CONTENT);
    seedProjection(sha256(CONTENT), real.normalizedHash, real.extractor, real.normalizer);
    // A projected rendition claiming versions 9:9 — the sandbox produces 1:1, so the
    // requested rendition is not reproducible by THIS code ⇒ fail closed.
    seedProjection(sha256(CONTENT), real.normalizedHash, 9, 9);
    expect(await recoverAnchorFrom(env(), head(), rendId(9, 9))).toBeNull();
  });

  it("a recorded normalized hash that differs from the sandbox output recovers nothing (drift)", async () => {
    const real = await realRendition();
    commitBlob(CONTENT);
    seedProjection(sha256(CONTENT), "sha256:" + "0".repeat(64), real.extractor, real.normalizer);
    expect(await recoverAnchorFrom(env(), head(), rendId(real.extractor, real.normalizer))).toBeNull();
  });

  it("canonical blob bytes that no longer hash to raw_content_hash recover nothing (tamper)", async () => {
    const real = await realRendition();
    commitBlob("TAMPERED bytes, not the captured content\n");
    seedProjection(sha256(CONTENT), real.normalizedHash, real.extractor, real.normalizer);
    expect(await recoverAnchorFrom(env(), head(), rendId(real.extractor, real.normalizer))).toBeNull();
  });

  it("a blob absent from the canonical ref recovers nothing", async () => {
    const real = await realRendition();
    commitBlob(CONTENT, "sources/other.blob"); // canonical exists but not at vault_path
    seedProjection(sha256(CONTENT), real.normalizedHash, real.extractor, real.normalizer);
    expect(await recoverAnchorFrom(env(), head(), rendId(real.extractor, real.normalizer))).toBeNull();
  });

  // v2 (#334): the secret-scan gate is retired — a credential-bearing blob
  // re-normalizes like any other bytes; there is no quarantine path to prove.
});

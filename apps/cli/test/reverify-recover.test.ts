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
import { platform, tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openStore, type Store } from "@atlas/sqlite-store";
import { openRepo, type Repo } from "@atlas/git";
import { PrePersistenceGuard, type QuarantineSink, type SecretFinding } from "@atlas/scan";
import { normalize, probeSandbox } from "@atlas/sources";
import { recoverAnchorFrom, parseLocatorRange, type RecoverAnchorEnv } from "../src/workflows/reverify-recover.js";
import type { EvidenceHeadRow } from "../src/workflows/reverify-handler.js";

// `recoverAnchorFrom` runs the sandboxed parser worker — same #29 gate as the other
// capture-driving suites: STRICT on a provisioned host, LOUD SKIP otherwise
// (stock hosted Linux lacks delegated cgroups; macOS CI is the strict platform).
const RR_SANDBOX = await probeSandbox();
const RR_REQUIRE = process.env.ATLAS_SANDBOX_REQUIRE === "1" || (process.env.CI === "true" && platform() === "darwin");
if (!RR_SANDBOX.supported && RR_REQUIRE) {
  const missing = RR_SANDBOX.checks.filter((c) => !c.available).map((c) => c.guarantee).join(", ");
  throw new Error(`[reverify-recover] provisioned host must support the sandbox but does not (${RR_SANDBOX.host}: ${missing})`);
}
if (!RR_SANDBOX.supported) console.warn(`[reverify-recover] SKIP sandbox-dependent tests: sandbox unsupported on ${RR_SANDBOX.host}`);
const describeIfSandbox = RR_SANDBOX.supported ? describe : describe.skip;

const CANONICAL_REF = "refs/heads/main";
const CONTENT = "# Alpha\n\nThe quick brown fox jumps over the lazy dog.\n";
const NOTE_ID = "src-alpha";
const VAULT_PATH = `sources/${NOTE_ID}.blob`;

const sha256 = (s: string | Uint8Array): string => createHash("sha256").update(s).digest("hex");

class RecordingSink implements QuarantineSink {
  readonly entries: { origin: string; findings: readonly SecretFinding[] }[] = [];
  quarantine(input: { bytes: Uint8Array; origin: string; findings: readonly SecretFinding[] }): Promise<void> {
    this.entries.push({ origin: input.origin, findings: input.findings });
    return Promise.resolve();
  }
}

let base: string;
let repo: Repo;
let store: Store;
let sink: RecordingSink;

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
  return { repo, canonicalRef: CANONICAL_REF, guard: new PrePersistenceGuard(sink), db: store.db };
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
    const r = await normalize({ path: p, guard: new PrePersistenceGuard(new RecordingSink()) });
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
  sink = new RecordingSink();
});
afterEach(() => {
  store.close();
  rmSync(base, { recursive: true, force: true });
});

describe("parseLocatorRange", () => {
  it("parses char:/byte: strict integer ranges and rejects everything else", () => {
    expect(parseLocatorRange("char:10-15")).toEqual({ start: 10, end: 15 });
    expect(parseLocatorRange("byte:0-5")).toEqual({ start: 0, end: 5 });
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

  it("byte: locators recover too when the hash proves the range (ASCII text)", async () => {
    const real = await realRendition();
    commitBlob(CONTENT);
    seedProjection(sha256(CONTENT), real.normalizedHash, real.extractor, real.normalizer);
    const start = real.text.indexOf("brown");
    const anchor = await recoverAnchorFrom(
      env(),
      head({ locator: `byte:${start}-${start + 5}`, quote_hash: sha256("brown") }),
      rendId(real.extractor, real.normalizer),
    );
    expect(anchor).not.toBeNull();
    expect(anchor!.quote).toBe("brown");
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

  it("a secret detected during re-normalization quarantines and throws PERMANENT (never retry-burn)", async () => {
    const secret = "AKIA" + "A".repeat(16);
    const dirty = `# Note\n\nembedded credential: ${secret}\n`;
    commitBlob(dirty);
    seedProjection(sha256(dirty), "sha256:" + "1".repeat(64));

    let thrown: unknown;
    try {
      await recoverAnchorFrom(env(), head({ raw_content_hash: sha256(dirty) }), rendId(1, 1, sha256(dirty)));
    } catch (e) {
      thrown = e;
    }
    expect(thrown, "a dirty blob must throw, not return").toBeDefined();
    // The runner's classifyError must see this as PERMANENT (kind validation /
    // code secret-detected) — a deterministic failure must not burn the budget.
    const t = thrown as { kind?: string; code?: string };
    expect(t.kind === "validation" || t.code === "secret-detected").toBe(true);
    expect(sink.entries.length).toBeGreaterThan(0); // quarantined BEFORE the throw
  });
});

/**
 * `reverify-reanchor.e2e` (#217) — the END-TO-END acceptance for the wired
 * `recoverAnchor` seam, driven through the REAL production stack: `brain evidence
 * retry` → `brain jobs run` via `runCli`, the reverify handler with the PRODUCTION
 * `defaultReverifySeams` (no injected fakes), the real `@atlas/sources` sandbox
 * re-normalization, and the real broker socket (`makePhase2Harness`) integrating the
 * `UpdateEvidenceVerification` ChangePlan under CAS — the same shape `evidence
 * resolve` drives.
 *
 *   1. a still-present quote (hash-verified at its recorded offset in the new
 *      rendition) auto-re-anchors: the job integrates Tier-2 WITHOUT human
 *      resolution — canonical advances and the note's evidence head is superseded
 *      to `verification: valid`;
 *   2. an unrecoverable quote (hash matches nothing) still PARKS: the job returns
 *      action-required (exit 6), canonical does not move, the note is untouched.
 *
 * The blob enters through a REAL Tier-1 capture (`captureViaBroker` — production
 * wiring, broker-signed integration), so `sources/<noteId>.blob` exists at the
 * canonical ref exactly as production leaves it.
 */
import { createHash, randomBytes } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { PrePersistenceGuard, type QuarantineSink, type SecretFinding } from "@atlas/scan";
import { normalize } from "@atlas/sources";
import { runCli } from "../../src/main.js";
import { makePhase2Harness, captureViaBroker, CANONICAL_REF, type Phase2Harness } from "./phase2-support.js";

const REPO_ROOT = join(import.meta.dirname, "..", "..", "..", "..");
const sha256 = (s: string | Uint8Array): string => createHash("sha256").update(s).digest("hex");

const CONTENT = "# Alpha Source\n\nThe quick brown fox jumps over the lazy dog.\n";
const MEDIA = "text/markdown";

class NullSink implements QuarantineSink {
  quarantine(_: { bytes: Uint8Array; origin: string; findings: readonly SecretFinding[] }): Promise<void> {
    return Promise.resolve();
  }
}

/** Normalize CONTENT through the real sandbox once — the span facts the seeds use. */
async function probeRendition(): Promise<{ text: string; extractor: number; normalizer: number }> {
  const dir = mkdtempSync(join(tmpdir(), "atlas-e2e-probe-"));
  try {
    const p = join(dir, "probe.md");
    writeFileSync(p, CONTENT, "utf8");
    const r = await normalize({ path: p, guard: new PrePersistenceGuard(new NullSink()) });
    if (!r.ok) throw new Error(`probe normalize rejected: ${r.rejection.code}`);
    return { text: r.rendition.text, extractor: r.rendition.extractorVersion, normalizer: r.rendition.normalizerVersion };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

let h: Phase2Harness;
let qdir: string;
let env: NodeJS.ProcessEnv;

async function cli(argv: string[]): Promise<{ code: number; out: string }> {
  let out = "";
  const realOut = process.stdout.write.bind(process.stdout);
  const realErr = process.stderr.write.bind(process.stderr);
  (process.stdout as unknown as { write: (s: string) => boolean }).write = (s: string) => ((out += s), true);
  (process.stderr as unknown as { write: (s: string) => boolean }).write = () => true;
  try {
    const code = await runCli(argv, env, { cwd: h.root, root: REPO_ROOT });
    return { code, out };
  } finally {
    process.stdout.write = realOut;
    process.stderr.write = realErr;
  }
}

/** The claims frontmatter note owning one claim with one evidence head. */
function claimNoteRaw(noteId: string, claimId: string, renditionHandle: string, locator: string, quoteHash: string): string {
  return [
    "---",
    `id: ${noteId}`,
    "type: concept",
    "schema_version: 1",
    `title: ${noteId}`,
    "status: active",
    "created: 2026-07-20",
    "updated: 2026-07-20",
    "claims:",
    `  - claim_id: ${claimId}`,
    `    text: "The fox statement."`,
    "    evidence:",
    `      - rendition: "${renditionHandle}"`,
    `        locator: "${locator}"`,
    `        quote_hash: "${quoteHash}"`,
    "        verification: stale",
    "---",
    "",
    `# ${noteId}`,
    "",
  ].join("\n");
}

/** Seed the projections the fold would derive: the owning note, claim, evidence head. */
function seedClaim(noteId: string, filePath: string, claimId: string, evidenceId: string, rawHash: string, locator: string, quoteHash: string): void {
  const store = h.openStore();
  try {
    const now = "2026-07-20T00:00:00.000Z";
    store.db
      .prepare(
        `INSERT INTO notes (note_id, slug, title, type, schema_version, status, file_path, content_hash, created, updated)
         VALUES (?, ?, ?, 'concept', 1, 'active', ?, 'sha256:0', ?, ?)`,
      )
      .run(noteId, noteId, noteId, filePath, now, now);
    store.db
      .prepare(`INSERT INTO claims (claim_id, owning_note_id, text, created_at) VALUES (?, ?, 'The fox statement.', ?)`)
      .run(claimId, noteId, now);
    store.db
      .prepare(
        `INSERT INTO claim_evidence (evidence_id, lineage_id, claim_id, raw_content_hash, canonical_media_type,
           extractor_version, normalizer_version, locator, quote_hash, payload_hash, verification, current, created_at)
         VALUES (?, ?, ?, ?, ?, 1, 1, ?, ?, ?, 'stale', 1, ?)`,
      )
      .run(evidenceId, evidenceId, claimId, rawHash, MEDIA, locator, quoteHash, `e2e-seed-${evidenceId}`, now);
  } finally {
    store.close();
  }
}

beforeEach(async () => {
  h = await makePhase2Harness();
  // The quarantine AEAD custody key (the guard constructs the store eagerly).
  const custodyAgent = join(h.root, ".atlas", "custody", "agent");
  mkdirSync(custodyAgent, { recursive: true, mode: 0o700 });
  writeFileSync(join(custodyAgent, "quarantine-aead.key"), randomBytes(32), { mode: 0o600 });
  // The quarantine dir must live OUTSIDE h.root: repositoryRoot() walks up from cwd
  // (h.root), finds no .git, and falls back to h.root itself — so any dir under
  // h.root reads as "inside the repository" (quarantine-dir-invalid).
  qdir = mkdtempSync(join(tmpdir(), "atlas-e2e-q-"));

  // The production config runCli loads — absolute paths, the harness's broker socket,
  // the harness's backup dir/key (the §2.8 watermark from the capture must keep
  // matching), and the harness's canonical ref (config default is refs/atlas/main).
  const config = [
    "vault:",
    `  path: ${h.vaultDir}`,
    "sqlite:",
    `  path: ${h.dbPath}`,
    "  ledger_backup:",
    `    dir: ${join(h.root, ".atlas", "backups")}`,
    "    key_id: test-key-v1",
    "    keep: 10",
    "lancedb:",
    `  dir: ${join(h.root, ".atlas", "lancedb")}`,
    "indexing:",
    "  chunker_version: 1",
    "  embedding_model: gemini-embedding-001",
    "  dimensions: 768",
    "git:",
    `  worktrees_path: ${h.worktreesPath}`,
    `  audit_anchor_path: ${h.anchorPath}`,
    `  canonical_ref: ${CANONICAL_REF}`,
    "models: {}",
    "policies: {}",
    "logs:",
    `  dir: ${join(h.root, ".atlas", "logs")}`,
    "broker:",
    `  socket_path: ${h.socketPath}`,
    `  egress_socket_path: ${join(h.root, "egress.sock")}`,
    "quarantine:",
    `  dir: ${qdir}`,
    "  key_id: cli-custody-v1",
    "",
  ].join("\n");
  writeFileSync(join(h.root, "brain.config.yaml"), config, "utf8");
  env = {
    ...process.env,
    NO_COLOR: "1",
    ATLAS_TEST_MODE: "1",
    ATLAS_CUSTODY_TEST_DIR: join(h.root, ".atlas", "custody"),
  };
}, 120_000);
afterEach(async () => {
  await h.cleanup();
  rmSync(qdir, { recursive: true, force: true });
});

describe("reverify re-anchor E2E (#217) — production seams, real sandbox, real broker", () => {
  it(
    "evidence retry on a still-present quote auto-re-anchors Tier-2 (no human resolution); an unrecoverable quote still parks",
    async () => {
      const probe = await probeRendition();
      const rawHash = sha256(CONTENT);
      const renditionHandle = `sha256:${rawHash}:${MEDIA}:${probe.extractor}:${probe.normalizer}`;

      // The recorded span: present, unique, and provable at its offset.
      const quote = "quick brown fox";
      const start = probe.text.indexOf(quote);
      expect(start).toBeGreaterThan(-1);
      const locator = `char:${start}-${start + quote.length}`;
      const quoteHash = sha256(quote);

      // 1. The claim notes enter canonical FIRST (index still in sync with the seed
      //    commit), then the blob enters through a REAL Tier-1 capture.
      writeFileSync(join(h.vaultDir, "note-claims.md"), claimNoteRaw("concept-claims", "c-1", renditionHandle, locator, quoteHash), "utf8");
      writeFileSync(
        join(h.vaultDir, "note-parked.md"),
        claimNoteRaw("concept-parked", "c-2", renditionHandle, locator, "f".repeat(64)),
        "utf8",
      );
      h.git(["add", "-A"]);
      h.git(["commit", "-q", "-m", "seed claim notes"]);

      const inbox = join(h.root, "inbox");
      mkdirSync(inbox, { recursive: true });
      const srcPath = join(inbox, "alpha-src.md");
      writeFileSync(srcPath, CONTENT, "utf8");
      const cap = await captureViaBroker(h, srcPath);
      expect(cap.renditionId.extractorVersion).toBe(probe.extractor);

      // 2. Projections the fold would derive (owning notes + claims + evidence heads).
      seedClaim("concept-claims", "note-claims.md", "c-1", "ev-e2e-1", rawHash, locator, quoteHash);
      seedClaim("concept-parked", "note-parked.md", "c-2", "ev-e2e-2", rawHash, locator, "f".repeat(64));

      // ── Auto path: retry + drain ⇒ integrated without any human resolution.
      const preHead = h.git(["rev-parse", CANONICAL_REF]);

      const retry = await cli(["evidence", "retry", "ev-e2e-1", "--json"]);
      expect(retry.code, retry.out).toBe(0);

      const run = await cli(["jobs", "run", "--json"]);
      expect(run.code, run.out).toBe(0); // exit 0 — NOT 6: no action required, no park
      const report = JSON.parse(run.out);
      expect(report.aggregate.exitCode).toBe(0);
      expect(report.items, run.out).toHaveLength(1);

      // Canonical advanced under broker CAS, and the note's evidence head was
      // superseded to `valid` IN CANONICAL MARKDOWN (the durable SSOT), pinned to the
      // new rendition — the old head tombstoned with its explicit id.
      const postHead = h.git(["rev-parse", CANONICAL_REF]);
      expect(postHead).not.toBe(preHead);
      const noteAtCanonical = h.git(["show", `${CANONICAL_REF}:note-claims.md`]);
      expect(noteAtCanonical).toContain("verification: valid");
      expect(noteAtCanonical).toContain("supersedes_evidence_id: ev-e2e-1");
      expect(noteAtCanonical).toContain("current: false");
      // The YAML serializer may fold the long rendition string (`"…\` + newline)
      // and may emit it plain-style — normalize both before asserting the pin.
      const unfolded = noteAtCanonical.replace(/\\\n\s*/g, "").replace(/"/g, "");
      expect(unfolded).toContain(`rendition: ${renditionHandle}`);

      // ── Fail-closed path: an unrecoverable quote (hash matches nothing) parks.
      const preParked = h.git(["rev-parse", CANONICAL_REF]);

      const retry2 = await cli(["evidence", "retry", "ev-e2e-2", "--json"]);
      expect(retry2.code, retry2.out).toBe(0);

      const run2 = await cli(["jobs", "run", "--json"]);
      const report2 = JSON.parse(run2.out);
      expect(run2.code, run2.out).toBe(6); // action-required: parked for an operator
      expect(report2.aggregate.exitCode).toBe(6);

      // Nothing auto-integrated: canonical did not move, the parked note is untouched.
      expect(h.git(["rev-parse", CANONICAL_REF])).toBe(preParked);
      const parkedAtCanonical = h.git(["show", `${CANONICAL_REF}:note-parked.md`]);
      expect(parkedAtCanonical).toContain("verification: stale");
      expect(parkedAtCanonical).not.toContain("current: false");
    },
    180_000,
  );
});

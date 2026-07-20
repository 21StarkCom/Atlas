/**
 * `source-trust-read.cli.test` (#218) — the trust READ surface reports the real
 * `0010_trust_state` projection, not a hardcoded default. A promoted source reads
 * back promoted on `source list`/`source show`/`source trust show`; a revoked
 * source reads suspended + effective-untrusted (fail-closed); a source with NO
 * trust row still reads untrusted (default-untrusted is the contract, not a bug);
 * the promote/revoke reason + timestamp round-trip through `history`.
 *
 * Trust rows are written through the REAL `promoteTrust`/`revokeTrust` execution
 * (stubbed broker ledger-advance seam, as in `trust-command.test.ts`) so the test
 * exercises the actual write→read projection round-trip.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import _Ajv2020 from "ajv/dist/2020.js";
import { runCli } from "../src/main.js";
import { openStore, type Store } from "@atlas/sqlite-store";
import { promoteTrust, revokeTrust, type TrustDeps, type TrustTarget } from "../src/trust/index.js";

const REPO_ROOT = join(import.meta.dirname, "..", "..", "..");
const Ajv = ((_Ajv2020 as unknown as { default?: unknown }).default ?? _Ajv2020) as new (opts?: unknown) => {
  compile: (s: unknown) => ((v: unknown) => boolean) & { errors?: unknown };
  errorsText: (e?: unknown) => string;
};
function validateSchema(name: string, value: unknown): void {
  const ajv = new Ajv({ strict: false, allErrors: true });
  const schema = JSON.parse(readFileSync(join(REPO_ROOT, "docs/specs/cli-contract", `${name}.schema.json`), "utf8"));
  const validate = ajv.compile(schema);
  if (!validate(value)) throw new Error(`${name} failed schema: ${ajv.errorsText(validate.errors)}\n${JSON.stringify(value)}`);
}

const hash = (n: number): string => n.toString(16).padStart(64, "0");
const iso = "2026-07-13T10:00:00.000Z";
const NOW = "2026-07-16T00:00:00.000Z";

let root: string;
let cwd: string;
let env: NodeJS.ProcessEnv;
let dbPath: string;

async function cli(argv: string[]): Promise<{ code: number; out: string }> {
  let out = "";
  const realOut = process.stdout.write.bind(process.stdout);
  const realErr = process.stderr.write.bind(process.stderr);
  (process.stdout as unknown as { write: (s: string) => boolean }).write = (s: string) => ((out += s), true);
  (process.stderr as unknown as { write: (s: string) => boolean }).write = () => true;
  try {
    const code = await runCli(argv, env, { cwd, root: REPO_ROOT });
    return { code, out };
  } finally {
    process.stdout.write = realOut;
    process.stderr.write = realErr;
  }
}

beforeEach(async () => {
  root = mkdtempSync(join("/tmp", "atlas-str-"));
  cwd = join(root, "work");
  mkdirSync(join(cwd, ".atlas"), { recursive: true });
  const vaultDir = join(cwd, "vault");
  mkdirSync(vaultDir, { recursive: true });
  const config = [
    "vault:", `  path: ${vaultDir}`,
    "sqlite:", "  path: ./.atlas/atlas.db", "  ledger_backup:", "    dir: ./.atlas/backups",
    "lancedb:", "  dir: ./.atlas/lancedb",
    "indexing:", "  chunker_version: 1", "  embedding_model: gemini-embedding-001", "  dimensions: 768",
    "git:", "  worktrees_path: ./.atlas/worktrees", `  audit_anchor_path: ${join(root, "anchor")}`,
    "models: {}", "policies: {}", "logs:", "  dir: ./.atlas/logs",
    "broker:", `  socket_path: ${join(root, "b.sock")}`, `  egress_socket_path: ${join(root, "e.sock")}`, "",
  ].join("\n");
  writeFileSync(join(cwd, "brain.config.yaml"), config, "utf8");
  env = { ...process.env, NO_COLOR: "1" };
  dbPath = join(cwd, ".atlas", "atlas.db");
  await cli(["db", "migrate", "--json"]);
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

/** Seed blob n with a capture + active rendition; returns its ids + trust target. */
function seedBlob(store: Store, n: number): { contentId: string; renditionId: string; target: TrustTarget } {
  const raw = hash(n);
  const media = "text/markdown";
  store.provenance.upsertBlob({ raw_content_hash: raw, canonical_media_type: media, size_bytes: 1024, vault_path: `blob/${n}`, first_seen_at: iso });
  store.provenance.recordCapture({ raw_content_hash: raw, canonical_media_type: media, origin: `/inbox/${n}.md`, first_seen_at: iso, last_seen_at: iso });
  store.provenance.recordRendition({ raw_content_hash: raw, canonical_media_type: media, extractor_version: 1, normalizer_version: 1, normalized_content_hash: `sha256:${hash(n + 100)}`, size_bytes: 990, locator_scheme: "char", created_at: iso });
  store.provenance.setActiveRendition({ raw_content_hash: raw, canonical_media_type: media, extractor_version: 1, normalizer_version: 1 });
  return {
    contentId: `sha256:${raw}:${media}`,
    renditionId: `sha256:${raw}:${media}:1:1`,
    target: { rawContentHash: raw, canonicalMediaType: media },
  };
}

function deps(s: Store): TrustDeps {
  return { db: s.db, advanceTrustLedger: async () => {}, now: () => NOW };
}

describe("trust read surface reports the real projection (#218)", () => {
  it("a promoted source reads back promoted on source trust show, with the promotion in history", async () => {
    const store = openStore({ path: dbPath });
    let ids: ReturnType<typeof seedBlob>;
    try {
      ids = seedBlob(store, 1);
      await promoteTrust(ids.target, "trusted", "vetted origin", deps(store));
    } finally { store.close(); }

    const r = await cli(["source", "trust", "show", ids.contentId, "--json"]);
    expect(r.code, r.out).toBe(0);
    const out = JSON.parse(r.out);
    validateSchema("source-trust-show", out);
    expect(out.effectiveTrustLevel).toBe("trusted");
    expect(out.reviewedTrustLevel).toBe("trusted");
    expect(out.suspended).toBe(false);
    expect(out.suspensionReason).toBeUndefined();
    expect(out.history).toEqual([{ at: NOW, action: "promote", toLevel: "trusted", reason: "vetted origin" }]);
  });

  it("a promoted source reads back promoted on source list and source show; an untouched source stays untrusted", async () => {
    const store = openStore({ path: dbPath });
    let promoted: ReturnType<typeof seedBlob>;
    let untouched: ReturnType<typeof seedBlob>;
    try {
      promoted = seedBlob(store, 1);
      untouched = seedBlob(store, 2);
      await promoteTrust(promoted.target, "trusted", "vetted origin", deps(store));
    } finally { store.close(); }

    const list = await cli(["source", "list", "--json"]);
    expect(list.code, list.out).toBe(0);
    const listOut = JSON.parse(list.out);
    validateSchema("source-list", listOut);
    const byId = new Map(listOut.sources.map((s: { contentId: string; trustLevel: string }) => [s.contentId, s.trustLevel]));
    expect(byId.get(promoted.contentId)).toBe("trusted");
    expect(byId.get(untouched.contentId)).toBe("untrusted");

    const show = await cli(["source", "show", promoted.contentId, "--json"]);
    expect(show.code, show.out).toBe(0);
    const showOut = JSON.parse(show.out);
    validateSchema("source-show", showOut);
    expect(showOut.source.trustLevel).toBe("trusted");
  });

  it("a revoked source reads suspended + effective-untrusted everywhere (fail-closed), with the revoke in history", async () => {
    const store = openStore({ path: dbPath });
    let ids: ReturnType<typeof seedBlob>;
    try {
      ids = seedBlob(store, 1);
      await promoteTrust(ids.target, "trusted", "vetted origin", deps(store));
      await revokeTrust(ids.target, "compromised", deps(store));
    } finally { store.close(); }

    const r = await cli(["source", "trust", "show", ids.contentId, "--json"]);
    expect(r.code, r.out).toBe(0);
    const out = JSON.parse(r.out);
    validateSchema("source-trust-show", out);
    expect(out.effectiveTrustLevel).toBe("untrusted");
    expect(out.suspended).toBe(true);
    expect(out.suspensionReason).toBe("revoked");
    expect(out.reviewedTrustLevel).toBeUndefined(); // the projection no longer carries the pre-revoke level
    expect(out.history).toEqual([{ at: NOW, action: "revoke", toLevel: "untrusted", reason: "compromised" }]);

    const list = await cli(["source", "list", "--json"]);
    const entry = JSON.parse(list.out).sources.find((s: { contentId: string }) => s.contentId === ids.contentId);
    expect(entry.trustLevel).toBe("untrusted"); // suspended never surfaces as its stored level

    const show = await cli(["source", "show", ids.contentId, "--json"]);
    expect(JSON.parse(show.out).source.trustLevel).toBe("untrusted");
  });

  it("a source with NO trust row still reads untrusted with empty history (default-untrusted contract)", async () => {
    const store = openStore({ path: dbPath });
    let ids: ReturnType<typeof seedBlob>;
    try { ids = seedBlob(store, 1); } finally { store.close(); }

    const r = await cli(["source", "trust", "show", ids.contentId, "--json"]);
    expect(r.code, r.out).toBe(0);
    const out = JSON.parse(r.out);
    validateSchema("source-trust-show", out);
    expect(out.effectiveTrustLevel).toBe("untrusted");
    expect(out.suspended).toBe(false);
    expect(out.reviewedTrustLevel).toBeUndefined();
    expect(out.history).toEqual([]);

    const list = await cli(["source", "list", "--json"]);
    expect(JSON.parse(list.out).sources[0].trustLevel).toBe("untrusted");
  });
});

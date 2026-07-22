/**
 * `graduation-quarantine` (Task 5.3 / #59) — quarantine inspect|resolve. Covers the sealed
 * graduation context that makes an AEAD item inspectable (origin/category/detectedAt round-trip),
 * the release-record persistence the migrate release-path reads, both commands' arg parsing, and the
 * challenge/exit-6 authorization gates. (The reveal/discard/release EXECUTION runs over the live
 * broker + custody in ATLAS_TEST_MODE; these assert the surface + the fail-closed auth gate.)
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { QuarantineStore } from "../src/quarantine/store.js";
import { addRelease, readReleases, releasesPath } from "../src/graduation/releases.js";
import { parseArgs as inspectParse } from "../src/commands/quarantine-inspect.js";
import { parseArgs as resolveParse } from "../src/commands/quarantine-resolve.js";
import { runCli } from "../src/main.js";

const REPO_ROOT = join(import.meta.dirname, "..", "..", "..");
const AWS_KEY = `AKIA${"A".repeat(16)}`;

let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "atlas-gq-"));
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

describe("quarantine sealed graduation context (#59)", () => {
  it("quarantineItem seals origin/category/detectedAt; read() surfaces them + decrypts content", () => {
    const store = new QuarantineStore({ dir: join(root, "q"), key: randomBytes(32), keyId: "test-v1" });
    const bytes = Buffer.from(`token: ${AWS_KEY}\n`, "utf8");
    const id = store.quarantineItem({
      bytes,
      origin: "Concepts/Leak.md",
      findings: [{ ruleId: "aws-access-key-id", title: "AWS", severity: "high", startOffset: 7, endOffset: 27, redactedPreview: "AKIA…" }],
      graduation: { origin: "Concepts/Leak.md", category: "detected-credential", detectedAt: "graduation-scan" },
    });
    const item = store.read(id);
    expect(item.meta.graduation).toEqual({ origin: "Concepts/Leak.md", category: "detected-credential", detectedAt: "graduation-scan" });
    expect(item.meta.findings[0]!.ruleId).toBe("aws-access-key-id");
    expect(Buffer.from(item.bytes).toString("utf8")).toBe(`token: ${AWS_KEY}\n`); // reveal content
  });

  it("an item WITHOUT graduation context (egress spool) has no graduation metadata", () => {
    const store = new QuarantineStore({ dir: join(root, "q2"), key: randomBytes(32), keyId: "test-v1" });
    const id = store.quarantineItem({ bytes: Buffer.from("x", "utf8"), origin: "runtime", findings: [] });
    expect(store.read(id).meta.graduation).toBeUndefined();
  });
});

describe("graduation release records (§7.1)", () => {
  it("addRelease → readReleases round-trips by note path (idempotent overwrite); absent ⇒ {}", () => {
    const p = releasesPath(join(root, ".atlas", "atlas.db"));
    expect(readReleases(p)).toEqual({});
    addRelease(p, "Concepts/Atlas.md", { opaqueId: "q-1", authorization: "authz_q-1" });
    addRelease(p, "People/Koral.md", { opaqueId: "q-2", authorization: "authz_q-2" });
    expect(readReleases(p)).toEqual({
      "Concepts/Atlas.md": { opaqueId: "q-1", authorization: "authz_q-1" },
      "People/Koral.md": { opaqueId: "q-2", authorization: "authz_q-2" },
    });
    addRelease(p, "Concepts/Atlas.md", { opaqueId: "q-1b", authorization: "authz_q-1b" }); // overwrite
    expect(readReleases(p)["Concepts/Atlas.md"]).toEqual({ opaqueId: "q-1b", authorization: "authz_q-1b" });
  });
});

describe("quarantine inspect|resolve arg parsing (#59)", () => {
  it("inspect: <opaqueId> + --reveal/--export-challenge/--authorization; missing id / unknown flag reject", () => {
    expect(inspectParse(["q-1"])).toEqual({ opaqueId: "q-1", reveal: false, exportChallenge: false });
    expect(inspectParse(["q-1", "--reveal"]).reveal).toBe(true);
    expect(inspectParse(["q-1", "--authorization", "/a"]).authorization).toBe("/a");
    expect(() => inspectParse([])).toThrow(/opaqueId/);
    expect(() => inspectParse(["q-1", "--nope"])).toThrow(/unknown/);
  });
  it("resolve: requires --resolution release|discard", () => {
    expect(resolveParse(["q-1", "--resolution", "discard"])).toEqual({ opaqueId: "q-1", resolution: "discard", exportChallenge: false });
    expect(resolveParse(["q-1", "--resolution=release"]).resolution).toBe("release");
    expect(() => resolveParse(["q-1"])).toThrow(/--resolution/);
    expect(() => resolveParse(["q-1", "--resolution", "bogus"])).toThrow(/--resolution/);
    expect(() => resolveParse(["--resolution", "release"])).toThrow(/opaqueId/);
  });
});

describe("quarantine inspect|resolve authorization gate (exit 2)", () => {
  let cwd: string;
  let env: NodeJS.ProcessEnv;
  beforeEach(() => {
    cwd = join(root, "work");
    mkdirSync(join(cwd, ".atlas"), { recursive: true });
    const config = [
      "vault:", `  path: ${join(root, "vault")}`,
      "sqlite:", "  path: ./.atlas/atlas.db", "  ledger_backup:", "    dir: ./.atlas/backups",
      "lancedb:", "  dir: ./.atlas/lancedb",
      "indexing:", "  chunker_version: 1", "  embedding_model: gemini-embedding-001", "  dimensions: 768",
      "git:", "  worktrees_path: ./.atlas/worktrees", `  audit_anchor_path: ${join(root, "anchor")}`,
      "models: {}", "policies: {}", "logs:", "  dir: ./.atlas/logs",
      "broker:", `  socket_path: ${join(root, "b.sock")}`, `  egress_socket_path: ${join(root, "e.sock")}`, "",
    ].join("\n");
    mkdirSync(join(root, "vault"), { recursive: true });
    writeFileSync(join(cwd, "brain.config.yaml"), config, "utf8");
    env = { ...process.env, NO_COLOR: "1" };
  });
  async function cli(argv: string[]): Promise<{ code: number; out: string }> {
    let out = "";
    const realOut = process.stdout.write.bind(process.stdout);
    const realErr = process.stderr.write.bind(process.stderr);
    (process.stdout as unknown as { write: (s: string) => boolean }).write = (s: string) => ((out += s), true);
    (process.stderr as unknown as { write: (s: string) => boolean }).write = () => true;
    try {
      return { code: await runCli(argv, env, { cwd, root: REPO_ROOT }), out };
    } finally {
      process.stdout.write = realOut;
      process.stderr.write = realErr;
    }
  }

  it("inspect without an authorization ⇒ authorization-required (exit 2)", async () => {
    const r = await cli(["quarantine", "inspect", "q-abc", "--json"]);
    expect(r.code).toBe(2);
    expect(JSON.parse(r.out).code).toBe("authorization-required");
  });
  it("resolve without an authorization ⇒ authorization-required (exit 2)", async () => {
    const r = await cli(["quarantine", "resolve", "q-abc", "--resolution", "discard", "--json"]);
    expect(r.code).toBe(2);
    expect(JSON.parse(r.out).code).toBe("authorization-required");
  });
});

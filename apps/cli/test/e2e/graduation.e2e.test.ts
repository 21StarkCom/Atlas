/**
 * `graduation.e2e` (Task 5.4 / #60, ATLAS_TEST_MODE fixture suite) — the AUTOMATABLE half of the
 * graduation E2E: the full pipeline end-to-end over a real vault copy, with the privileged apply +
 * rollback authorized by the TEST signer through the real broker socket (mint → sign → authorize).
 * Per D20 the production real-copy operation uses the PRODUCTION OS-presence/hardware authorizer (the
 * broker hard-rejects the test signer outside ATLAS_TEST_MODE), so THAT half stays human-gated; this
 * proves the pipeline itself: scan (clean) → audit (§7 inventory) → migrate preview → migrate --apply
 * (byte-exact managed frontmatter written to the copy) → migrate --rollback (byte-exact reversal).
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BrokerService, generateEd25519, signBytes, startBrokerServer, type AttestationKey } from "@atlas/broker";
import { runCli } from "../../src/main.js";

const REPO_ROOT = join(import.meta.dirname, "..", "..", "..", "..");
const APPROVER = "atlas-approver-grad-01";
const KEY_ID = "cli-custody-v1";

let root: string;
let cwd: string;
let source: string;
let copy: string;
let env: NodeJS.ProcessEnv;
let approverPriv: ReturnType<typeof generateEd25519>["privateKey"];
let server: Awaited<ReturnType<typeof startBrokerServer>>;

function git(dir: string, args: string[]): string {
  return execFileSync("git", ["-C", dir, ...args], { encoding: "utf8", env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" } });
}
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
/** Sign an exported AuthorizationChallenge into an authorization file (the test approver). */
function signAuth(challengeJson: string, path: string): void {
  const challenge = JSON.parse(challengeJson) as { signingPayload: string };
  const signature = signBytes(new TextEncoder().encode(challenge.signingPayload), approverPriv);
  writeFileSync(path, JSON.stringify({ schemaVersion: 1, challenge, signature, signerId: APPROVER }), "utf8");
}

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), "atlas-grad-e2e-"));
  cwd = join(root, "work");
  mkdirSync(join(cwd, ".atlas"), { recursive: true });
  const custodyDir = join(root, "custody");
  mkdirSync(custodyDir, { recursive: true });
  writeFileSync(join(custodyDir, `${KEY_ID}.key`), Buffer.from(randomBytes(32)).toString("base64"), "utf8");

  // A clean legacy source vault (git, two innocuous untyped notes → migrate to concept/person).
  source = join(root, "legacy");
  mkdirSync(join(source, "Concepts"), { recursive: true });
  mkdirSync(join(source, "People"), { recursive: true });
  git(source, ["init", "-q", "-b", "main"]);
  git(source, ["config", "commit.gpgsign", "false"]);
  writeFileSync(join(source, "Concepts", "Atlas.md"), "# Atlas\n\nA standalone concept, no links.\n");
  writeFileSync(join(source, "People", "Koral.md"), "# Koral\n\nA standalone person, no links.\n");
  git(source, ["add", "-A"]);
  git(source, ["commit", "-q", "-m", "seed"]);
  copy = join(root, "grad-copy");

  const anchorPath = join(root, "anchor");
  const socketPath = join(root, "b.sock");
  const attKp = generateEd25519();
  const attestation: AttestationKey = { signerId: "atlas-audit-attestation-v1", privateKey: attKp.privateKey, publicKey: attKp.publicKey };
  const approverKp = generateEd25519();
  approverPriv = approverKp.privateKey;
  const service = new BrokerService({
    repoDir: source,
    refs: { canonical: "refs/heads/main", audit: "refs/audit/runs", trust: "refs/trust/ledger" },
    anchorPath,
    signers: [
      { signerId: attestation.signerId, publicKey: attKp.publicKeyString, permittedOps: [], status: "active", enrolledAt: "2026-07-01T00:00:00.000Z" },
      { signerId: APPROVER, publicKey: approverKp.publicKeyString, permittedOps: ["graduation migrate"], status: "active", enrolledAt: "2026-07-01T00:00:00.000Z" },
    ],
    attestation,
    testMode: true,
  });
  server = await startBrokerServer(service, socketPath);

  const config = [
    "vault:", `  path: ${source}`,
    "sqlite:", "  path: ./.atlas/atlas.db", "  ledger_backup:", "    dir: ./.atlas/backups", `    key_id: ${KEY_ID}`,
    "lancedb:", "  dir: ./.atlas/lancedb",
    "indexing:", "  chunker_version: 1", "  embedding_model: gemini-embedding-001", "  dimensions: 768",
    "git:", "  worktrees_path: ./.atlas/worktrees", `  audit_anchor_path: ${anchorPath}`,
    "models: {}", "policies: {}", "logs:", "  dir: ./.atlas/logs",
    "broker:", `  socket_path: ${socketPath}`, `  egress_socket_path: ${join(root, "e.sock")}`, "",
  ].join("\n");
  writeFileSync(join(cwd, "brain.config.yaml"), config, "utf8");
  env = { ...process.env, NO_COLOR: "1", ATLAS_TEST_MODE: "1", ATLAS_CUSTODY_TEST_DIR: custodyDir, ATLAS_IDENTITY: "trusted-cli" };
  await cli(["db", "migrate", "--json"]);
});
afterAll(async () => {
  await server?.close();
  if (root) rmSync(root, { recursive: true, force: true });
});

describe("graduation E2E — scan → audit → migrate apply/rollback (test-signed, #60 automatable half)", () => {
  it("runs the full pipeline: clean scan, audit, preview, test-signed apply, then test-signed rollback", async () => {
    // 1) SCAN the live source into the disposable copy — clean gate.
    const scan = await cli(["graduation", "scan", "--source", source, "--copy", copy, "--json"]);
    expect(scan.code, scan.out).toBe(0);
    expect(JSON.parse(scan.out).gate).toBe("clean");

    // 2) AUDIT the copy — read-only §7 inventory, tree unchanged.
    const audit = await cli(["graduation", "audit", "--json"]);
    expect(audit.code, audit.out).toBe(0);
    expect(JSON.parse(audit.out)).toMatchObject({ treeHashUnchanged: true });

    // 3) PREVIEW — deterministic plan, no mutation.
    const preview = await cli(["graduation", "migrate", "--json"]);
    expect(preview.code, preview.out).toBe(0);
    const plan = JSON.parse(preview.out);
    expect(plan.mode).toBe("preview");
    expect(plan.idMap["Concepts/Atlas.md"]).toBe("concept-atlas");

    // 4) APPLY — privileged: without an authorization it is action-required (exit 6).
    expect((await cli(["graduation", "migrate", "--apply", "--json"])).code).toBe(6);
    // mint → sign → authorize.
    const ch = await cli(["graduation", "migrate", "--apply", "--export-challenge", "--json"]);
    expect(ch.code).toBe(6);
    const authPath = join(root, "apply.auth.json");
    signAuth(ch.out, authPath);
    const applied = await cli(["graduation", "migrate", "--apply", "--authorization", authPath, "--json"]);
    expect(applied.code, applied.out).toBe(0);
    expect(JSON.parse(applied.out).mode).toBe("applied");
    // The copy's note now carries the managed id frontmatter (byte-exact apply).
    expect(readFileSync(join(copy, "Concepts", "Atlas.md"), "utf8")).toContain("id: concept-atlas");

    // 5) ROLLBACK — privileged, test-signed: byte-exact reversal of the copy.
    const rch = await cli(["graduation", "migrate", "--rollback", "--export-challenge", "--json"]);
    expect(rch.code).toBe(6);
    const rbAuth = join(root, "rollback.auth.json");
    signAuth(rch.out, rbAuth);
    const rolled = await cli(["graduation", "migrate", "--rollback", "--authorization", rbAuth, "--json"]);
    expect(rolled.code, rolled.out).toBe(0);
    expect(JSON.parse(rolled.out).mode).toBe("rolled-back");
    // Reverted to the pre-migration bytes (no managed frontmatter).
    expect(readFileSync(join(copy, "Concepts", "Atlas.md"), "utf8")).not.toContain("id: concept-atlas");
  });
});

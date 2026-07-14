/**
 * `egress.daemon.test` — the PRODUCTION daemon, launched (D3-F3).
 *
 * Spawns the real `dist/bin/atlas-egress.js` over a real Unix socket and drives it
 * with the `EgressClient`. Proves the daemon is OPERATIONAL, not fail-closed:
 *   - it bootstraps its capability-MAC secret at the CLI-READABLE shared path named
 *     by `ATLAS_EGRESS_CAPABILITY_KEY` (NOT the egress-only keys dir), so the CLI
 *     mints against the SAME key it reads back (the ACL contract the finding fixed);
 *   - a secret planted in a prompt is blocked in-broker, the offending bytes land in
 *     the REAL quarantine SPOOL as a CIPHERTEXT-ONLY sealed envelope (sealed to the
 *     CLI's public key — not dropped, not rejected, not plaintext), and a `refused`
 *     receipt is returned so the CLI can still write the `model_calls` row (D6/D18).
 *
 * The spawned process is compiled JS, so this suite requires a prior build
 * (`pnpm -r build`); it skips with a clear message if `dist` is absent.
 */
import { afterEach, describe, it, expect } from "vitest";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, mkdirSync, existsSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { generateKeyPairSync } from "node:crypto";
import { EgressClient, mintEgressCapability, openSpoolEnvelope, type EgressCapability, type SealedSpoolEnvelope } from "../src/index.js";

const HERE = fileURLToPath(new URL(".", import.meta.url));
const DAEMON = join(HERE, "..", "dist", "bin", "atlas-egress.js");
const MODEL = "gemini-3.5-flash";
const RUN = "01J9Z8Q0000000000000000000";
const PLANTED = "AKIAIOSFODNN7EXAMPLE aws_secret_access_key=wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY";

let child: ChildProcess | undefined;
let root: string | undefined;
afterEach(() => {
  child?.kill("SIGKILL");
  child = undefined;
  if (root !== undefined) rmSync(root, { recursive: true, force: true });
  root = undefined;
});

async function waitForSocket(path: string, timeoutMs = 5000): Promise<void> {
  const start = Date.now();
  for (;;) {
    if (existsSync(path)) return;
    if (Date.now() - start > timeoutMs) throw new Error("daemon socket never appeared");
    await new Promise((r) => setTimeout(r, 50));
  }
}

describe.skipIf(!existsSync(DAEMON))("egress daemon — launched, operational", () => {
  it("blocks a planted secret in-broker, spools it, and returns a refused receipt", async () => {
    root = mkdtempSync(join(tmpdir(), "atlas-egress-daemon-"));
    const keysDir = join(root, "keys");
    mkdirSync(keysDir, { recursive: true });
    writeFileSync(join(keysDir, "atlas.gemini.key"), "fake-key-never-used-on-the-block-path\n");
    const socketPath = join(root, "egress.sock");
    const spoolDir = join(root, "spool");
    // The capability-MAC secret is CLI-readable + shared (NOT in the egress-only keys
    // dir) — the launcher's provisioned path; the daemon bootstraps it if absent.
    const capKeyPath = join(root, "shared", "egress-capability.key");
    // The CLI holds the quarantine PRIVATE key; the daemon holds only the PUBLIC key.
    const { publicKey, privateKey } = generateKeyPairSync("x25519");
    const pubKeyPath = join(root, "shared", "quarantine-pub.der");
    mkdirSync(join(root, "shared"), { recursive: true });
    writeFileSync(pubKeyPath, publicKey.export({ type: "spki", format: "der" }));

    child = spawn(process.execPath, [DAEMON], {
      env: {
        ...process.env,
        ATLAS_EGRESS_SOCKET: socketPath,
        ATLAS_EGRESS_KEYS_DIR: keysDir,
        ATLAS_EGRESS_QUARANTINE_SPOOL: spoolDir,
        ATLAS_EGRESS_CAPABILITY_KEY: capKeyPath,
        ATLAS_EGRESS_QUARANTINE_PUBKEY: pubKeyPath,
        ATLAS_EGRESS_BUDGET_STATE: join(root, "budget-state.json"),
      },
      stdio: "ignore",
    });
    await waitForSocket(socketPath);

    // The daemon bootstrapped the shared capability-MAC secret at the CLI-readable
    // path; the CLI reads the SAME file to mint (the ACL contract the finding fixed).
    const secret = readFileSync(capKeyPath, "utf8").trim();
    const cap: EgressCapability = mintEgressCapability(
      { runId: RUN },
      { operation: "generateText", model: MODEL, maxBytes: 100_000, maxTokens: 100_000, costCeiling: 100_000, allowedSensitivity: "restricted" },
      { secret },
    );

    const client = await EgressClient.connect(socketPath);
    try {
      const out = await client.invoke({
        capability: cap,
        body: { operation: "generateText", request: { model: MODEL, prompt: { ref: "prompts/extract@1" }, input: PLANTED, maxTokens: 8 } },
        declaredSensitivity: "internal",
      });
      expect(out.ok).toBe(false);
      if (!out.ok && "refusal" in out) {
        expect(out.refusal.code).toBe("egress.secret_detected");
        expect(out.receipt?.outcome).toBe("refused");
      }
    } finally {
      client.close();
    }

    // The offending bytes landed in the REAL spool as a CIPHERTEXT-ONLY sealed
    // envelope (captured, not dropped/rejected, and NOT plaintext at rest).
    const spooled = existsSync(spoolDir) ? readdirSync(spoolDir).filter((n) => n.endsWith(".spool.json")) : [];
    expect(spooled.length).toBe(1);
    const raw = readFileSync(join(spoolDir, spooled[0]!), "utf8");
    // The plaintext secret must NOT appear anywhere in the at-rest envelope.
    expect(raw).not.toContain("AKIA");
    const env = JSON.parse(raw) as SealedSpoolEnvelope;
    // Only the CLI's private key can open it → the daemon never held the AEAD key.
    const opened = openSpoolEnvelope(privateKey, env);
    expect(opened.origin).toContain(RUN);
    expect(Buffer.from(opened.bytes).toString("utf8")).toContain("AKIA");
  }, 15_000);
});

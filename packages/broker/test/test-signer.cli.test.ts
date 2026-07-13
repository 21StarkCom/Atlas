/**
 * `test-signer.cli.test` — the `tools/test-signer.ts` fixture signer.
 *
 * Runs the CLI end-to-end: mint a challenge, pipe it through the signer, and
 * confirm the resulting authorization is accepted by a broker in TEST MODE and
 * hard-rejected (D20) by a broker in prod mode — proving the tool is genuinely
 * fixture-only.
 */
import { afterEach, describe, it, expect } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { BrokerRefusal, type PrivilegedOpDescriptor } from "../src/index.js";
import { createHarness, type Harness } from "./harness.js";

const TOOL = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "tools", "test-signer.ts");

let h: Harness;
let keysDir: string | undefined;
afterEach(() => {
  if (keysDir) rmSync(keysDir, { recursive: true, force: true });
  keysDir = undefined;
  h?.cleanup();
});

const OP: PrivilegedOpDescriptor = {
  op: "git approve",
  runId: "01J9Z8Q0000000000000000000",
  targetCommit: "a1b2c3d4e5f60718293a4b5c6d7e8f9012345678",
  canonicalBaseCommit: "b7e23c9d4a1f6082e5c3d90a1b2c3d4e5f607182",
  intendedEffect: { kind: "integrate", tier: 3, changePlanDigest: "sha256:3f9ac012" },
};

function runSigner(challenge: unknown): unknown {
  keysDir = mkdtempSync(join(tmpdir(), "atlas-test-keys-"));
  writeFileSync(join(keysDir, "atlas-test-approver.key"), h.testApproverKeyString + "\n");
  const out = execFileSync("node", [TOOL, "--key", "atlas-test-approver", "--keys-dir", keysDir], {
    input: JSON.stringify(challenge),
    encoding: "utf8",
  });
  return JSON.parse(out);
}

describe("tools/test-signer.ts", () => {
  it("produces an authorization the broker accepts in test mode", () => {
    h = createHarness({ testMode: true });
    const challenge = h.service.mintChallenge(OP);
    const authorization = runSigner(challenge);
    const res = h.service.execAuthorized(OP, authorization as never);
    expect(res.code).toBe("authz.ok");
  });

  it("produces an authorization the broker HARD-REJECTS in prod mode (D20)", () => {
    h = createHarness({ testMode: false });
    const challenge = h.service.mintChallenge(OP);
    const authorization = runSigner(challenge);
    let err: unknown;
    try {
      h.service.execAuthorized(OP, authorization as never);
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(BrokerRefusal);
    expect((err as BrokerRefusal).code).toBe("authz.signer_not_permitted");
  });
});

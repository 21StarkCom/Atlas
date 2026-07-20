#!/usr/bin/env node
/**
 * `test-signer` — the fixture authorization signer (plan Task 1.6, D20).
 *
 * Signs an `AuthorizationChallenge` (read from stdin) with the provisioned
 * `atlas-test-approver` Ed25519 key and writes an `AuthorizationResponse` to
 * stdout, so every privileged flow is executable in tests/CI:
 *
 *     node tools/test-signer.ts --key atlas-test-approver < challenge.json > authorization.json
 *
 * D20 GUARD: this is fixture-only. The broker HARD-REJECTS any authorization
 * signed by `atlas-test-approver` unless `ATLAS_TEST_MODE=1` is set in the
 * broker's env (see `packages/broker/src/authorize.ts`), so this tool can never
 * produce a production-usable authorization. Phase-5 real-copy graduation uses
 * the production OS-presence / hardware-backed authorizer, not this signer.
 *
 * The signer signs the challenge's `signingPayload` VERBATIM — it authorizes the
 * exact bytes the broker emitted and will recompute (§8.2), never an abstraction.
 */
import { createPrivateKey } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { AuthorizationChallengeSchema, type AuthorizationResponse } from "@atlas/contracts";
import { parsePrivateKeyFlexible, signBytes, signP256Bytes, TEST_SIGNER_DESCRIPTOR } from "@atlas/broker";

type Alg = "ed25519" | "p256";

function parseArgs(argv: string[]): { key: string; keysDir: string; alg: Alg } {
  let alg: Alg = "ed25519";
  let key: string | undefined;
  let keysDir =
    process.env.ATLAS_TEST_KEYS_DIR ?? process.env.ATLAS_BROKER_KEYS_DIR ?? process.cwd();
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--key") key = argv[++i] ?? key;
    else if (a === "--keys-dir") keysDir = argv[++i] ?? keysDir;
    else if (a === "--alg") {
      const v = argv[++i];
      if (v !== "ed25519" && v !== "p256") {
        throw new Error(`--alg must be ed25519 or p256, got "${v ?? ""}"`);
      }
      alg = v;
    }
  }
  // Default the signer id to the matching fixture id for the chosen algorithm.
  const defaultKey = alg === "p256" ? TEST_SIGNER_DESCRIPTOR.p256.signerId : TEST_SIGNER_DESCRIPTOR.ed25519.signerId;
  return { key: key ?? defaultKey, keysDir, alg };
}

function readStdin(): string {
  return readFileSync(0, "utf8");
}

function main(): void {
  const { key, keysDir, alg } = parseArgs(process.argv.slice(2));

  const challenge = AuthorizationChallengeSchema.parse(JSON.parse(readStdin()));
  const payload = new TextEncoder().encode(challenge.signingPayload);

  let signature: string;
  if (alg === "p256") {
    // The P-256 fixture has NO key file (SE keys expose no broker-readable
    // private key) — it signs with the shared descriptor's COMMITTED fixture
    // private key, so the in-process BrokerService verifies against the matching
    // public key the same descriptor carries. D20 still hard-rejects the id
    // outside ATLAS_TEST_MODE, so this can never produce a production authz.
    const privateKey = createPrivateKey(TEST_SIGNER_DESCRIPTOR.p256.privateKeyPem);
    signature = signP256Bytes(payload, privateKey);
  } else {
    // Key file convention: `<keysDir>/<signerId>.key`, holding EITHER the native
    // `ed25519:` PKCS#8 string OR an OpenSSL PEM (what Task-1.0 provisioning
    // generates via `openssl genpkey`) — both are accepted (round-3 finding 1).
    const keyPath = join(keysDir, `${key}.key`);
    const privateKey = parsePrivateKeyFlexible(readFileSync(keyPath, "utf8"));
    signature = signBytes(payload, privateKey);
  }

  const response: AuthorizationResponse = {
    schemaVersion: 1,
    challenge,
    signature,
    signerId: key,
  };
  process.stdout.write(JSON.stringify(response) + "\n");
}

main();

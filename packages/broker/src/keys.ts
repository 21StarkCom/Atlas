/**
 * Broker key + config loading (D9 custody: per-identity `0700` key dirs).
 *
 * The production launcher (`provisioning/bin/broker-launcher.sh`) sets
 * `ATLAS_BROKER_SOCKET` + `ATLAS_BROKER_KEYS_DIR` and, per D20, DOES NOT set
 * `ATLAS_TEST_MODE`. This module reads the keys dir + env into a
 * `BrokerServiceConfig`. Key files hold the `ed25519:` serialized form this
 * package emits; the signer registry is `signers.json` (an array of §9.2 entries).
 */
import { createPublicKey } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { platform } from "node:os";
import {
  SignerRegistryEntrySchema,
  type SignerRegistryEntry,
} from "@atlas/contracts";
import { parsePrivateKeyFlexible, parsePublicKeyFlexible, serializePublicKey } from "./crypto.js";
import { TEST_SIGNER_ID, TEST_SIGNER_DESCRIPTOR } from "./authorize.js";
import type { AttestationKey, BrokerServiceConfig } from "./service.js";
import type { ProtectedRefs } from "./refs.js";

/** The default audit-attestation signer id (§6/§9.2). */
export const DEFAULT_ATTESTATION_SIGNER_ID = "atlas-audit-attestation-v1";

/** The default enrolled-approver signer id (the `approval-verify.pub` identity). */
export const DEFAULT_APPROVER_SIGNER_ID = "approval-verify";

/**
 * The op set an enrolled **signature** approver (`approval-verify`) may sign
 * authorizations for. This is the registry-privileged set (security/broker
 * contract §7) RESTRICTED to the `broker-signature` mechanism — it deliberately
 * EXCLUDES `quarantine inspect` / `quarantine resolve`, which the contract
 * authorizes via **`os-presence`** (an OS-mediated presence assertion bound to
 * the challenge, §7.1/§7.4) — **presence-gated signers excepted**: a signer
 * enrolled with `presence: true` (SP-3, only possible for a `p256` SE key) MAY
 * carry the two quarantine ops, because its per-use biometric ceremony IS the
 * presence assertion the contract requires. A plain file/derived key proves key
 * custody, not presence, so it never gets them — granting them would let an
 * ambient key authorize an op the contract reserves for os-presence. `git reject`
 * is likewise excluded — it is shared, not privileged. Consumed as the default
 * (non-presence) `permittedOps` when deriving the signer registry from
 * provisioned key files (round-3 finding 1); `enroll-signer.sh` adds the two
 * quarantine ops on top of this set iff `--presence` (SP-3 §7.1).
 */
export const SIGNATURE_AUTHORIZABLE_OPS = [
  "db restore",
  "git approve",
  "git refresh",
  "git rollback",
  "graduation migrate",
  "purge",
  "source trust promote",
  "source trust revoke",
  "db backup --force-unblock",
  "sync reset",
] as const;

/** The provisioning-generated key-file names (Task 1.0 / `keys.acl.json`). */
const PROVISIONED_FILES = {
  approverPub: "approval-verify.pub",
  attestationKey: "audit-attestation.key",
  attestationPub: "audit-attestation.pub",
  testApproverKey: "atlas-test-approver.key",
} as const;

/** A fixed enrollment timestamp for provisioning-derived registry entries. */
const PROVISIONED_ENROLLED_AT = "2026-07-01T00:00:00.000Z";

/** A non-empty PEM/`ed25519:` payload (skips the `touch`-seeded placeholders). */
function readKeyFileIfPresent(path: string): string | null {
  if (!existsSync(path)) return null;
  const raw = readFileSync(path, "utf8").trim();
  return raw.length === 0 ? null : raw;
}

/** The WORM anchor default path per OS (D8): outside the vault + repo. */
export function defaultAnchorPath(): string {
  return platform() === "darwin" ? "/usr/local/var/atlas/audit-anchor" : "/var/lib/atlas/audit-anchor";
}

/**
 * The single canonical-ref fallback (§3.1). The SOLE definition of the canonical
 * protected ref's default value — the CLI config default (`git.canonical_ref`) and
 * {@link DEFAULT_PROTECTED_REFS} both consume THIS constant, so the fallback lives
 * in exactly one place (60-A task 1.2a). Live-vault adoption overrides `canonical`
 * per config via `protectedRefsFor` (apps/cli); `audit`/`trust` are never overridable.
 */
export const DEFAULT_CANONICAL_REF = "refs/heads/main";

/** The default protected-ref set (§3.1). */
export const DEFAULT_PROTECTED_REFS: ProtectedRefs = {
  canonical: DEFAULT_CANONICAL_REF,
  audit: "refs/audit/runs",
  trust: "refs/trust/ledger",
};

/**
 * Load the signer registry. An explicit `<keysDir>/signers.json` (an array of
 * §9.2 entries) wins when present; OTHERWISE the registry is DERIVED from the
 * provisioning-generated key files (round-3 finding 1) so the broker runs
 * against exactly what Task-1.0 provisioning installs — no separate registry
 * file to keep in sync:
 *   - `approval-verify.pub`      → the enrolled approver (registry-privileged ops);
 *   - `audit-attestation.pub`    → the audit-attestation identity (no approval ops);
 *   - `atlas-test-approver.key`  → the fixture signer (D20-gated at verify time).
 * Placeholder (empty, `touch`-seeded) files are skipped.
 */
export function loadSignerRegistry(keysDir: string): SignerRegistryEntry[] {
  const explicit = join(keysDir, "signers.json");
  if (existsSync(explicit)) {
    const raw = JSON.parse(readFileSync(explicit, "utf8")) as unknown[];
    return raw.map((r) => SignerRegistryEntrySchema.parse(r));
  }
  return deriveSignerRegistryFromKeyFiles(keysDir);
}

/** Build the in-memory signer registry from provisioning-generated key files. */
export function deriveSignerRegistryFromKeyFiles(keysDir: string): SignerRegistryEntry[] {
  const entries: SignerRegistryEntry[] = [];

  const attPub = readKeyFileIfPresent(join(keysDir, PROVISIONED_FILES.attestationPub));
  if (attPub !== null) {
    entries.push({
      signerId: DEFAULT_ATTESTATION_SIGNER_ID,
      publicKey: serializePublicKey(parsePublicKeyFlexible(attPub)),
      permittedOps: [], // attestation signs the audit stream, never authorizations
      status: "active",
      enrolledAt: PROVISIONED_ENROLLED_AT,
    });
  }

  const approverPub = readKeyFileIfPresent(join(keysDir, PROVISIONED_FILES.approverPub));
  if (approverPub !== null) {
    entries.push({
      signerId: DEFAULT_APPROVER_SIGNER_ID,
      publicKey: serializePublicKey(parsePublicKeyFlexible(approverPub)),
      permittedOps: [...SIGNATURE_AUTHORIZABLE_OPS],
      status: "active",
      enrolledAt: PROVISIONED_ENROLLED_AT,
    });
  }

  // The ed25519 fixture signer is registered (so the D20 gate produces a precise
  // `authz.signer_not_permitted`+`d20` refusal rather than `signer_unknown`),
  // but the broker hard-rejects it outside ATLAS_TEST_MODE regardless.
  const testKey = readKeyFileIfPresent(join(keysDir, PROVISIONED_FILES.testApproverKey));
  if (testKey !== null) {
    entries.push({
      signerId: TEST_SIGNER_ID,
      publicKey: serializePublicKey(createPublicKey(parsePrivateKeyFlexible(testKey))),
      permittedOps: [...SIGNATURE_AUTHORIZABLE_OPS],
      status: "active",
      enrolledAt: PROVISIONED_ENROLLED_AT,
    });
  }

  // The SP-3 software-P256 fixture signer is registered UNCONDITIONALLY from the
  // shared descriptor's committed public key — it has no key FILE (SE keys expose
  // no broker-readable private key), so unlike the ed25519 fixture it does not
  // gate on a `.key` file being present. Registering it always is deliberate: the
  // D20 gate then yields the precise `d20` refusal (never `signer_unknown`) when
  // an `atlas-test-approver-p256` authorization is presented in production.
  entries.push({
    signerId: TEST_SIGNER_DESCRIPTOR.p256.signerId,
    alg: "p256",
    publicKey: TEST_SIGNER_DESCRIPTOR.p256.publicKey,
    permittedOps: [...SIGNATURE_AUTHORIZABLE_OPS],
    status: "active",
    enrolledAt: PROVISIONED_ENROLLED_AT,
  });

  return entries;
}

/**
 * Load the audit-attestation keypair from `<keysDir>/audit-attestation.key`
 * (native `ed25519:` OR provisioned OpenSSL PEM).
 */
export function loadAttestationKey(keysDir: string, signerId: string): AttestationKey {
  const path = join(keysDir, PROVISIONED_FILES.attestationKey);
  const priv = parsePrivateKeyFlexible(readFileSync(path, "utf8"));
  const pub = createPublicKey(priv);
  return { signerId, privateKey: priv, publicKey: pub };
}

/**
 * Assemble a `BrokerServiceConfig` from the environment (production path). Reads
 * `ATLAS_BROKER_KEYS_DIR`, the vault repo dir, the anchor path, and
 * `ATLAS_TEST_MODE` (D20). Missing required env is a hard error.
 */
export function loadBrokerConfigFromEnv(env: NodeJS.ProcessEnv = process.env): BrokerServiceConfig {
  const keysDir = env.ATLAS_BROKER_KEYS_DIR;
  if (keysDir === undefined) throw new Error("ATLAS_BROKER_KEYS_DIR is required");
  const repoDir = env.ATLAS_VAULT_REPO_DIR;
  if (repoDir === undefined) throw new Error("ATLAS_VAULT_REPO_DIR is required");
  // Anchor path defaults to the D8 per-OS location; overridable for tests/non-standard installs.
  const anchorPath = env.ATLAS_AUDIT_ANCHOR_PATH ?? defaultAnchorPath();

  const signers = loadSignerRegistry(keysDir);
  const attestation = loadAttestationKey(keysDir, DEFAULT_ATTESTATION_SIGNER_ID);

  return {
    repoDir,
    refs: DEFAULT_PROTECTED_REFS,
    anchorPath,
    signers,
    attestation,
    // D20: fixture signer usable ONLY when the env explicitly opts into test mode.
    testMode: env.ATLAS_TEST_MODE === "1",
  };
}

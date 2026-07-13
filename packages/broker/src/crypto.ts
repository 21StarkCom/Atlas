/**
 * Ed25519 + `atlas-jcs-v1` envelope crypto (security/broker contract §8).
 *
 * The broker verifies approval/authorization signatures and signs the audit
 * stream + WORM anchor. All signing is over the canonical byte string
 * (`atlas-jcs-v1`, from `@atlas/contracts`) so any two processes across the seam
 * sign/verify identical bytes. Keys serialize as `ed25519:<base64url(...)>`:
 * public keys carry the DER SPKI body, signatures the raw 64-byte value —
 * matching the contract's `ed25519:` envelope strings (§8.1).
 */
import {
  createPublicKey,
  createPrivateKey,
  generateKeyPairSync,
  sign as edSign,
  verify as edVerify,
  type KeyObject,
} from "node:crypto";
import { canonicalSerialize, CANONICALIZATION_ID, type SignedEnvelope } from "@atlas/contracts";

const PREFIX = "ed25519:";

/** Serialize an Ed25519 public key as `ed25519:<base64url(DER SPKI)>`. */
export function serializePublicKey(key: KeyObject): string {
  const der = key.export({ format: "der", type: "spki" });
  return PREFIX + Buffer.from(der).toString("base64url");
}

/** Parse an `ed25519:` public-key string back to a `KeyObject`. */
export function parsePublicKey(s: string): KeyObject {
  if (!s.startsWith(PREFIX)) {
    throw new Error(`not an ed25519 public key: ${s.slice(0, 16)}…`);
  }
  const der = Buffer.from(s.slice(PREFIX.length), "base64url");
  return createPublicKey({ key: der, format: "der", type: "spki" });
}

/** Parse an `ed25519:` PKCS#8 private-key string to a `KeyObject`. */
export function parsePrivateKey(s: string): KeyObject {
  if (!s.startsWith(PREFIX)) {
    throw new Error(`not an ed25519 private key: ${s.slice(0, 16)}…`);
  }
  const der = Buffer.from(s.slice(PREFIX.length), "base64url");
  return createPrivateKey({ key: der, format: "der", type: "pkcs8" });
}

/**
 * Parse a private key from EITHER serialization the deployment may hand us:
 * the package-native `ed25519:<base64url(DER PKCS#8)>` string, OR an OpenSSL
 * PEM file (`-----BEGIN PRIVATE KEY-----`, what Task-1.0 provisioning generates
 * via `openssl genpkey -algorithm ed25519`). Aligns the broker/test-signer key
 * loaders with the provisioned key format (round-3 finding 1).
 */
export function parsePrivateKeyFlexible(s: string): KeyObject {
  const t = s.trim();
  if (t.startsWith(PREFIX)) return parsePrivateKey(t);
  return createPrivateKey({ key: t, format: "pem" });
}

/**
 * Parse a public key from EITHER the native `ed25519:<base64url(DER SPKI)>`
 * string OR an OpenSSL PEM (`-----BEGIN PUBLIC KEY-----`, from `openssl pkey
 * -pubout`). Provisioning emits `.pub` files in PEM; the in-memory signer
 * registry uses the `ed25519:` form (round-3 finding 1).
 */
export function parsePublicKeyFlexible(s: string): KeyObject {
  const t = s.trim();
  if (t.startsWith(PREFIX)) return parsePublicKey(t);
  return createPublicKey({ key: t, format: "pem" });
}

/** Serialize an Ed25519 private key as `ed25519:<base64url(DER PKCS#8)>`. */
export function serializePrivateKey(key: KeyObject): string {
  const der = key.export({ format: "der", type: "pkcs8" });
  return PREFIX + Buffer.from(der).toString("base64url");
}

/** A freshly minted Ed25519 keypair as serialized `ed25519:` strings + objects. */
export interface GeneratedKeyPair {
  readonly publicKey: KeyObject;
  readonly privateKey: KeyObject;
  readonly publicKeyString: string;
  readonly privateKeyString: string;
}

/** Generate an Ed25519 keypair (used by provisioning fixtures + the test signer). */
export function generateEd25519(): GeneratedKeyPair {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  return {
    publicKey,
    privateKey,
    publicKeyString: serializePublicKey(publicKey),
    privateKeyString: serializePrivateKey(privateKey),
  };
}

/** Sign raw bytes, returning an `ed25519:<base64url(64-byte sig)>` string. */
export function signBytes(data: Uint8Array, privateKey: KeyObject): string {
  const sig = edSign(null, data, privateKey);
  return PREFIX + Buffer.from(sig).toString("base64url");
}

/** Verify an `ed25519:` signature string over raw bytes. */
export function verifyBytes(data: Uint8Array, signature: string, publicKey: KeyObject): boolean {
  if (!signature.startsWith(PREFIX)) return false;
  let sig: Buffer;
  try {
    sig = Buffer.from(signature.slice(PREFIX.length), "base64url");
  } catch {
    return false;
  }
  // Ed25519 signatures are exactly 64 bytes; anything else is malformed.
  if (sig.length !== 64) return false;
  try {
    return edVerify(null, data, publicKey, sig);
  } catch {
    return false;
  }
}

/** Verify a raw 64-byte Ed25519 signature (as held by `SignedAuditEvent`). */
export function verifyRaw(data: Uint8Array, signature: Uint8Array, publicKey: KeyObject): boolean {
  if (signature.length !== 64) return false;
  try {
    return edVerify(null, data, publicKey, signature);
  } catch {
    return false;
  }
}

/** Sign raw bytes to a raw 64-byte Ed25519 signature (as held by `SignedAuditEvent`). */
export function signRaw(data: Uint8Array, privateKey: KeyObject): Uint8Array {
  return edSign(null, data, privateKey);
}

/** Wrap a payload in a signed `atlas-jcs-v1` envelope (§8.1). */
export function signEnvelope(
  payload: Record<string, unknown>,
  signerId: string,
  privateKey: KeyObject,
): SignedEnvelope {
  const signature = signBytes(canonicalSerialize(payload), privateKey);
  return { payload, signature, signerId, canonicalization: CANONICALIZATION_ID };
}

/**
 * Verify a signed envelope's signature over the canonical bytes of its payload.
 * Rejects an unknown canonicalization id (§8.2 rule 5: the signature +
 * canonicalization fields are themselves excluded from the signed bytes).
 */
export function verifyEnvelope(env: SignedEnvelope, publicKey: KeyObject): boolean {
  if (env.canonicalization !== CANONICALIZATION_ID) return false;
  return verifyBytes(canonicalSerialize(env.payload), env.signature, publicKey);
}

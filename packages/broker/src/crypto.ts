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
  sign as ecSign,
  verify as edVerify,
  verify as ecVerify,
  type KeyObject,
} from "node:crypto";
import { canonicalSerialize, CANONICALIZATION_ID, type SignedEnvelope } from "@atlas/contracts";

const PREFIX = "ed25519:";
const P256_PREFIX = "p256:";

/**
 * The maximum raw byte length of a P-256 ECDSA-SHA256 DER X9.62 signature
 * (ADR-0002 / spec §5.2). Observed 70–72 bytes across runs; the verifier BOUNDS
 * it rather than pinning it (DER length is variable). Anything longer is refused
 * before `crypto.verify` ever sees it — a cheap fail-closed cap on attacker-sized
 * bodies, not a canonicalization claim (we verify, never byte-compare, §13/ADR).
 */
const P256_MAX_DER_SIG_BYTES = 72;

/** The P-256 named curve as Node reports it in `asymmetricKeyDetails`. */
const P256_CURVE = "prime256v1";

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

// ---------------------------------------------------------------------------
// P-256 / ECDSA-SHA256 authorization signatures (SP-3, ADR-0002).
//
// Additive alongside Ed25519: authorization RESPONSES may carry a `p256:` DER
// X9.62 signature over the SAME §8.2 `signingPayload` bytes. The seam is
// zero-transformation — Apple `.ecdsaSignatureMessageX962SHA256` / CryptoKit
// `signature(for:).derRepresentation` emit DER, and Node's `crypto.verify`
// `dsaEncoding` defaults to `"der"` with SPKI-PEM keys — so nothing is re-encoded.
// The audit stream + WORM anchor stay Ed25519-only (§8.1); this is response-only.
// ---------------------------------------------------------------------------

/**
 * Parse a P-256 public key from EITHER an SPKI PEM (`-----BEGIN PUBLIC KEY-----`,
 * what `openssl pkey -pubout` and CryptoKit `pemRepresentation` emit) OR the
 * native `p256:<base64url(DER SPKI)>` string. Rejects a non-EC key (RSA, Ed25519)
 * and a non-P-256 curve (P-384, secp256k1) — fail-closed: any parse/shape error
 * throws, so `parseP256PublicKeyFlexible` NEVER returns a wrong-curve key.
 */
export function parseP256PublicKeyFlexible(s: string): KeyObject {
  const t = s.trim();
  let key: KeyObject;
  if (t.startsWith(P256_PREFIX)) {
    const der = Buffer.from(t.slice(P256_PREFIX.length), "base64url");
    key = createPublicKey({ key: der, format: "der", type: "spki" });
    // Reject a non-canonical / trailing-garbage body: Node's DER reader tolerates
    // extra bytes after a well-formed SPKI, so a `p256:<valid>TRAILING` string
    // would otherwise parse. Re-export the parsed key and require it to byte-equal
    // the decoded input — any trailing bytes (or non-canonical base64url) make the
    // re-encoding shorter/different and fail-close here (spec §10 rejection case).
    const reDer = key.export({ format: "der", type: "spki" });
    if (Buffer.compare(Buffer.from(reDer), der) !== 0) {
      throw new Error("non-canonical P-256 SPKI (trailing or malformed bytes)");
    }
  } else {
    key = createPublicKey({ key: t, format: "pem" });
  }
  if (key.asymmetricKeyType !== "ec") {
    throw new Error(`not a P-256 key: asymmetricKeyType=${String(key.asymmetricKeyType)}`);
  }
  const curve = key.asymmetricKeyDetails?.namedCurve;
  if (curve !== P256_CURVE) {
    throw new Error(`not a P-256 key: namedCurve=${String(curve)}`);
  }
  return key;
}

/** Serialize a P-256 public key as `p256:<base64url(DER SPKI)>` (native form). */
export function serializeP256PublicKey(key: KeyObject): string {
  const der = key.export({ format: "der", type: "spki" });
  return P256_PREFIX + Buffer.from(der).toString("base64url");
}

/**
 * Verify a `p256:` ECDSA-SHA256 DER signature string over raw bytes. Fail-closed
 * on EVERY error (mirrors `verifyBytes`): wrong prefix, non-base64url body,
 * oversized-past-72-byte DER, malformed/non-DER, or a `crypto.verify` throw all
 * return `false`. Uses Node's default DER `dsaEncoding` (no option needed).
 *
 * Deliberately does NOT enforce low-S canonicalization — Apple does not normalize
 * S, so a high-S `(r, n−s)` twin of a valid signature still verifies `true`
 * (ADR-0002: "verify, never byte-compare"). The `publicKey` MUST already be a
 * validated P-256 key (via {@link parseP256PublicKeyFlexible}).
 */
export function verifyP256Bytes(data: Uint8Array, signature: string, publicKey: KeyObject): boolean {
  if (!signature.startsWith(P256_PREFIX)) return false;
  let sig: Buffer;
  try {
    sig = Buffer.from(signature.slice(P256_PREFIX.length), "base64url");
  } catch {
    return false;
  }
  // A real P-256 DER signature is 70–72 bytes; bound it so an oversized body
  // never reaches the verifier. (Empty/too-short bodies fail verify anyway.)
  if (sig.length === 0 || sig.length > P256_MAX_DER_SIG_BYTES) return false;
  try {
    return ecVerify("sha256", data, publicKey, sig);
  } catch {
    return false;
  }
}

/**
 * Sign raw bytes with a P-256 private key, returning a `p256:<base64url(DER)>`
 * string over ECDSA-SHA256. Node's default `dsaEncoding` is DER, matching what
 * Apple emits and {@link verifyP256Bytes} expects — the fixture-signer analogue
 * of the SE `atlas-signer`'s `signature(for:).derRepresentation`.
 */
export function signP256Bytes(data: Uint8Array, privateKey: KeyObject): string {
  const sig = ecSign("sha256", data, privateKey);
  return P256_PREFIX + Buffer.from(sig).toString("base64url");
}

/** A freshly minted P-256 keypair (used by fixtures + the p256 test signer). */
export interface GeneratedP256KeyPair {
  readonly publicKey: KeyObject;
  readonly privateKey: KeyObject;
  /** `p256:<base64url(DER SPKI)>` native public-key string. */
  readonly publicKeyString: string;
  /** SPKI PEM public key (the enrollment interchange form). */
  readonly publicKeyPem: string;
  /** PKCS#8 PEM private key (fixture-only; SE keys never expose this). */
  readonly privateKeyPem: string;
}

/** Generate a software P-256 keypair (CI/test fixture; the SE analogue is `atlas-signer`). */
export function generateP256(): GeneratedP256KeyPair {
  const { publicKey, privateKey } = generateKeyPairSync("ec", { namedCurve: P256_CURVE });
  return {
    publicKey,
    privateKey,
    publicKeyString: serializeP256PublicKey(publicKey),
    publicKeyPem: publicKey.export({ format: "pem", type: "spki" }).toString(),
    privateKeyPem: privateKey.export({ format: "pem", type: "pkcs8" }).toString(),
  };
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

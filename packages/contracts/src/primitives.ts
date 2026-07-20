/**
 * Shared primitive Zod schemas mirroring the string shapes fixed by the
 * security/broker contract. Kept lenient exactly where the contract's own JSON
 * examples use truncated placeholders (`ed25519:1f8a3c...a0`,
 * `sha256:3f9a...c012`) so those examples validate — a `contracts.authorization`
 * acceptance target.
 */
import { z } from "zod";
import { ULID_RE, OPAQUE_ID_RE } from "./ids.js";

/** ULID (run id, event id). */
export const Ulid = z.string().regex(ULID_RE, "must be a ULID");

/** Opaque salted id (`n_…` / `s_…`, contract §5.1). */
export const OpaqueId = z.string().regex(OPAQUE_ID_RE, "must be an opaque salted id");

/** Git commit hash (V1 is SHA-1: 40 lowercase hex). */
export const CommitHash = z.string().regex(/^[0-9a-f]{40}$/, "must be a 40-char hex commit hash");

/** RFC-3339 UTC timestamp with millisecond precision, ending `Z` (contract §8.2). */
export const Rfc3339Ms = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/, "must be an RFC-3339 UTC ms timestamp ending Z");

/** 128-bit nonce as 32 lowercase hex chars (contract §9.1). */
export const Nonce = z.string().regex(/^[0-9a-f]{32}$/, "must be a 128-bit hex nonce");

/**
 * Ed25519 signature envelope string. Lenient (`^ed25519:`) because the contract
 * examples truncate the base64url body with `...`.
 */
export const Ed25519Sig = z.string().regex(/^ed25519:/, 'must be an "ed25519:" signature');

/** Ed25519 public key string, same lenient rule as the signature. */
export const Ed25519PubKey = z.string().regex(/^ed25519:/, 'must be an "ed25519:" public key');

/**
 * P-256 (ECDSA) authorization-signature string (SP-3 / ADR-0002): a base64url
 * DER X9.62 signature body prefixed `p256:`. Lenient prefix-only, matching the
 * `Ed25519Sig` posture — the real DER decode + length bound + curve check happen
 * fail-closed in the broker verifier (`verifyP256Bytes`), never here.
 */
export const P256Sig = z.string().regex(/^p256:/, 'must be a "p256:" signature');

/** P-256 public key native string (`p256:<base64url(DER SPKI)>`), lenient prefix-only. */
export const P256PubKey = z.string().regex(/^p256:/, 'must be a "p256:" public key');

/**
 * The prefix-discriminated authorization-signature union (SP-3): an
 * `ed25519:` raw-64 signature OR a `p256:` DER signature. Both members are pure
 * prefix regexes, so a plain union is unambiguous; the broker resolves the
 * enrolled signer's `alg` and rejects a prefix that disagrees with it
 * (`authz.signature_invalid`). The audit stream + WORM anchor stay Ed25519-only
 * (§8.1) — this union is for authorization responses only.
 */
export const AuthzSignature = z.union([Ed25519Sig, P256Sig]);

/**
 * A signer-registry public-key string (SP-3-widened, §9.2): the Ed25519 native
 * form (`ed25519:<base64url(DER SPKI)>`), the P-256 native form
 * (`p256:<base64url(DER SPKI)>`), OR an SPKI PEM (`-----BEGIN PUBLIC KEY-----`,
 * what `openssl pkey -pubout` and CryptoKit `pemRepresentation` emit). Lenient by
 * design — the broker parses + validates the key shape against the entry's `alg`
 * at load (`parsePublicKeyFlexible` / `parseP256PublicKeyFlexible`), never a regex
 * here (mirrors the existing `Ed25519PubKey` leniency precedent).
 */
export const PublicKeyString = z
  .string()
  .regex(/^(ed25519:|p256:|-----BEGIN PUBLIC KEY-----)/, "must be an ed25519:/p256: or SPKI-PEM public key");

/** A `sha256:` content digest (lenient body — contract examples truncate it). */
export const Sha256Digest = z.string().regex(/^sha256:/, 'must be a "sha256:" digest');

/** Schema-version discriminator, currently pinned to 1 across the contract. */
export const SchemaVersion1 = z.literal(1);

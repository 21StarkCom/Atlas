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

/** A `sha256:` content digest (lenient body — contract examples truncate it). */
export const Sha256Digest = z.string().regex(/^sha256:/, 'must be a "sha256:" digest');

/** Schema-version discriminator, currently pinned to 1 across the contract. */
export const SchemaVersion1 = z.literal(1);

/**
 * Identity-key canonicalization (Task 1.3).
 *
 * The versioned algorithm (`atlas-identity-key-v1`) and its conformance vectors
 * are owned by the dependency-free `@atlas/contracts` leaf (§2.7 / D14) so every
 * process across the seam folds identifiers identically. This module does NOT
 * own a private normalization — it re-exports the one implementation so callers
 * inside the CLI keep a stable local import path.
 */
export {
  normalizeIdentityKey,
  IDENTITY_KEY_ALGORITHM_ID,
  IDENTITY_KEY_VECTORS,
  type IdentityKeyVector,
} from "@atlas/contracts";

/**
 * `@atlas/scan` — the fail-closed secret-scan leaf (second workspace leaf after
 * `@atlas/contracts`, plan §2.5). Owns the deterministic versioned scan engine and
 * the two enforcement guards; consumes ONLY `@atlas/contracts` (structural types),
 * so `@atlas/sources`, the `@atlas/broker` egress side, and `apps/cli` all import
 * scanning WITHOUT an `apps/cli` back-edge (D14 no-app-import invariant).
 *
 * The quarantine STORE (AEAD, key custody, retention, crash-safe purge) is
 * deliberately NOT here — it is CLI-side (`apps/cli/src/quarantine/store.ts`) and
 * implements the structural {@link QuarantineSink} the guards require, so the leaf
 * never imports the app.
 */

// Structural types + the quarantine seam + the refusal error
export {
  type PersistenceSink,
  type ScanContext,
  type FindingSeverity,
  type SecretFinding,
  type ScanVerdict,
  type QuarantineSink,
  SecretDetectedError,
} from "./types.js";

// The deterministic versioned engine
export { scanBytes, RULESET_ID, RULESET_VERSION } from "./engine.js";

// The two enforcement points (guards take an injected QuarantineSink)
export { PrePersistenceGuard } from "./pre-persistence.js";
export { GeneratedArtifactGuard } from "./generated-artifact.js";

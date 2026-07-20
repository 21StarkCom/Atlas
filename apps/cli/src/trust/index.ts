/**
 * `trust` — the trust lifecycle + taint core (Task 4.8): fail-closed trust-state
 * resolution, transitive taint (the 4.5 `inputsTrusted` seam), and revocation semantics
 * (fail pre-integration / remediate post-integration). The broker-authorized
 * `source trust promote|revoke` ledger advance is built with the git-surface authorization
 * machinery (Task 4.9/4.11).
 */
export { trustStateFor, isTrusted, DEFAULT_TRUST, type TrustState } from "./state.js";
export { taintOf, type Taint } from "./taint.js";
export {
  promoteTrust,
  revokeTrust,
  readTrustState,
  readTrustRecord,
  TrustError,
  type TrustTarget,
  type TrustDeps,
  type TrustRecord,
} from "./promote.js";
export {
  revocationEffect,
  spawnRemediationRun,
  REMEDIATION_WORKFLOW,
  type RevocationEffect,
  type RemediationJobPayload,
} from "./revoke.js";

/**
 * `trust/state` — trust-state resolution (Task 4.8). A source's trust lives on the
 * broker-advanced `refs/trust/ledger` and is projected to SQLite; this module reads that
 * state through an injected resolver seam and applies the FAIL-CLOSED default: an unknown
 * or unprojected source is `untrusted` (design §Trust — nothing is trusted until it is
 * explicitly promoted via a broker-authorized `PromoteTrust`). The privileged
 * `source trust promote|revoke` command that ADVANCES the ledger (challenge/authorization,
 * bound to `sourceId`+`rawContentHash`) is the broker-authorized surface built with the
 * git-surface authorization machinery (Task 4.9/4.11); this module is the read/decision core.
 */
import type { TrustLevel } from "@atlas/contracts";

/** A source's effective trust state (level + whether a revocation has suspended it). */
export interface TrustState {
  readonly level: TrustLevel;
  /** `true` when a revocation has suspended the source pending remediation. */
  readonly suspended: boolean;
}

/** The fail-closed default for an unknown/unprojected source (nothing is trusted by default). */
export const DEFAULT_TRUST: TrustState = { level: "untrusted", suspended: false };

/**
 * Whether a source is TRUSTED for grounding: a non-suspended `trusted`/`authoritative`
 * level. `provisional` and `untrusted` are NOT trusted (a provisional source may back a
 * proposal but never lets it auto-commit) — and any suspension drops trust to false.
 */
export function isTrusted(state: TrustState): boolean {
  return !state.suspended && (state.level === "trusted" || state.level === "authoritative");
}

/**
 * Resolve the trust state for a source handle, FAIL-CLOSED: the injected `resolve` reads
 * the projected trust ledger; a `null` (unknown/unprojected source) yields
 * {@link DEFAULT_TRUST} (untrusted). Never throws — an unresolvable source is untrusted,
 * never an error that could be mistaken for trusted.
 */
export function trustStateFor(handle: string, resolve: (handle: string) => TrustState | null): TrustState {
  return resolve(handle) ?? DEFAULT_TRUST;
}

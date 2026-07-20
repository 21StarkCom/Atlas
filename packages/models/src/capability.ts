/**
 * CLI-side capability minting (D19). Wraps the egress-side `mintEgressCapability`
 * so a run mints its short-lived, run-bound capability through the
 * provider-interface signature `mintEgressCapability(run, limits)` — the mint
 * secret is resolved from PRODUCTION CUSTODY, not passed by the caller.
 *
 * ## Custody (fixes the "required third secret argument" + "no production custody
 * accessor" finding)
 * The capability-MAC secret is a shared secret: the CLI reads it to MINT, the egress
 * broker reads the SAME value to VERIFY. It is therefore NOT held in the
 * `atlas-egress`-only `0700` keys dir (which the CLI cannot read); it lives at a
 * CLI-readable custody path fixed by {@link CAPABILITY_KEY_ENV} (a shared-secret file
 * the launcher provisions readable by both identities) — or, for the launchd sync
 * wrapper, on a command-scoped file descriptor named by {@link CAPABILITY_KEY_FD_ENV}
 * (#60 Phase 6: Keychain-fetched at job start, never written to disk, never in the
 * environment). Both forms resolve through the one shared
 * {@link resolveCapabilitySecret} in `@atlas/broker`, so the minting and verifying
 * ends can never disagree about the representation. {@link mintEgressCapability}
 * reaches it through the injectable {@link setCapabilityMintSecretResolver}
 * accessor, so the caller passes only `(run, limits)`. A test may inject an explicit
 * `secret` (third arg) or set a resolver.
 */
import {
  resolveCapabilitySecret,
  CAPABILITY_KEY_ENV,
  CAPABILITY_KEY_FD_ENV,
  mintEgressCapability as mintEgressCapabilityWithSecret,
  DEFAULT_CAPABILITY_KEY_ID,
  DEFAULT_CAPABILITY_TTL_SECONDS,
  SENSITIVITY_ORDER,
  EGRESS_OPERATIONS,
  type EgressCapability,
  type EgressLimits,
  type EgressOperation,
  type CapabilitySensitivity,
  type RunBinding,
} from "@atlas/broker";

/** Resolves the capability-MAC mint secret from custody. Injectable for tests. */
export type CapabilityMintSecretResolver = () => Buffer | string;

/**
 * Default custody accessor: the shared fd-or-path resolver. Fail-closed — an absent,
 * unreadable, or empty secret throws rather than minting with a degraded key.
 */
function defaultResolver(): Buffer | string {
  return resolveCapabilitySecret();
}

let resolver: CapabilityMintSecretResolver = defaultResolver;

/** Inject the custody accessor (production launcher / tests). Reset to the default with no arg. */
export function setCapabilityMintSecretResolver(next?: CapabilityMintSecretResolver): void {
  resolver = next ?? defaultResolver;
}

/**
 * Mint a run-bound egress capability (D19) with the provider-interface signature
 * `mintEgressCapability(run, limits)`. The mint secret comes from production custody
 * (see {@link setCapabilityMintSecretResolver}); `opts` is optional and lets a test
 * inject an explicit `secret`/`keyId`/`now`/`nonce`.
 */
export function mintEgressCapability(
  run: RunBinding,
  limits: EgressLimits,
  opts: { secret?: Buffer | string; keyId?: string; now?: () => Date; nonce?: string } = {},
): EgressCapability {
  const secret = opts.secret ?? resolver();
  return mintEgressCapabilityWithSecret(run, limits, {
    secret,
    ...(opts.keyId !== undefined ? { keyId: opts.keyId } : {}),
    ...(opts.now !== undefined ? { now: opts.now } : {}),
    ...(opts.nonce !== undefined ? { nonce: opts.nonce } : {}),
  });
}

export {
  CAPABILITY_KEY_ENV,
  CAPABILITY_KEY_FD_ENV,
  DEFAULT_CAPABILITY_KEY_ID,
  DEFAULT_CAPABILITY_TTL_SECONDS,
  SENSITIVITY_ORDER,
  EGRESS_OPERATIONS,
  type EgressCapability,
  type EgressLimits,
  type EgressOperation,
  type CapabilitySensitivity,
  type RunBinding,
};

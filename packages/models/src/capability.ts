/**
 * CLI-side capability minting (D19). Wraps the egress-side `mintEgressCapability`
 * so a run mints its short-lived, run-bound capability through the
 * provider-interface signature `mintEgressCapability(run, limits)` — the mint
 * secret is resolved from PRODUCTION CUSTODY, not passed by the caller.
 *
 * ## Custody (fixes the "required third secret argument" + "no production custody
 * accessor" finding)
 * The capability-MAC secret is a shared secret: the CLI reads it to MINT, the egress
 * broker reads the SAME file to VERIFY. It is therefore NOT held in the
 * `atlas-egress`-only `0700` keys dir (which the CLI cannot read); it lives at a
 * CLI-readable custody path fixed by {@link CAPABILITY_KEY_ENV} (a shared-secret file
 * the launcher provisions readable by both identities). {@link mintEgressCapability}
 * resolves it through the injectable {@link setCapabilityMintSecretResolver}
 * accessor (default: read `CAPABILITY_KEY_ENV`), so the caller passes only `(run,
 * limits)`. A test may inject an explicit `secret` (third arg) or set a resolver.
 */
import { readFileSync } from "node:fs";
import {
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

/**
 * The env var naming the CLI-readable capability-MAC secret file (shared with the
 * egress broker; NOT the `atlas-egress`-only keys dir). The file holds the raw
 * secret (base64 or utf8); the launcher provisions it readable by the CLI + egress.
 */
export const CAPABILITY_KEY_ENV = "ATLAS_EGRESS_CAPABILITY_KEY";

/** Resolves the capability-MAC mint secret from custody. Injectable for tests. */
export type CapabilityMintSecretResolver = () => Buffer | string;

/** Default custody accessor: read the CLI-readable secret file named by {@link CAPABILITY_KEY_ENV}. */
function defaultResolver(): Buffer | string {
  const path = process.env[CAPABILITY_KEY_ENV];
  if (path === undefined || path.length === 0) {
    throw new Error(
      `${CAPABILITY_KEY_ENV} is not set — cannot resolve the capability mint secret from custody (pass an explicit { secret } in tests)`,
    );
  }
  return readFileSync(path, "utf8").trim();
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

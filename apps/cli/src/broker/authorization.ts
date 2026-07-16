/**
 * `broker/authorization` — the CLI side of the broker challenge/authorization flow (Task 4.9).
 * A privileged op (`git approve|rollback`, `source trust promote|revoke`, `purge --apply`) is
 * gated by an OS-presence assertion bound to a broker challenge, or the non-interactive
 * `--export-challenge → sign → --authorization` flow (security-broker-contract.md §7). `--yes`
 * NEVER authorizes.
 *
 * This module constructs the {@link AuthorizationResponse} from a broker-minted challenge + a
 * signer, and exposes the signer seam. The broker RE-VERIFIES the response (signature, nonce,
 * drift) on `execAuthorized`/`advanceProtectedRef` — the CLI never trusts its own construction;
 * a forged/replayed/drifted authorization is refused broker-side (proven by the broker's
 * `authorize` + `approval-boundary.adversarial` suites).
 */
import { signBytes } from "@atlas/broker";
import type { AuthorizationChallenge, AuthorizationResponse } from "@atlas/contracts";

const ENCODER = new TextEncoder();

/** Signs a challenge's canonical `signingPayload` bytes (an enrolled approver key / hardware token). */
export type ChallengeSigner = (signingPayloadBytes: Uint8Array) => string;

/**
 * Build a signer from a raw Ed25519 private key (the non-interactive `--authorization` flow: an
 * approver signs the exported challenge out of band with an enrolled key). Production may instead
 * bind an OS-presence / hardware-backed signer here.
 */
export function keySigner(privateKey: Parameters<typeof signBytes>[1]): ChallengeSigner {
  return (bytes) => signBytes(bytes, privateKey);
}

/**
 * Construct the {@link AuthorizationResponse} for a broker-minted `challenge` by signing its
 * canonical signing payload. The result is submitted to the broker (`execAuthorized` /
 * `advanceProtectedRef`), which re-verifies it — this only assembles the envelope.
 */
export function buildAuthorization(challenge: AuthorizationChallenge, signerId: string, sign: ChallengeSigner): AuthorizationResponse {
  return {
    schemaVersion: 1,
    challenge,
    signature: sign(ENCODER.encode(challenge.signingPayload)),
    signerId,
  } as AuthorizationResponse;
}

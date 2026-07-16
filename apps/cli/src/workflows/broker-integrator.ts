/**
 * `workflows/broker-integrator` — the PRODUCTION synthesis/approve canonical-install integrator
 * (Task 4.9/4.11), built on the broker's `signAndAdvanceProtectedRef` (the keystone general-scope
 * sign-and-advance). It turns the engine's allocated UNSIGNED `run.integrated` event into a real
 * canonical install: the broker signs it internally (the CLI never holds the attestation key),
 * verifies the Tier-3 authorization (when present) + audit-event binding, and advances canonical
 * under CAS. A `broker.cas_failed` refusal propagates unchanged so the caller rebases + retries.
 *
 * This is what replaces the injected test seam the 4.5 apply / 4.9 approve paths used: the same
 * `RunIntegrator` shape, now backed by the real broker.
 */
import type { BrokerClient } from "@atlas/broker";
import type { AuthorizationResponse, IntendedEffect, RunManifest } from "@atlas/contracts";
import type { BrokerIntegration, IntegrationContext, RunIntegrator } from "./index.js";

function rfc3339Ms(): string {
  return new Date().toISOString();
}

/** Options binding an approve/rollback advance to its Tier-3 authorization (absent for Tier-2 auto). */
export interface BrokerIntegratorAuth {
  readonly authorization: AuthorizationResponse;
  readonly op: string;
  readonly intendedEffect: IntendedEffect;
}

/**
 * Build the production {@link RunIntegrator} backed by `client.signAndAdvanceProtectedRef`. For a
 * Tier-2 auto-integrate `auth` is omitted; for a Tier-3 `git approve` it carries the reviewer
 * authorization (the broker re-verifies it before canonical moves). The unsigned `run.integrated`
 * event the engine allocated is submitted as-is — the broker fills `prevAuditHead` + signs it.
 */
export function makeBrokerIntegrator(client: BrokerClient, auth?: BrokerIntegratorAuth, now: () => string = rfc3339Ms): RunIntegrator {
  return async (ctx: IntegrationContext): Promise<BrokerIntegration> => {
    const manifest: RunManifest = {
      schemaVersion: 1,
      runId: ctx.runId,
      state: "integrated",
      createdAt: now(),
      canonicalBaseCommit: ctx.baseRef,
      targets: [],
    };
    const res = await client.signAndAdvanceProtectedRef({
      ref: ctx.canonicalRef,
      expectedOld: ctx.baseRef,
      newCommit: ctx.commitSha,
      manifest,
      ...(auth !== undefined ? { authorization: auth.authorization, authorizedOp: { op: auth.op, intendedEffect: auth.intendedEffect } } : {}),
      event: ctx.event,
    });
    return { canonicalRef: res.ref, canonicalSha: res.newCommit, seq: res.seq, auditHead: res.auditHead };
  };
}

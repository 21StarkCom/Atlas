/**
 * `workflows/broker-integrator` — the synthesis/approve canonical-install integrator
 * (Task 4.9/4.11), the `RunIntegrator` consumed by enrich/reconcile/maintain/
 * git-refresh (Tier-2 auto-integrate) and git approve / evidence resolve (Tier-3).
 * It turns the engine's allocated UNSIGNED `run.integrated` event into a canonical
 * install by handing it to `client.signAndAdvanceProtectedRef`.
 *
 * The `client` is whatever implements that one method — a socket-connected
 * `BrokerClient` (the Tier-3 privileged paths still route through the broker) OR the
 * in-process client ({@link import("./in-process-broker.js").makeInProcessBrokerClient},
 * ADR-0003) that FF-advances `git.canonical_ref` daemon-free and drops the
 * attestation-signed `refs/audit/runs` append + WORM anchor. The seam signature is
 * unchanged, so no call site changes — only which client the caller constructs. A
 * `broker.cas_failed` refusal propagates unchanged so the caller rebases + retries.
 */
import type { AuthorizationResponse, IntendedEffect, RunManifest } from "@atlas/contracts";
import type { RefAdvanceResult, SignAndAdvanceRequest } from "@atlas/broker";
import type { BrokerIntegration, IntegrationContext, RunIntegrator } from "./index.js";

function rfc3339Ms(): string {
  return new Date().toISOString();
}

/**
 * The one client method the `RunIntegrator` seam consumes: the general-scope
 * sign-and-advance. A structural type so BOTH the socket `BrokerClient` and the
 * in-process client satisfy it — the call sites pass whichever they built, unchanged.
 */
export interface RefAdvanceClient {
  signAndAdvanceProtectedRef(r: SignAndAdvanceRequest): Promise<RefAdvanceResult>;
}

/** Options binding an approve/rollback advance to its Tier-3 authorization (absent for Tier-2 auto). */
export interface BrokerIntegratorAuth {
  readonly authorization: AuthorizationResponse;
  readonly op: string;
  readonly intendedEffect: IntendedEffect;
}

/**
 * Build the {@link RunIntegrator} backed by `client.signAndAdvanceProtectedRef`. For a
 * Tier-2 auto-integrate `auth` is omitted; for a Tier-3 `git approve` it carries the reviewer
 * authorization (a broker client re-verifies it before canonical moves; the in-process client
 * ignores it — Tier-3 stays broker-routed this phase). The unsigned `run.integrated` event the
 * engine allocated is submitted as-is — the client fills `prevAuditHead` (broker) or drops the
 * append entirely (in-process).
 */
export function makeBrokerIntegrator(client: RefAdvanceClient, auth?: BrokerIntegratorAuth, now: () => string = rfc3339Ms): RunIntegrator {
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

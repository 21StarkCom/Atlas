/**
 * `workflows/integrate` — the synthesis canonical-install seam (Task 4.5, slice B).
 *
 * A synthesis run that clears its Tier-2 gate auto-integrates: its agent commit is
 * fast-forwarded onto the canonical protected ref under CAS, accompanied by the
 * `run.integrated` audit event. Unlike a Tier-1 source capture — which the broker
 * scope-checks to `sources/**` and signs internally via `signAndIntegrateSourceCapture`
 * — a synthesis install touches note files anywhere in the vault, so it rides the
 * GENERAL privileged canonical advance (`advanceProtectedRef`) the plan (§4.5) names.
 *
 * `run.integrated` is a canonical-INSTALLING kind: the broker's generic
 * `signAndAppendAuditEvent` path REFUSES to sign it (`broker.audit_kind_not_signable`)
 * and the ledger-side `finalizeLedgerWrite` never carries it (see engine.ts
 * `RunHandle.integrate`). So the event must be signed with the audit-attestation key
 * and its `prevAuditHead` bound to the live audit head — both of which only the broker
 * holds. This factory therefore takes the two privileged operations as SEAMS:
 *   - `advanceProtectedRef` — the broker's CAS ref-advance RPC (Task 1.6);
 *   - `sign` — turn the engine-allocated UNSIGNED `run.integrated` event into a
 *     {@link SignedAuditEvent}, filling `prevAuditHead` from the live audit head.
 *
 * PRODUCTION WIRING (Task 4.11): the CLI cannot hold the attestation key (the Phase-2
 * exit test proves a forged-signature `advanceProtectedRef` is refused). Wiring `sign`
 * for real therefore requires a broker-internal sign-and-advance RPC — the general-scope
 * analogue of `signAndIntegrateSourceCapture` — which the command surface (4.11) adds.
 * Until then this seam is exercised by the workflow e2e with the harness attestation key.
 *
 * A `broker.cas_failed` refusal — canonical advanced between plan and commit —
 * propagates unchanged so {@link import("./synthesis.js").applySynthesis} can rebase,
 * regenerate, and revalidate (§4.5 CAS-miss recovery).
 */
import type { RefAdvanceRequest, RefAdvanceResult } from "@atlas/broker";
import type { RunManifest, SignedAuditEvent } from "@atlas/contracts";
import type { UnsignedAuditEvent } from "@atlas/sqlite-store";
import type { BrokerIntegration, IntegrationContext, RunIntegrator } from "./index.js";

/** Sign the engine-allocated UNSIGNED `run.integrated` event (fills `prevAuditHead`). */
export type IntegratedEventSigner = (unsigned: UnsignedAuditEvent) => SignedAuditEvent | Promise<SignedAuditEvent>;

/** The privileged seams the synthesis integrator drives (both broker-held in production). */
export interface SynthesisIntegratorSeams {
  /** The broker CAS ref-advance RPC (`BrokerClient.advanceProtectedRef`). */
  advanceProtectedRef(req: RefAdvanceRequest): Promise<RefAdvanceResult>;
  /** Sign the allocated `run.integrated` event with the audit-attestation key. */
  sign: IntegratedEventSigner;
  now?: () => string;
}

function rfc3339Ms(): string {
  return new Date().toISOString();
}

/**
 * Build the {@link RunIntegrator} a Tier-2 synthesis run hands to
 * {@link import("./engine.js").RunHandle.integrate}. Given the engine's allocated
 * unsigned `run.integrated` event, it signs the event, fast-forwards canonical under
 * CAS via `advanceProtectedRef`, and returns the observed {@link BrokerIntegration}.
 * A `broker.cas_failed` refusal is left to propagate (the caller rebases + retries).
 */
export function makeSynthesisIntegrator(seams: SynthesisIntegratorSeams): RunIntegrator {
  const now = seams.now ?? rfc3339Ms;
  return async (ctx: IntegrationContext): Promise<BrokerIntegration> => {
    // The ref-advance manifest identifies the run + its canonical base (the broker
    // binds the authorization/audit event to `manifest.runId`); the ChangePlan-bearing
    // manifest is the one recorded on the AGENT COMMIT, not this ref-advance descriptor.
    const manifest: RunManifest = {
      schemaVersion: 1,
      runId: ctx.runId,
      state: "integrated",
      createdAt: now(),
      canonicalBaseCommit: ctx.baseRef,
      targets: [],
    };
    const signed = await seams.sign(ctx.event);
    const res = await seams.advanceProtectedRef({
      ref: ctx.canonicalRef,
      expectedOld: ctx.baseRef,
      newCommit: ctx.commitSha,
      manifest,
      auditEvent: signed,
    });
    return { canonicalRef: res.ref, canonicalSha: res.newCommit, seq: res.seq, auditHead: res.auditHead };
  };
}

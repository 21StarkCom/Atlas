/**
 * `models-client.test` — the typed IPC client surface. Every transmission emits a
 * receipt (success, refusal, OR provider error) BEFORE the method returns/throws,
 * so the CLI can write a `model_calls` row for each. A refusal throws
 * `EgressRefusal`; a provider fault throws `ProviderCallError` carrying the
 * discriminated `kind` + `retryAfterMs`.
 */
import { afterEach, describe, it, expect } from "vitest";
import { z } from "zod";
import { EgressRefusal, ProviderCallError } from "../src/index.js";
import type { ModelCallReceipt } from "../src/index.js";
import { createEgressHarness, fakeAdapter, runId, MODEL, type EgressHarness } from "./harness.js";
import { providerError } from "@atlas/broker";

let h: EgressHarness;
afterEach(() => h?.cleanup());

describe("ModelsClient", () => {
  it("generateText returns a typed result and emits a success receipt", async () => {
    h = await createEgressHarness();
    const rid = runId();
    const receipts: ModelCallReceipt[] = [];
    const client = h.client((r) => { receipts.push(r); });
    const res = await client.generateText({ model: MODEL, prompt: { ref: "p@1" }, input: "hi", maxTokens: 8 }, h.mintCap(rid));
    expect(res.text).toBe("ok");
    expect(receipts).toHaveLength(1);
    expect(receipts[0]).toMatchObject({ outcome: "success", runId: rid, provider: "gemini" });
  });

  it("generateObject returns the caller's typed z.infer after local re-validation", async () => {
    const schema = z.object({ type: z.string() });
    h = await createEgressHarness(
      fakeAdapter({ parse: (_op, _req, _raw) => ({ result: { type: "note" }, usage: { inputTokens: 3 }, model: MODEL }) }),
      { Test: schema },
    );
    const rid = runId();
    // The client resolves schemaId against the SAME overlay registry the broker uses,
    // and the caller passes the registry's own schema object (reference identity).
    const registry = { Test: schema };
    const client = h.client(() => {}, registry);
    const res = await client.generateObject({ model: MODEL, prompt: { ref: "p@1" }, input: "x", schema, schemaId: "Test" }, h.mintCap(rid, { operation: "generateObject" }));
    expect(res).toEqual({ type: "note" });
  });

  it("rejects a generateObject whose schema does not match the registered schemaId (no transmission)", async () => {
    const registered = z.object({ type: z.string() });
    let transmitted = false;
    h = await createEgressHarness(
      fakeAdapter({ transmit: () => { transmitted = true; return Promise.resolve({ rawResponse: Buffer.from("{}"), retries: 0 }); } }),
      { Test: registered },
    );
    const client = h.client(() => {}, { Test: registered });
    // A DIFFERENT schema object under the same id must be rejected before any IPC.
    const err = await client
      .generateObject({ model: MODEL, prompt: { ref: "p@1" }, input: "x", schema: z.object({ type: z.string() }), schemaId: "Test" }, h.mintCap(runId(), { operation: "generateObject" }))
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ProviderCallError);
    expect(err).toMatchObject({ kind: "validation" });
    expect(transmitted).toBe(false);
  });

  it("accepts a bare AbortSignal (provider-interface signature) and honors a pre-abort", async () => {
    let transmitted = false;
    h = await createEgressHarness(fakeAdapter({ transmit: () => { transmitted = true; return Promise.resolve({ rawResponse: Buffer.from("{}"), retries: 0 }); } }));
    const client = h.client(() => {});
    const ac = new AbortController();
    ac.abort();
    // Third arg is a bare AbortSignal (NOT CallOptions) — it must be honored, not ignored.
    const err = await client
      .generateText({ model: MODEL, prompt: { ref: "p@1" }, input: "hi", maxTokens: 8 }, h.mintCap(runId()), ac.signal)
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ProviderCallError);
    expect(err).toMatchObject({ kind: "cancelled" });
    expect(transmitted).toBe(false);
  });

  it("embed returns N vectors in order", async () => {
    h = await createEgressHarness();
    const rid = runId();
    const client = h.client(() => {});
    const res = await client.embed({ model: "gemini-embedding-001", texts: ["a", "b"], dimensions: 4 }, h.mintCap(rid, { operation: "embed", model: "gemini-embedding-001" }));
    expect(res.vectors).toHaveLength(2);
  });

  it("emits a refusal receipt AND throws EgressRefusal on a budget breach", async () => {
    h = await createEgressHarness();
    const rid = runId();
    const receipts: ModelCallReceipt[] = [];
    const client = h.client((r) => { receipts.push(r); });
    const err = await client
      .generateText({ model: MODEL, prompt: { ref: "p@1" }, input: "hi", maxTokens: 8 }, h.mintCap(rid, { maxTokens: 1 }))
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(EgressRefusal);
    expect(receipts).toHaveLength(1);
    expect(receipts[0]?.outcome).toBe("refused");
  });

  it("emits a receipt AND throws ProviderCallError on a provider fault", async () => {
    h = await createEgressHarness(
      fakeAdapter({ transmit: () => Promise.reject(new ProviderCallError({ kind: "rate_limit", retryable: true, retryAfter: 1500 })) }),
    );
    const rid = runId();
    const receipts: ModelCallReceipt[] = [];
    const client = h.client((r) => { receipts.push(r); });
    const err = await client
      .generateText({ model: MODEL, prompt: { ref: "p@1" }, input: "hi", maxTokens: 8 }, h.mintCap(rid))
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ProviderCallError);
    expect(err).toMatchObject({ kind: "rate_limit", retryable: true, retryAfter: 1500, retryAfterMs: 1500 });
    expect(receipts).toHaveLength(1);
    expect(receipts[0]?.outcome).toBe("error");
  });

  it("a PRE-ABORTED call never transmits (cancelled, no receipt)", async () => {
    let transmitted = false;
    h = await createEgressHarness(fakeAdapter({ transmit: () => { transmitted = true; return Promise.resolve({ rawResponse: Buffer.from("{}"), retries: 0 }); } }));
    const rid = runId();
    const receipts: ModelCallReceipt[] = [];
    const client = h.client((r) => { receipts.push(r); });
    const ac = new AbortController();
    ac.abort();
    const err = await client
      .generateText({ model: MODEL, prompt: { ref: "p@1" }, input: "hi", maxTokens: 8 }, h.mintCap(rid), { signal: ac.signal })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ProviderCallError);
    expect(err).toMatchObject({ kind: "cancelled" });
    expect(transmitted).toBe(false); // never reached the broker
    expect(receipts).toHaveLength(0); // no transmission ⇒ no receipt
  });

  it("an IN-FLIGHT call is cancelled mid-transmit (cancelled + error receipt retained)", async () => {
    const cancellableTransmit = (_s: unknown, signal?: AbortSignal): Promise<never> =>
      new Promise((_res, rej) => {
        if (signal?.aborted) return rej(new ProviderCallError(providerError("cancelled", { message: "aborted" })));
        signal?.addEventListener("abort", () => rej(new ProviderCallError(providerError("cancelled", { message: "aborted" }))), { once: true });
      });
    h = await createEgressHarness(fakeAdapter({ transmit: cancellableTransmit as never }));
    const rid = runId();
    const receipts: ModelCallReceipt[] = [];
    const client = h.client((r) => { receipts.push(r); });
    const ac = new AbortController();
    const p = client.generateText({ model: MODEL, prompt: { ref: "p@1" }, input: "hi", maxTokens: 8 }, h.mintCap(rid), { signal: ac.signal });
    ac.abort();
    const err = await p.catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ProviderCallError);
    expect(err).toMatchObject({ kind: "cancelled" });
    expect(receipts).toHaveLength(1); // the dispatched-then-cancelled call still yields a receipt
    expect(receipts[0]?.outcome).toBe("error");
  });
});

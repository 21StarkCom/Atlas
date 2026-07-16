/**
 * `egress.capability-budget.test` (D19) + in-broker payload scan (INVARIANT 2).
 *
 * A call that exceeds the run's byte/cost/token ceiling, or exports above the
 * run's `allowedSensitivity`, or mismatches the capability's operation/model, or
 * carries an expired/forged capability, is REFUSED — and a run-attributable
 * refusal still yields a receipt (D6/D18). A secret planted in the exact serialized
 * request payload is blocked in-broker + quarantined, with a refusal receipt. A
 * forged/expired capability is rejected with no receipt.
 */
import { describe, it, expect } from "vitest";
import { randomBytes } from "node:crypto";
import type { QuarantineSink } from "@atlas/scan";
import {
  EgressService,
  GeminiAdapter,
  mintEgressCapability,
  ProviderCallError,
  providerError,
  type ProviderAdapter,
  type Transport,
  type EgressCapability,
  type EgressInvokeParams,
  type GenerateTextRequest,
  type EmbedRequest,
  type Usage,
  type CapabilitySensitivity,
} from "../src/index.js";

const SECRET = randomBytes(32);
const MODEL = "gemini-3.5-flash";
const RUN = "01J9Z8Q0000000000000000000";

/**
 * A deterministic fake adapter implementing the serialize→transmit→parse trio, so
 * the SERVER scans the EXACT serialized request bytes (the JSON of the request,
 * which carries the prompt input/texts) and the EXACT raw response bytes. Fixed
 * usage/cost, no network. `over` swaps any trio method (e.g. a leaky transmit).
 */
function fakeAdapter(over: Partial<ProviderAdapter> = {}): ProviderAdapter {
  return {
    provider: "gemini",
    host: "generativelanguage.googleapis.com",
    serialize: (_op, req) => ({ path: "/fake", bytes: Buffer.from(JSON.stringify(req), "utf8") }),
    transmit: (_s, signal) =>
      signal?.aborted
        ? Promise.reject(new ProviderCallError(providerError("cancelled", { message: "aborted" })))
        : Promise.resolve({ rawResponse: Buffer.from(JSON.stringify({ text: "ok", usage: { inputTokens: 10, outputTokens: 5 } }), "utf8"), retries: 0 }),
    parse: (op, req, raw) => {
      const json = JSON.parse(Buffer.from(raw).toString("utf8")) as { text?: string; usage?: Usage };
      if (op === "embed") {
        const r = req as EmbedRequest;
        const usage: Usage = { inputTokens: 4 };
        return { result: { vectors: r.texts.map(() => [0, 0, 0, 0]), dimensions: r.dimensions, usage, model: r.model }, usage, model: r.model };
      }
      const usage: Usage = json.usage ?? { inputTokens: 10, outputTokens: 5 };
      if (op === "generateObject") return { result: {}, usage, model: req.model };
      return { result: { text: json.text ?? "ok", usage, model: req.model }, usage, model: req.model };
    },
    costMicros: (_m: string, u: Usage) => u.inputTokens + (u.outputTokens ?? 0),
    ...over,
  };
}

/** An in-memory quarantine sink that records captures. */
function memSink(): QuarantineSink & { captures: { origin: string }[] } {
  const captures: { origin: string }[] = [];
  return { captures, quarantine: (i) => { captures.push({ origin: i.origin }); return Promise.resolve(); } };
}

const textReq = (input = "hello"): GenerateTextRequest => ({ model: MODEL, prompt: { ref: "prompts/extract@1" }, input, maxTokens: 8 });

function cap(over: Partial<Parameters<typeof mintEgressCapability>[1]> = {}, runId = RUN): EgressCapability {
  return mintEgressCapability(
    { runId },
    { operation: "generateText", model: MODEL, maxBytes: 10_000, maxTokens: 10_000, costCeiling: 10_000, allowedSensitivity: "confidential", ...over },
    { secret: SECRET },
  );
}

function invoke(capability: EgressCapability, req: GenerateTextRequest, declaredSensitivity: CapabilitySensitivity = "internal"): EgressInvokeParams {
  return { capability, body: { operation: "generateText", request: req }, declaredSensitivity };
}

describe("egress capability verification", () => {
  it("accepts a valid capability and returns a success receipt", async () => {
    const svc = new EgressService({ adapter: fakeAdapter(), quarantine: memSink(), capabilitySecret: SECRET });
    const out = await svc.invoke(invoke(cap(), textReq()));
    expect(out.ok).toBe(true);
    if (out.ok) {
      expect(out.receipt.outcome).toBe("success");
      expect(out.receipt.runId).toBe(RUN);
      expect(out.receipt.responseHash).toMatch(/^sha256:/);
      expect(out.receipt.costMicros).toBe(15);
    }
  });

  it("rejects a forged capability (MAC mismatch) with no receipt", async () => {
    const svc = new EgressService({ adapter: fakeAdapter(), quarantine: memSink(), capabilitySecret: SECRET });
    const forged = mintEgressCapability({ runId: RUN }, { operation: "generateText", model: MODEL, maxBytes: 1, maxTokens: 1, costCeiling: 1, allowedSensitivity: "public" }, { secret: randomBytes(32) });
    const out = await svc.invoke(invoke(forged, textReq()));
    expect(out.ok).toBe(false);
    if (!out.ok && "refusal" in out) {
      expect(out.refusal.code).toBe("egress.capability_invalid");
      expect(out.receipt).toBeUndefined();
    }
  });

  it("rejects an expired capability", async () => {
    const past = new Date("2000-01-01T00:00:00.000Z");
    const svc = new EgressService({ adapter: fakeAdapter(), quarantine: memSink(), capabilitySecret: SECRET });
    const expired = mintEgressCapability({ runId: RUN }, { operation: "generateText", model: MODEL, maxBytes: 100, maxTokens: 100, costCeiling: 100, allowedSensitivity: "public", ttlSeconds: 1 }, { secret: SECRET, now: () => past });
    const out = await svc.invoke(invoke(expired, textReq()));
    expect(out.ok).toBe(false);
    if (!out.ok && "refusal" in out) expect(out.refusal.code).toBe("egress.capability_expired");
  });

  it("refuses an operation/model that does not match the capability binding", async () => {
    const svc = new EgressService({ adapter: fakeAdapter(), quarantine: memSink(), capabilitySecret: SECRET });
    const out = await svc.invoke(invoke(cap({ model: "gemini-embedding-001" }), textReq()));
    expect(out.ok).toBe(false);
    if (!out.ok && "refusal" in out) {
      expect(out.refusal.code).toBe("egress.capability_mismatch");
      expect(out.receipt?.outcome).toBe("refused");
    }
  });
});

describe("egress per-run budget (D19)", () => {
  it("refuses a call whose byte ceiling would be exceeded", async () => {
    const svc = new EgressService({ adapter: fakeAdapter(), quarantine: memSink(), capabilitySecret: SECRET });
    const out = await svc.invoke(invoke(cap({ maxBytes: 5 }), textReq("a very long input that serializes past five bytes")));
    expect(out.ok).toBe(false);
    if (!out.ok && "refusal" in out) {
      expect(out.refusal.code).toBe("egress.byte_budget_exceeded");
      expect(out.receipt?.outcome).toBe("refused");
    }
  });

  it("refuses a call whose cost ceiling would be exceeded", async () => {
    const svc = new EgressService({ adapter: fakeAdapter(), quarantine: memSink(), capabilitySecret: SECRET });
    // costCeiling 1 micro; the pre-flight cost estimate (from maxTokens) exceeds it.
    const out = await svc.invoke(invoke(cap({ costCeiling: 1 }), textReq()));
    expect(out.ok).toBe(false);
    if (!out.ok && "refusal" in out) expect(out.refusal.code).toBe("egress.cost_budget_exceeded");
  });

  it("refuses a call whose token ceiling would be exceeded", async () => {
    const svc = new EgressService({ adapter: fakeAdapter(), quarantine: memSink(), capabilitySecret: SECRET });
    const out = await svc.invoke(invoke(cap({ maxTokens: 1 }), textReq()));
    expect(out.ok).toBe(false);
    if (!out.ok && "refusal" in out) expect(out.refusal.code).toBe("egress.token_budget_exceeded");
  });

  it("charges bytes AND retains the conservative projected tokens/cost of a DISPATCHED call on a provider error", async () => {
    const failing = fakeAdapter({
      transmit: () => Promise.reject(new ProviderCallError(providerError("timeout", { message: "t" })).withAttempt({ retries: 2, requestBytes: 999 })),
    });
    const svc = new EgressService({ adapter: failing, quarantine: memSink(), capabilitySecret: SECRET });
    const out = await svc.invoke(invoke(cap(), textReq()));
    expect(out.ok).toBe(false);
    if (!out.ok && "error" in out) {
      expect(out.error.kind).toBe("timeout");
      expect(out.receipt.retries).toBe(2); // attempt metadata surfaced onto the receipt
    }
    // A dispatched call whose usage is unavailable RETAINS the conservative projected
    // tokens/cost (never reconciled to zero) so a repeated provider fault cannot
    // consume spend without drawing down the run budget (D19). Bytes reflect retransmits.
    const snap = svc.budgetSnapshot(RUN);
    expect(snap.bytes).toBeGreaterThan(0);
    expect(snap.tokens).toBeGreaterThan(0);
    expect(snap.costMicros).toBeGreaterThan(0);
  });

  it("refuses an UNPRICED model before dispatch (cannot be cost-bounded)", async () => {
    // costMicros returns null for an unknown model even if serialize would allow it.
    const unpriced = fakeAdapter({ costMicros: () => null });
    const svc = new EgressService({ adapter: unpriced, quarantine: memSink(), capabilitySecret: SECRET });
    const out = await svc.invoke(invoke(cap(), textReq()));
    expect(out.ok).toBe(false);
    if (!out.ok && "refusal" in out) expect(out.refusal.code).toBe("egress.cost_budget_exceeded");
    expect(svc.budgetSnapshot(RUN)).toEqual({ bytes: 0, tokens: 0, costMicros: 0 }); // never reserved
  });

  it("two concurrent calls cannot race the ceiling (reservation held across the round-trip)", async () => {
    const svc = new EgressService({ adapter: fakeAdapter(), quarantine: memSink(), capabilitySecret: SECRET });
    // The projected draw of one call is (byte-length of "hello" = 5) + maxTokens 8 =
    // 13 tokens; maxTokens 13 fits exactly ONE, so a second concurrent call must see
    // the first's held reservation and be refused (the ceiling cannot be raced).
    const c = cap({ maxTokens: 13 });
    const [a, b] = await Promise.all([svc.invoke(invoke(c, textReq())), svc.invoke(invoke(c, textReq()))]);
    const oks = [a, b].filter((o) => o.ok).length;
    const refused = [a, b].filter((o) => !o.ok && "refusal" in o && o.refusal.code === "egress.token_budget_exceeded").length;
    expect(oks).toBe(1);
    expect(refused).toBe(1);
  });

  it("accumulates the budget across successive calls in the same run", async () => {
    const svc = new EgressService({ adapter: fakeAdapter(), quarantine: memSink(), capabilitySecret: SECRET });
    // maxTokens 30: each call uses 15 (10 in + 5 out). Third call exceeds.
    const c = cap({ maxTokens: 30, costCeiling: 10_000, maxBytes: 100_000 });
    expect((await svc.invoke(invoke(c, textReq()))).ok).toBe(true);
    expect((await svc.invoke(invoke(c, textReq()))).ok).toBe(true);
    const third = await svc.invoke(invoke(c, textReq()));
    expect(third.ok).toBe(false);
    if (!third.ok && "refusal" in third) expect(third.refusal.code).toBe("egress.token_budget_exceeded");
    expect(svc.budgetSnapshot(RUN).tokens).toBe(30);
  });
});

describe("egress sensitivity ceiling (D19, Phase-2 declared value)", () => {
  it("refuses a payload whose declared sensitivity exceeds allowedSensitivity", async () => {
    const svc = new EgressService({ adapter: fakeAdapter(), quarantine: memSink(), capabilitySecret: SECRET });
    const out = await svc.invoke(invoke(cap({ allowedSensitivity: "internal" }), textReq(), "restricted"));
    expect(out.ok).toBe(false);
    if (!out.ok && "refusal" in out) {
      expect(out.refusal.code).toBe("egress.sensitivity_exceeded");
      expect(out.receipt?.outcome).toBe("refused");
    }
  });

  it("allows a payload at or below the allowed class", async () => {
    const svc = new EgressService({ adapter: fakeAdapter(), quarantine: memSink(), capabilitySecret: SECRET });
    const out = await svc.invoke(invoke(cap({ allowedSensitivity: "confidential" }), textReq(), "confidential"));
    expect(out.ok).toBe(true);
  });
});

describe("egress in-broker payload scan (INVARIANT 2)", () => {
  // A high-entropy AWS-shaped secret planted in the prompt input.
  const PLANTED = "AKIAIOSFODNN7EXAMPLE and secret aws_secret_access_key=wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY";

  it("blocks a secret in the request payload in-broker, quarantines it, and emits a refusal receipt", async () => {
    const sink = memSink();
    const svc = new EgressService({ adapter: fakeAdapter(), quarantine: sink, capabilitySecret: SECRET });
    const out = await svc.invoke(invoke(cap(), textReq(PLANTED)));
    expect(out.ok).toBe(false);
    if (!out.ok && "refusal" in out) {
      expect(out.refusal.code).toBe("egress.secret_detected");
      expect(out.receipt?.outcome).toBe("refused");
      expect(out.receipt?.reasonCode).toBe("egress.secret_detected");
    }
    expect(sink.captures.length).toBe(1);
    expect(sink.captures[0]?.origin).toContain(RUN);
  });

  it("blocks a secret echoed back in the response payload and quarantines it", async () => {
    const sink = memSink();
    // The provider echoes the secret in the generated TEXT — it is in the RELEASED
    // bytes (ADR-0001), so the response scan catches it before release.
    const leaky = fakeAdapter({
      transmit: () => Promise.resolve({ rawResponse: Buffer.from(JSON.stringify({ text: PLANTED, usage: { inputTokens: 3, outputTokens: 3 } }), "utf8"), retries: 0 }),
    });
    const svc = new EgressService({ adapter: leaky, quarantine: sink, capabilitySecret: SECRET });
    const out = await svc.invoke(invoke(cap(), textReq("clean prompt")));
    expect(out.ok).toBe(false);
    if (!out.ok && "refusal" in out) expect(out.refusal.code).toBe("egress.secret_detected");
    expect(sink.captures.length).toBe(1);
  });

  it("releases a clean answer whose ENVELOPE carries a discarded high-entropy field (Gemini thoughtSignature, ADR-0001)", async () => {
    const sink = memSink();
    // A realistic Gemini 3.5 response: clean generated text + a multi-KB opaque
    // base64 `thoughtSignature` the adapter's parse DISCARDS. Scan-wise the blob is
    // indistinguishable from a secret, but it never re-enters the host — under
    // ADR-0001 the released bytes are scanned, so the call must SUCCEED. (Before
    // the ADR this refused every thinking-model response — issue #146.)
    const thoughtSignature = randomBytes(2048).toString("base64");
    const raw = JSON.stringify({
      candidates: [{ content: { parts: [{ text: "A perfectly ordinary grounded answer citing note-write-rules.", thoughtSignature }], role: "model" }, finishReason: "STOP" }],
      usageMetadata: { promptTokenCount: 12, candidatesTokenCount: 9, totalTokenCount: 21 },
      modelVersion: MODEL,
    });
    const transport: Transport = () => Promise.resolve(new Response(raw, { status: 200, headers: { "content-type": "application/json" } }));
    const adapter = new GeminiAdapter({ apiKey: "k", transport, maxRetries: 0, sleep: () => Promise.resolve() });
    const svc = new EgressService({ adapter, quarantine: sink, capabilitySecret: SECRET });
    const out = await svc.invoke(invoke(cap(), textReq("clean prompt")));
    expect(out.ok, JSON.stringify(out)).toBe(true);
    if (out.ok) expect((out.result as { text: string }).text).toContain("ordinary grounded answer");
    expect(sink.captures.length).toBe(0); // nothing quarantined — the blob never left the broker
  });

  it("does not consume budget for a pre-flight-refused (request-scan) call", async () => {
    const svc = new EgressService({ adapter: fakeAdapter(), quarantine: memSink(), capabilitySecret: SECRET });
    await svc.invoke(invoke(cap(), textReq(PLANTED)));
    expect(svc.budgetSnapshot(RUN)).toEqual({ bytes: 0, tokens: 0, costMicros: 0 });
  });

  it("scans + quarantines a secret in a non-2xx (401/429/5xx) ERROR response body before mapping the status", async () => {
    for (const status of [401, 429, 500]) {
      const sink = memSink();
      // A provider error body that carries a planted secret — it must be scanned +
      // quarantined in-broker BEFORE the status is mapped to a ProviderError.
      const transport: Transport = () =>
        Promise.resolve(new Response(`{"error":"boom ${PLANTED}"}`, { status, headers: { "content-type": "application/json" } }));
      const adapter = new GeminiAdapter({ apiKey: "k", transport, maxRetries: 0, sleep: () => Promise.resolve() });
      const svc = new EgressService({ adapter, quarantine: sink, capabilitySecret: SECRET });
      const out = await svc.invoke(invoke(cap(), textReq("clean prompt")));
      expect(out.ok).toBe(false);
      if (!out.ok && "refusal" in out) {
        expect(out.refusal.code).toBe("egress.secret_detected");
        expect(out.receipt?.outcome).toBe("refused");
      }
      expect(sink.captures.length).toBe(1); // the error body was captured, not leaked
    }
  });

  it("scans a secret in an INTERMEDIATE retryable (429) response body — blocks before the retry", async () => {
    const sink = memSink();
    let calls = 0;
    // First attempt: a retryable 429 whose body carries a secret. If the intermediate
    // body were unscanned, the adapter would retry and a clean 200 would succeed.
    const transport: Transport = () => {
      calls++;
      if (calls === 1) return Promise.resolve(new Response(`{"e":"${PLANTED}"}`, { status: 429, headers: { "content-type": "application/json" } }));
      return Promise.resolve(new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: "ok" }] } }], usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 1 } }), { status: 200, headers: { "content-type": "application/json" } }));
    };
    const adapter = new GeminiAdapter({ apiKey: "k", transport, maxRetries: 3, sleep: () => Promise.resolve() });
    const svc = new EgressService({ adapter, quarantine: sink, capabilitySecret: SECRET });
    const out = await svc.invoke(invoke(cap(), textReq("clean prompt")));
    expect(out.ok).toBe(false); // the intermediate body was scanned → blocked, not retried away
    if (!out.ok && "refusal" in out) expect(out.refusal.code).toBe("egress.secret_detected");
    expect(sink.captures.length).toBe(1);
    expect(calls).toBe(1); // never retried past the scan block
  });
});

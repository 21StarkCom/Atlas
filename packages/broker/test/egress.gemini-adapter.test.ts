/**
 * `egress.gemini-adapter.test` — the provider adapter suite (provider-interface §7).
 *
 * Exercises the full taxonomy/retry/cancellation matrix with an injected HTTP
 * transport (doubles by default — no live key): malformed/truncated output, schema
 * violations, timeouts, rate-limit `retryAfter → retryAfterMs`, cancellation
 * before/during/mid-batch, auth failures (stable `authentication`,
 * `retryable:false`, ZERO retries, sanitized), and partial-batch semantics. The
 * live-Gemini smoke is a separate, `ATLAS_LIVE_GEMINI`-gated skip.
 */
import { describe, it, expect, vi } from "vitest";
import { z } from "zod";
import { GeminiAdapter, ProviderCallError, type Transport } from "../src/index.js";
import type { GenerateTextRequest, EmbedRequest, GenerateObjectRequest } from "../src/index.js";

const MODEL = "gemini-3.5-flash";
const EMBED_MODEL = "gemini-embedding-001";

function jsonResponse(body: unknown, init?: { status?: number; statusText?: string; headers?: Record<string, string> }): Response {
  return new Response(JSON.stringify(body), {
    status: init?.status ?? 200,
    statusText: init?.statusText ?? "OK",
    headers: { "content-type": "application/json", ...(init?.headers ?? {}) },
  });
}

function textCandidate(text: string, usage = { promptTokenCount: 10, candidatesTokenCount: 5 }): unknown {
  return { candidates: [{ content: { parts: [{ text }] } }], usageMetadata: usage };
}

const textReq: GenerateTextRequest = {
  model: MODEL,
  prompt: { ref: "prompts/extract@1" },
  input: "extract claims from this text",
  maxTokens: 256,
  temperature: 0,
};

const embedReq: EmbedRequest = { model: EMBED_MODEL, texts: ["a", "b"], dimensions: 4 };

/** A never-sleeping timer so retry backoff never blocks a test. */
const noSleep = (): Promise<void> => Promise.resolve();

describe("GeminiAdapter — success paths", () => {
  it("generateText returns text + usage + model", async () => {
    const transport: Transport = () => Promise.resolve(jsonResponse(textCandidate("hello")));
    const adapter = new GeminiAdapter({ apiKey: "k", transport, sleep: noSleep });
    const r = await adapter.generateText(textReq);
    expect(r).toEqual({ text: "hello", usage: { inputTokens: 10, outputTokens: 5 }, model: MODEL, retries: 0 });
  });

  it("rejects a cross-operation / non-allowlisted model before transport (model_incompatible)", async () => {
    const transport = vi.fn<Transport>(() => Promise.resolve(jsonResponse(textCandidate("x"))));
    const adapter = new GeminiAdapter({ apiKey: "k", transport, sleep: noSleep });
    // An embedding model used under generateText is not on the generation allowlist.
    await expect(adapter.generateText({ ...textReq, model: EMBED_MODEL })).rejects.toMatchObject({ kind: "model_incompatible", retryable: false });
    expect(transport).not.toHaveBeenCalled(); // rejected before any transport
  });

  it("generateObject validates against the resolved schema", async () => {
    const schema = z.object({ type: z.string() });
    const transport: Transport = () => Promise.resolve(jsonResponse(textCandidate(JSON.stringify({ type: "note" }))));
    const adapter = new GeminiAdapter({ apiKey: "k", transport, sleep: noSleep });
    const req: GenerateObjectRequest = { model: MODEL, prompt: { ref: "prompts/classify@1" }, input: "x", schemaId: "T" };
    const r = await adapter.generateObject(req, schema);
    expect(r.object).toEqual({ type: "note" });
    expect(r.usage.inputTokens).toBe(10);
  });

  it("embed returns N vectors in input order", async () => {
    const transport: Transport = () =>
      Promise.resolve(jsonResponse({ embeddings: [{ values: [1, 2, 3, 4] }, { values: [5, 6, 7, 8] }], usageMetadata: { promptTokenCount: 8 } }));
    const adapter = new GeminiAdapter({ apiKey: "k", transport, sleep: noSleep });
    const r = await adapter.embed(embedReq);
    expect(r.vectors).toEqual([[1, 2, 3, 4], [5, 6, 7, 8]]);
    expect(r.dimensions).toBe(4);
  });
});

describe("GeminiAdapter — malformed / schema violations", () => {
  it("maps truncated/malformed JSON output to validation (retryable:false)", async () => {
    const transport: Transport = () => Promise.resolve(jsonResponse(textCandidate("{not valid json")));
    const adapter = new GeminiAdapter({ apiKey: "k", transport, sleep: noSleep });
    const req: GenerateObjectRequest = { model: MODEL, prompt: { ref: "prompts/classify@1" }, input: "x", schemaId: "T" };
    await expect(adapter.generateObject(req, z.object({ a: z.number() }))).rejects.toMatchObject({ kind: "validation", retryable: false });
  });

  it("maps a schema violation to validation", async () => {
    const transport: Transport = () => Promise.resolve(jsonResponse(textCandidate(JSON.stringify({ a: "not-a-number" }))));
    const adapter = new GeminiAdapter({ apiKey: "k", transport, sleep: noSleep });
    const req: GenerateObjectRequest = { model: MODEL, prompt: { ref: "prompts/classify@1" }, input: "x", schemaId: "T" };
    await expect(adapter.generateObject(req, z.object({ a: z.number() }))).rejects.toMatchObject({ kind: "validation" });
  });

  it("maps an empty candidate set to validation", async () => {
    const transport: Transport = () => Promise.resolve(jsonResponse({ candidates: [] }));
    const adapter = new GeminiAdapter({ apiKey: "k", transport, sleep: noSleep });
    await expect(adapter.generateText(textReq)).rejects.toMatchObject({ kind: "validation" });
  });
});

describe("GeminiAdapter — auth failures", () => {
  it("maps 401 to stable authentication, retryable:false, ZERO retries, no key leak", async () => {
    const transport = vi.fn<Transport>(() => Promise.resolve(jsonResponse({ error: "nope" }, { status: 401 })));
    const adapter = new GeminiAdapter({ apiKey: "super-secret-key", transport, maxRetries: 3, sleep: noSleep });
    const err = await adapter.generateText(textReq).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ProviderCallError);
    expect(err).toMatchObject({ kind: "authentication", retryable: false });
    expect((err as Error).message).not.toContain("super-secret-key");
    expect(transport).toHaveBeenCalledTimes(1); // zero retries on auth
  });

  it("maps 403 to authentication", async () => {
    const transport: Transport = () => Promise.resolve(jsonResponse({}, { status: 403 }));
    const adapter = new GeminiAdapter({ apiKey: "k", transport, sleep: noSleep });
    await expect(adapter.generateText(textReq)).rejects.toMatchObject({ kind: "authentication" });
  });
});

describe("GeminiAdapter — rate limit / retry", () => {
  it("propagates Retry-After (seconds) into retryAfter/retryAfterMs and retries", async () => {
    let n = 0;
    const transport = vi.fn<Transport>(() => {
      n++;
      return Promise.resolve(n === 1 ? jsonResponse({}, { status: 429, headers: { "retry-after": "2" } }) : jsonResponse(textCandidate("ok")));
    });
    const sleep = vi.fn(noSleep);
    const adapter = new GeminiAdapter({ apiKey: "k", transport, maxRetries: 2, sleep });
    const r = await adapter.generateText(textReq);
    expect(r.text).toBe("ok");
    expect(sleep).toHaveBeenCalledWith(2000); // 2s → 2000ms
    expect(transport).toHaveBeenCalledTimes(2);
  });

  it("surfaces rate_limit with retryAfterMs when retries are exhausted", async () => {
    const transport: Transport = () => Promise.resolve(jsonResponse({}, { status: 429, headers: { "retry-after": "1" } }));
    const adapter = new GeminiAdapter({ apiKey: "k", transport, maxRetries: 1, sleep: noSleep });
    const err = await adapter.generateText(textReq).catch((e: unknown) => e);
    expect(err).toMatchObject({ kind: "rate_limit", retryable: true, retryAfter: 1000, retryAfterMs: 1000 });
  });

  it("maps quota (429 w/ RESOURCE_EXHAUSTED in the body) to quota, retryable:true", async () => {
    // Real Gemini reports the application status in the JSON body, not statusText.
    const transport: Transport = () =>
      Promise.resolve(jsonResponse({ error: { code: 429, status: "RESOURCE_EXHAUSTED", message: "quota exceeded" } }, { status: 429, headers: { "retry-after": "60" } }));
    const adapter = new GeminiAdapter({ apiKey: "k", transport, maxRetries: 0, sleep: noSleep });
    await expect(adapter.generateText(textReq)).rejects.toMatchObject({ kind: "quota", retryable: true, retryAfterMs: 60000 });
  });

  it("maps a plain 429 (no RESOURCE_EXHAUSTED) to rate_limit", async () => {
    const transport: Transport = () =>
      Promise.resolve(jsonResponse({ error: { code: 429, status: "UNKNOWN", message: "slow down" } }, { status: 429, headers: { "retry-after": "3" } }));
    const adapter = new GeminiAdapter({ apiKey: "k", transport, maxRetries: 0, sleep: noSleep });
    await expect(adapter.generateText(textReq)).rejects.toMatchObject({ kind: "rate_limit", retryable: true, retryAfterMs: 3000 });
  });
});

describe("GeminiAdapter — error mapping is driven by the scanned body (finding #8)", () => {
  it("maps a 400 INVALID_ARGUMENT (malformed request) to validation, NOT model_incompatible", async () => {
    const transport: Transport = () =>
      Promise.resolve(jsonResponse({ error: { code: 400, status: "INVALID_ARGUMENT", message: "bad request" } }, { status: 400 }));
    const adapter = new GeminiAdapter({ apiKey: "k", transport, sleep: noSleep });
    await expect(adapter.generateText(textReq)).rejects.toMatchObject({ kind: "validation", retryable: false });
  });

  it("maps a 404 NOT_FOUND to model_incompatible", async () => {
    const transport: Transport = () =>
      Promise.resolve(jsonResponse({ error: { code: 404, status: "NOT_FOUND", message: "model not found" } }, { status: 404 }));
    const adapter = new GeminiAdapter({ apiKey: "k", transport, sleep: noSleep });
    await expect(adapter.generateText(textReq)).rejects.toMatchObject({ kind: "model_incompatible", retryable: false });
  });

  it("maps a body UNAVAILABLE (503) to transport (retryable) even when the status line lies", async () => {
    const transport: Transport = () =>
      Promise.resolve(jsonResponse({ error: { code: 503, status: "UNAVAILABLE", message: "overloaded" } }, { status: 503, statusText: "quota" }));
    const adapter = new GeminiAdapter({ apiKey: "k", transport, maxRetries: 0, sleep: noSleep });
    await expect(adapter.generateText(textReq)).rejects.toMatchObject({ kind: "transport", retryable: true });
  });

  it("maps body PERMISSION_DENIED to authentication with zero retries", async () => {
    const transport = vi.fn<Transport>(() =>
      Promise.resolve(jsonResponse({ error: { code: 403, status: "PERMISSION_DENIED", message: "no" } }, { status: 403 })),
    );
    const adapter = new GeminiAdapter({ apiKey: "sekret", transport, maxRetries: 3, sleep: noSleep });
    await expect(adapter.generateText(textReq)).rejects.toMatchObject({ kind: "authentication", retryable: false });
    expect(transport).toHaveBeenCalledTimes(1);
  });

  it("maps a bare 400 with no canonical status to validation (fallback)", async () => {
    const transport: Transport = () => Promise.resolve(jsonResponse({}, { status: 400 }));
    const adapter = new GeminiAdapter({ apiKey: "k", transport, sleep: noSleep });
    await expect(adapter.generateText(textReq)).rejects.toMatchObject({ kind: "validation", retryable: false });
  });
});

describe("GeminiAdapter — conservative pricing + official model id (finding #7)", () => {
  it("prices gemini-3.5-flash conservatively (>= published standard tier)", () => {
    const adapter = new GeminiAdapter({ apiKey: "k" });
    // 1000 in + 1000 out tokens → 1500 + 9000 = 10500 micro-USD (rounded up).
    expect(adapter.costMicros("gemini-3.5-flash", { inputTokens: 1000, outputTokens: 1000 })).toBe(10500);
    // Embedding is input-only at 150 micro-USD / 1K.
    expect(adapter.costMicros("gemini-embedding-001", { inputTokens: 1000 })).toBe(150);
  });

  it("returns null (unpriced ⇒ refused) for an unknown model", () => {
    const adapter = new GeminiAdapter({ apiKey: "k" });
    expect(adapter.costMicros("gemini-3-5-flash", { inputTokens: 1 })).toBeNull(); // the OLD wrong id
    expect(adapter.costMicros("made-up", { inputTokens: 1 })).toBeNull();
  });

  it("serializes the official gemini-3.5-flash id in the request path", () => {
    const adapter = new GeminiAdapter({ apiKey: "k" });
    const s = adapter.serialize("generateText", textReq);
    expect(s.path).toContain("gemini-3.5-flash");
    // The old dashed id is not on the allowlist → rejected before transport.
    expect(() => adapter.serialize("generateText", { ...textReq, model: "gemini-3-5-flash" })).toThrow();
  });
});

describe("GeminiAdapter — prompt.ref resolution (finding #2)", () => {
  it("RESOLVES prompt.ref into the EXACT serialized generateText body (scanned bytes carry the prompt)", () => {
    const adapter = new GeminiAdapter({ apiKey: "k" });
    const s = adapter.serialize("generateText", textReq);
    const body = JSON.parse(Buffer.from(s.bytes).toString("utf8")) as {
      systemInstruction?: { parts?: { text?: string }[] };
      contents?: { parts?: { text?: string }[] }[];
    };
    // The versioned prompt content is present in the transmitted (and scanned) bytes.
    const sys = body.systemInstruction?.parts?.[0]?.text ?? "";
    expect(sys).toContain("source-extraction");
    // The source input is still the user turn — prompt + input both cross the wire.
    expect(body.contents?.[0]?.parts?.[0]?.text).toBe(textReq.input);
  });

  it("RESOLVES prompt.ref into the generateObject body too", () => {
    const adapter = new GeminiAdapter({ apiKey: "k" });
    const s = adapter.serialize("generateObject", { model: MODEL, prompt: { ref: "prompts/classify@1" }, input: "x", schemaId: "T" } as GenerateObjectRequest);
    const raw = Buffer.from(s.bytes).toString("utf8");
    expect(raw).toContain("source-classification");
  });

  it("FAILS CLOSED on an unknown prompt reference — before any transport", () => {
    const transport = vi.fn<Transport>(() => Promise.resolve(jsonResponse(textCandidate("x"))));
    const adapter = new GeminiAdapter({ apiKey: "k", transport, sleep: noSleep });
    expect(() => adapter.serialize("generateText", { ...textReq, prompt: { ref: "prompts/does-not-exist@9" } }))
      .toThrow(ProviderCallError);
    try {
      adapter.serialize("generateText", { ...textReq, prompt: { ref: "prompts/does-not-exist@9" } });
    } catch (e) {
      expect(e).toMatchObject({ kind: "validation", retryable: false });
    }
    expect(transport).not.toHaveBeenCalled();
  });

  it("honours an injected prompt registry", () => {
    const adapter = new GeminiAdapter({ apiKey: "k", promptRegistry: { resolve: (ref) => ref === "custom@1" ? { ref, content: "MY-CUSTOM-INSTRUCTIONS" } : undefined } });
    const raw = Buffer.from(adapter.serialize("generateText", { ...textReq, prompt: { ref: "custom@1" } }).bytes).toString("utf8");
    expect(raw).toContain("MY-CUSTOM-INSTRUCTIONS");
    expect(() => adapter.serialize("generateText", textReq)).toThrow(); // extract@1 not in the injected registry
  });
});

describe("GeminiAdapter — timeouts / transport", () => {
  it("maps 504 to timeout (retryable) and retries then fails", async () => {
    const transport = vi.fn<Transport>(() => Promise.resolve(jsonResponse({}, { status: 504 })));
    const adapter = new GeminiAdapter({ apiKey: "k", transport, maxRetries: 2, sleep: noSleep });
    await expect(adapter.generateText(textReq)).rejects.toMatchObject({ kind: "timeout", retryable: true });
    expect(transport).toHaveBeenCalledTimes(3); // initial + 2 retries
  });

  it("maps a thrown network error to transport", async () => {
    const transport: Transport = () => Promise.reject(new Error("ECONNRESET"));
    const adapter = new GeminiAdapter({ apiKey: "k", transport, maxRetries: 0, sleep: noSleep });
    await expect(adapter.generateText(textReq)).rejects.toMatchObject({ kind: "transport", retryable: true });
  });

  it("maps 400/404 to model_incompatible (terminal)", async () => {
    const transport: Transport = () => Promise.resolve(jsonResponse({}, { status: 404 }));
    const adapter = new GeminiAdapter({ apiKey: "k", transport, sleep: noSleep });
    await expect(adapter.generateText(textReq)).rejects.toMatchObject({ kind: "model_incompatible", retryable: false });
  });
});

describe("GeminiAdapter — cancellation", () => {
  it("aborts BEFORE the call with zero round-trips", async () => {
    const transport = vi.fn<Transport>(() => Promise.resolve(jsonResponse(textCandidate("x"))));
    const adapter = new GeminiAdapter({ apiKey: "k", transport, sleep: noSleep });
    const ac = new AbortController();
    ac.abort();
    await expect(adapter.generateText(textReq, ac.signal)).rejects.toMatchObject({ kind: "cancelled", retryable: false });
    expect(transport).not.toHaveBeenCalled();
  });

  it("aborts DURING the call (transport throws AbortError)", async () => {
    const transport: Transport = () => {
      const e = new Error("aborted");
      e.name = "AbortError";
      return Promise.reject(e);
    };
    const adapter = new GeminiAdapter({ apiKey: "k", transport, sleep: noSleep });
    const ac = new AbortController();
    await expect(adapter.generateText(textReq, ac.signal)).rejects.toMatchObject({ kind: "cancelled" });
  });

  it("aborts DURING a long Retry-After backoff without sleeping it out (finding #9)", async () => {
    // 429 → a 10s Retry-After backoff. A real (long) timer sleep would pin the call
    // for 10s; an ABORTABLE backoff wakes the instant the signal aborts.
    const transport: Transport = () => Promise.resolve(jsonResponse({ error: { status: "UNKNOWN" } }, { status: 429, headers: { "retry-after": "10" } }));
    let slept = false;
    const realSleep = (ms: number): Promise<void> => new Promise((r) => { slept = true; setTimeout(r, ms); });
    const adapter = new GeminiAdapter({ apiKey: "k", transport, maxRetries: 2, sleep: realSleep });
    const ac = new AbortController();
    const started = Date.now();
    const p = adapter.generateText(textReq, ac.signal).catch((e: unknown) => e);
    // Enter the backoff, then abort — must resolve promptly, not after 10s.
    await new Promise((r) => setTimeout(r, 30));
    ac.abort();
    const err = await p;
    expect(err).toMatchObject({ kind: "cancelled" });
    expect(slept).toBe(true); // the backoff really did start a long sleep…
    expect(Date.now() - started).toBeLessThan(2000); // …but abort woke it far before 10s
  });

  it("aborts MID-BATCH (embed) — no partial success returned", async () => {
    const transport: Transport = () => {
      const e = new Error("aborted");
      e.name = "AbortError";
      return Promise.reject(e);
    };
    const adapter = new GeminiAdapter({ apiKey: "k", transport, sleep: noSleep });
    const ac = new AbortController();
    await expect(adapter.embed(embedReq, ac.signal)).rejects.toMatchObject({ kind: "cancelled" });
  });
});

describe("GeminiAdapter — partial batch", () => {
  it("names succeeded indices and never returns a partial as complete", async () => {
    const transport: Transport = () =>
      Promise.resolve(jsonResponse({ embeddings: [{ values: [1, 2, 3, 4] }, {}], usageMetadata: { promptTokenCount: 8 } }));
    const adapter = new GeminiAdapter({ apiKey: "k", transport, maxRetries: 0, sleep: noSleep });
    const err = await adapter.embed(embedReq).catch((e: unknown) => e);
    expect(err).toMatchObject({ kind: "partial_batch", retryable: true, succeededIndices: [0] });
  });

  it("maps dimension drift to validation", async () => {
    const transport: Transport = () =>
      Promise.resolve(jsonResponse({ embeddings: [{ values: [1, 2] }, { values: [3, 4] }], usageMetadata: { promptTokenCount: 8 } }));
    const adapter = new GeminiAdapter({ apiKey: "k", transport, sleep: noSleep });
    await expect(adapter.embed(embedReq)).rejects.toMatchObject({ kind: "validation" });
  });
});

describe.runIf(process.env.ATLAS_LIVE_GEMINI === "1")("GeminiAdapter — live smoke", () => {
  it("round-trips a real generateText", async () => {
    const adapter = new GeminiAdapter({ apiKey: process.env.ATLAS_GEMINI_KEY ?? "" });
    const r = await adapter.generateText({ ...textReq, input: "Say the single word: ping" });
    expect(typeof r.text).toBe("string");
  });
});

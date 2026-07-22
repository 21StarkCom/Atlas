/**
 * `gemini-adapter.direct.test` — the ported Gemini adapter matrix driven against the
 * IN-PROCESS invoker (Phase-2 cutover). The adapter is constructed with a STUBBED
 * `Transport` (no live key, no network); `createInProcessInvoker({ adapter })` calls
 * it directly (no capability mint, no per-run budget, no egress scan) and a
 * `ModelsClient` drives the typed surface. Every transmission still emits exactly one
 * receipt, and every provider fault maps to the stable `ProviderCallError` taxonomy.
 */
import { describe, it, expect, vi } from "vitest";
import { z } from "zod";
import { newRunId } from "@atlas/contracts";
import {
  GeminiAdapter,
  ModelsClient,
  createInProcessInvoker,
  resolveGeminiApiKey,
  modelCallId,
  PROMPT_REFS,
  ProviderCallError,
  type ModelCallReceipt,
  type Transport,
  type GenerateTextRequest,
  type GenerateObjectRequest,
  type EmbedRequest,
} from "../src/index.js";

const GEN_MODEL = "gemini-3.5-flash";
const EMBED_MODEL = "gemini-embedding-001";

/** A stub transport that returns a scripted `Response` for the single request. */
function transportOf(status: number, body: unknown, headers: Record<string, string> = {}): Transport {
  return () => Promise.resolve(new Response(typeof body === "string" ? body : JSON.stringify(body), { status, headers }));
}

/** Build a ModelsClient over the in-process invoker driving a real GeminiAdapter. */
function clientOver(transport: Transport, schemaRegistry?: Record<string, z.ZodTypeAny>): { client: ModelsClient; receipts: ModelCallReceipt[] } {
  // maxRetries 0 makes a retryable fault terminate immediately (deterministic matrix).
  const adapter = new GeminiAdapter({ apiKey: "test-key", transport, maxRetries: 0 });
  const receipts: ModelCallReceipt[] = [];
  const invoker = createInProcessInvoker(schemaRegistry !== undefined ? { adapter, schemaRegistry } : { adapter });
  const client = new ModelsClient(invoker, (r) => { receipts.push(r); }, schemaRegistry !== undefined ? { schemaRegistry } : {});
  return { client, receipts };
}

function generateTextResponse(text: string, finishReason = "STOP"): unknown {
  return {
    candidates: [{ content: { parts: [{ text }] }, finishReason }],
    usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 5 },
  };
}

describe("gemini adapter matrix (in-process invoker)", () => {
  const rid = (): { runId: string } => ({ runId: newRunId() });

  it("generateText success returns the typed result + a success receipt", async () => {
    const { client, receipts } = clientOver(transportOf(200, generateTextResponse("hello")));
    const res = await client.generateText(
      { model: GEN_MODEL, prompt: { ref: PROMPT_REFS.synthesize }, input: "hi", maxTokens: 64 },
      rid(),
    );
    expect(res.text).toBe("hello");
    expect(res.finishReason).toBe("STOP");
    expect(receipts).toHaveLength(1);
    expect(receipts[0]).toMatchObject({ outcome: "success", provider: "gemini", operation: "generateText" });
    expect(receipts[0]!.requestHash.startsWith("sha256:")).toBe(true);
  });

  it("authentication is terminal, retryable:false, ZERO retries", async () => {
    const { client, receipts } = clientOver(transportOf(401, { error: { status: "UNAUTHENTICATED", message: "bad key" } }));
    const err = await client
      .generateText({ model: GEN_MODEL, prompt: { ref: PROMPT_REFS.synthesize }, input: "hi", maxTokens: 64 }, rid())
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ProviderCallError);
    expect(err).toMatchObject({ kind: "authentication", retryable: false });
    expect(receipts).toHaveLength(1);
    expect(receipts[0]).toMatchObject({ outcome: "error", reasonCode: "authentication", retries: 0 });
  });

  it("rate_limit maps 429 and propagates Retry-After", async () => {
    const { client } = clientOver(transportOf(429, { error: { message: "slow down" } }, { "retry-after": "2" }));
    const err = await client
      .generateText({ model: GEN_MODEL, prompt: { ref: PROMPT_REFS.synthesize }, input: "hi", maxTokens: 64 }, rid())
      .catch((e: unknown) => e);
    expect(err).toMatchObject({ kind: "rate_limit", retryable: true, retryAfterMs: 2000 });
  });

  it("quota maps RESOURCE_EXHAUSTED", async () => {
    const { client } = clientOver(transportOf(429, { error: { status: "RESOURCE_EXHAUSTED", message: "quota" } }));
    const err = await client
      .generateText({ model: GEN_MODEL, prompt: { ref: PROMPT_REFS.synthesize }, input: "hi", maxTokens: 64 }, rid())
      .catch((e: unknown) => e);
    expect(err).toMatchObject({ kind: "quota", retryable: true });
  });

  it("timeout maps DEADLINE_EXCEEDED", async () => {
    const { client } = clientOver(transportOf(504, { error: { status: "DEADLINE_EXCEEDED" } }));
    const err = await client
      .generateText({ model: GEN_MODEL, prompt: { ref: PROMPT_REFS.synthesize }, input: "hi", maxTokens: 64 }, rid())
      .catch((e: unknown) => e);
    expect(err).toMatchObject({ kind: "timeout", retryable: true });
  });

  it("validation maps INVALID_ARGUMENT", async () => {
    const { client } = clientOver(transportOf(400, { error: { status: "INVALID_ARGUMENT", message: "bad" } }));
    const err = await client
      .generateText({ model: GEN_MODEL, prompt: { ref: PROMPT_REFS.synthesize }, input: "hi", maxTokens: 64 }, rid())
      .catch((e: unknown) => e);
    expect(err).toMatchObject({ kind: "validation", retryable: false });
  });

  it("model_incompatible is thrown at serialize (before transport)", async () => {
    let transportCalls = 0;
    const transport: Transport = () => {
      transportCalls++;
      return Promise.resolve(new Response("{}", { status: 200 }));
    };
    const { client, receipts } = clientOver(transport);
    const err = await client
      .generateText({ model: "not-a-model", prompt: { ref: PROMPT_REFS.synthesize }, input: "hi", maxTokens: 64 }, rid())
      .catch((e: unknown) => e);
    expect(err).toMatchObject({ kind: "model_incompatible" });
    expect(transportCalls).toBe(0); // refused before any network
    expect(receipts[0]).toMatchObject({ outcome: "error", reasonCode: "model_incompatible" });
  });

  it("two DISTINCT serialization failures in one run produce distinct request hashes + model_calls rows", async () => {
    // Regression (wing round-2): a pre-serialization failure has no serialized bytes,
    // so its receipt carries a deterministic "unbound" hash over the COMPLETE attempted
    // request body — NOT just runId/operation/model. Two model_incompatible calls in the
    // SAME run that differ only in `input` must therefore hash differently, so their
    // derived `call_id`s differ and both survive the `(runId, requestHash)` ON CONFLICT
    // (rather than collapsing to a single model_calls row).
    let transportCalls = 0;
    const transport: Transport = () => { transportCalls++; return Promise.resolve(new Response("{}", { status: 200 })); };
    const { client, receipts } = clientOver(transport);
    const run = rid();
    await client
      .generateText({ model: "not-a-model", prompt: { ref: PROMPT_REFS.synthesize }, input: "first input", maxTokens: 64 }, run)
      .catch(() => {});
    await client
      .generateText({ model: "not-a-model", prompt: { ref: PROMPT_REFS.synthesize }, input: "second input", maxTokens: 64 }, run)
      .catch(() => {});
    expect(transportCalls).toBe(0); // both refused before any network
    expect(receipts).toHaveLength(2);
    expect(receipts[0]).toMatchObject({ runId: run.runId, outcome: "error", reasonCode: "model_incompatible" });
    expect(receipts[1]).toMatchObject({ runId: run.runId, outcome: "error", reasonCode: "model_incompatible" });
    // Distinct request hashes → distinct idempotency keys → two persisted rows.
    expect(receipts[0]!.requestHash).not.toBe(receipts[1]!.requestHash);
    expect(modelCallId(run.runId, receipts[0]!.requestHash)).not.toBe(
      modelCallId(run.runId, receipts[1]!.requestHash),
    );
  });

  it("embed returns N vectors in order", async () => {
    const { client } = clientOver(transportOf(200, { embeddings: [{ values: [1, 0, 0] }, { values: [0, 1, 0] }] }));
    const res = await client.embed({ model: EMBED_MODEL, texts: ["a", "b"], dimensions: 3 }, rid());
    expect(res.vectors).toEqual([[1, 0, 0], [0, 1, 0]]);
  });

  it("partial_batch names the succeeded indices", async () => {
    const { client } = clientOver(transportOf(200, { embeddings: [{ values: [1, 0, 0] }] }));
    const err = await client
      .embed({ model: EMBED_MODEL, texts: ["a", "b"], dimensions: 3 }, rid())
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ProviderCallError);
    expect(err).toMatchObject({ kind: "partial_batch", succeededIndices: [0] });
  });

  it("a maxTokens-cut generateObject surfaces as validation, not a silent success", async () => {
    const schema = z.object({ ok: z.boolean() });
    // A MAX_TOKENS finish with a truncated (non-JSON) body → validation error.
    const body = {
      candidates: [{ content: { parts: [{ text: '{"ok":' }] }, finishReason: "MAX_TOKENS" }],
      usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 5 },
    };
    const { client } = clientOver(transportOf(200, body), { Cut: schema });
    const err = await client
      .generateObject({ model: GEN_MODEL, prompt: { ref: PROMPT_REFS.synthesisPlan }, input: "x", schema, schemaId: "Cut" }, rid())
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ProviderCallError);
    expect(err).toMatchObject({ kind: "validation" });
    expect((err as Error).message).toMatch(/MAX_TOKENS/);
  });

  it("a PRE-ABORTED call never transmits (cancelled, no receipt)", async () => {
    let transportCalls = 0;
    const transport: Transport = () => {
      transportCalls++;
      return Promise.resolve(new Response(JSON.stringify(generateTextResponse("x")), { status: 200 }));
    };
    const { client, receipts } = clientOver(transport);
    const ac = new AbortController();
    ac.abort();
    const err = await client
      .generateText({ model: GEN_MODEL, prompt: { ref: PROMPT_REFS.synthesize }, input: "hi", maxTokens: 64 }, rid(), ac.signal)
      .catch((e: unknown) => e);
    expect(err).toMatchObject({ kind: "cancelled" });
    expect(transportCalls).toBe(0);
    expect(receipts).toHaveLength(0);
  });
});

// ===========================================================================
// The FULL provider adapter matrix (provider-interface §7), PORTED verbatim from
// the retired broker's `egress.gemini-adapter.test` onto the models-owned
// `GeminiAdapter` (the adapter now lives in this package). Drives the adapter
// DIRECTLY through its ergonomic serialize→transmit→parse wrappers with an injected
// HTTP transport (doubles — no live key), so every taxonomy/retry/cancellation/
// pricing/prompt-resolution branch is exercised against the new implementation, not
// just the ~11-case invoker slice above. The live-Gemini smoke stays a separate,
// `ATLAS_LIVE_GEMINI`-gated skip.
// ===========================================================================

const MODEL = GEN_MODEL;

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

  it("generateText drops thought parts (thought: true) — reasoning traces never release", async () => {
    const body = {
      candidates: [{ content: { parts: [
        { text: "Let me check the org notes first…", thought: true },
        { text: "Rotem Arel leads the Cloud team." },
      ] } }],
      usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 5 },
    };
    const transport: Transport = () => Promise.resolve(jsonResponse(body));
    const adapter = new GeminiAdapter({ apiKey: "k", transport, sleep: noSleep });
    const r = await adapter.generateText(textReq);
    expect(r.text).toBe("Rotem Arel leads the Cloud team.");
  });

  it("rejects a cross-operation / non-allowlisted model before transport (model_incompatible)", async () => {
    const transport = vi.fn<Transport>(() => Promise.resolve(jsonResponse(textCandidate("x"))));
    const adapter = new GeminiAdapter({ apiKey: "k", transport, sleep: noSleep });
    await expect(adapter.generateText({ ...textReq, model: EMBED_MODEL })).rejects.toMatchObject({ kind: "model_incompatible", retryable: false });
    expect(transport).not.toHaveBeenCalled();
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
    expect(transport).toHaveBeenCalledTimes(1);
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
    expect(sleep).toHaveBeenCalledWith(2000);
    expect(transport).toHaveBeenCalledTimes(2);
  });

  it("surfaces rate_limit with retryAfterMs when retries are exhausted", async () => {
    const transport: Transport = () => Promise.resolve(jsonResponse({}, { status: 429, headers: { "retry-after": "1" } }));
    const adapter = new GeminiAdapter({ apiKey: "k", transport, maxRetries: 1, sleep: noSleep });
    const err = await adapter.generateText(textReq).catch((e: unknown) => e);
    expect(err).toMatchObject({ kind: "rate_limit", retryable: true, retryAfter: 1000, retryAfterMs: 1000 });
  });

  it("maps quota (429 w/ RESOURCE_EXHAUSTED in the body) to quota, retryable:true", async () => {
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

describe("GeminiAdapter — error mapping is driven by the scanned body", () => {
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

describe("GeminiAdapter — conservative pricing + official model id", () => {
  it("prices gemini-3.5-flash conservatively (>= published standard tier)", () => {
    const adapter = new GeminiAdapter({ apiKey: "k" });
    expect(adapter.costMicros("gemini-3.5-flash", { inputTokens: 1000, outputTokens: 1000 })).toBe(10500);
    expect(adapter.costMicros("gemini-embedding-001", { inputTokens: 1000 })).toBe(150);
  });

  it("returns null (unpriced ⇒ refused) for an unknown model", () => {
    const adapter = new GeminiAdapter({ apiKey: "k" });
    expect(adapter.costMicros("gemini-3-5-flash", { inputTokens: 1 })).toBeNull();
    expect(adapter.costMicros("made-up", { inputTokens: 1 })).toBeNull();
  });

  it("serializes the official gemini-3.5-flash id in the request path", () => {
    const adapter = new GeminiAdapter({ apiKey: "k" });
    const s = adapter.serialize("generateText", textReq);
    expect(s.path).toContain("gemini-3.5-flash");
    expect(() => adapter.serialize("generateText", { ...textReq, model: "gemini-3-5-flash" })).toThrow();
  });
});

describe("GeminiAdapter — prompt.ref resolution", () => {
  it("RESOLVES prompt.ref into the EXACT serialized generateText body (scanned bytes carry the prompt)", () => {
    const adapter = new GeminiAdapter({ apiKey: "k" });
    const s = adapter.serialize("generateText", textReq);
    const body = JSON.parse(Buffer.from(s.bytes).toString("utf8")) as {
      systemInstruction?: { parts?: { text?: string }[] };
      contents?: { parts?: { text?: string }[] }[];
    };
    const sys = body.systemInstruction?.parts?.[0]?.text ?? "";
    expect(sys).toContain("source-extraction");
    expect(body.contents?.[0]?.parts?.[0]?.text).toBe(textReq.input);
  });

  it("RESOLVES prompt.ref into the generateObject body too", () => {
    const adapter = new GeminiAdapter({ apiKey: "k" });
    const s = adapter.serialize("generateObject", { model: MODEL, prompt: { ref: "prompts/classify@1" }, input: "x", schemaId: "T" } as GenerateObjectRequest);
    const raw = Buffer.from(s.bytes).toString("utf8");
    expect(raw).toContain("source-classification");
  });

  it("serializes the synthesis-plan ref against the DEFAULT registry (#210 regression)", () => {
    const adapter = new GeminiAdapter({ apiKey: "k" });
    const s = adapter.serialize("generateObject", { model: MODEL, prompt: { ref: PROMPT_REFS.synthesisPlan }, input: "{}", schemaId: "ChangePlan" } as GenerateObjectRequest);
    const raw = Buffer.from(s.bytes).toString("utf8");
    expect(raw).toContain("synthesis-plan step");
  });

  it("releases the candidate finishReason on generateText and counts thought tokens as output (#211)", () => {
    const adapter = new GeminiAdapter({ apiKey: "k" });
    const json = {
      candidates: [{ content: { parts: [{ text: "cut answ" }] }, finishReason: "MAX_TOKENS" }],
      usageMetadata: { promptTokenCount: 100, candidatesTokenCount: 40, thoughtsTokenCount: 980 },
    };
    const parsed = adapter.parse("generateText", textReq, Buffer.from(JSON.stringify(json)));
    expect(parsed.result).toMatchObject({ text: "cut answ", finishReason: "MAX_TOKENS" });
    expect(parsed.usage).toEqual({ inputTokens: 100, outputTokens: 1020 });
    const plain = adapter.parse("generateText", textReq, Buffer.from(JSON.stringify(textCandidate("ok"))));
    expect((plain.result as { finishReason?: string }).finishReason).toBeUndefined();
    expect(plain.usage).toEqual({ inputTokens: 10, outputTokens: 5 });
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
    expect(() => adapter.serialize("generateText", textReq)).toThrow();
  });
});

describe("GeminiAdapter — timeouts / transport", () => {
  it("maps 504 to timeout (retryable) and retries then fails", async () => {
    const transport = vi.fn<Transport>(() => Promise.resolve(jsonResponse({}, { status: 504 })));
    const adapter = new GeminiAdapter({ apiKey: "k", transport, maxRetries: 2, sleep: noSleep });
    await expect(adapter.generateText(textReq)).rejects.toMatchObject({ kind: "timeout", retryable: true });
    expect(transport).toHaveBeenCalledTimes(3);
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

  it("aborts DURING a long Retry-After backoff without sleeping it out", async () => {
    const transport: Transport = () => Promise.resolve(jsonResponse({ error: { status: "UNKNOWN" } }, { status: 429, headers: { "retry-after": "10" } }));
    let slept = false;
    const realSleep = (ms: number): Promise<void> => new Promise((r) => { slept = true; setTimeout(r, ms); });
    const adapter = new GeminiAdapter({ apiKey: "k", transport, maxRetries: 2, sleep: realSleep });
    const ac = new AbortController();
    const started = Date.now();
    const p = adapter.generateText(textReq, ac.signal).catch((e: unknown) => e);
    await new Promise((r) => setTimeout(r, 30));
    ac.abort();
    const err = await p;
    expect(err).toMatchObject({ kind: "cancelled" });
    expect(slept).toBe(true);
    expect(Date.now() - started).toBeLessThan(2000);
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
    // Resolve the key the SAME way production does (ATLAS_GEMINI_API_KEY else the
    // Keychain via `resolveGeminiApiKey`) — the obsolete ATLAS_GEMINI_KEY env is gone.
    const adapter = new GeminiAdapter({ apiKey: resolveGeminiApiKey() });
    const r = await adapter.generateText({ ...textReq, input: "Say the single word: ping" });
    expect(typeof r.text).toBe("string");
  });
});

// ===========================================================================
// Runtime invoke-params validation (restores the socket-protocol boundary check).
// The invoker now parses EgressInvokeParams before any key resolution / transport,
// so a malformed maxTokens / dimensions / runId, an extra field, or a mismatched
// operation/request shape is a terminal `validation` error that NEVER reaches the
// adapter (and never resolves a credential).
// ===========================================================================

describe("createInProcessInvoker — malformed invoke params are rejected at the boundary", () => {
  /** An adapter whose transport MUST NOT be reached (malformed input never dispatches). */
  function neverAdapter(): { invoker: ReturnType<typeof createInProcessInvoker>; calls: () => number } {
    let calls = 0;
    const transport: Transport = () => { calls++; return Promise.resolve(new Response("{}", { status: 200 })); };
    const adapter = new GeminiAdapter({ apiKey: "k", transport, maxRetries: 0 });
    return { invoker: createInProcessInvoker({ adapter }), calls: () => calls };
  }

  it("rejects a non-positive / non-integer maxTokens (validation, no transport)", async () => {
    const { invoker, calls } = neverAdapter();
    const err = await invoker(
      { runId: newRunId(), body: { operation: "generateText", request: { model: MODEL, prompt: { ref: PROMPT_REFS.synthesize }, input: "hi", maxTokens: 0 } } } as never,
    ).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ProviderCallError);
    expect(err).toMatchObject({ kind: "validation", retryable: false });
    expect(calls()).toBe(0);
  });

  it("rejects a non-positive embed dimensions (validation, no transport)", async () => {
    const { invoker, calls } = neverAdapter();
    const err = await invoker(
      { runId: newRunId(), body: { operation: "embed", request: { model: EMBED_MODEL, texts: ["a"], dimensions: -3 } } } as never,
    ).catch((e: unknown) => e);
    expect(err).toMatchObject({ kind: "validation", retryable: false });
    expect(calls()).toBe(0);
  });

  it("rejects an empty runId (validation, no transport)", async () => {
    const { invoker, calls } = neverAdapter();
    const err = await invoker(
      { runId: "", body: { operation: "generateText", request: { model: MODEL, prompt: { ref: PROMPT_REFS.synthesize }, input: "hi", maxTokens: 8 } } } as never,
    ).catch((e: unknown) => e);
    expect(err).toMatchObject({ kind: "validation" });
    expect(calls()).toBe(0);
  });

  it("rejects a non-ULID / traversal-shaped runId, leaving resolver + transport + sink untouched", async () => {
    // Wing round-3: runId must be a canonical ULID, not any nonempty string. A value
    // like "../x" would pass a bare `min(1)` check, reach Gemini, then blow up later in
    // DurableReceiptSink's filename-safe guard — transmitting then losing the durable
    // receipt row. Prove it dies at the boundary: no key resolution, no transport, no
    // receipt.
    let resolverCalls = 0;
    let transportCalls = 0;
    const transport: Transport = () => { transportCalls++; return Promise.resolve(new Response("{}", { status: 200 })); };
    const receipts: ModelCallReceipt[] = [];
    const invoker = createInProcessInvoker({
      resolveApiKey: () => { resolverCalls++; return "k"; },
      transport,
    });
    const client = new ModelsClient(invoker, (r) => { receipts.push(r); });
    const err = await client
      .generateText({ model: MODEL, prompt: { ref: PROMPT_REFS.synthesize }, input: "hi", maxTokens: 8 }, { runId: "../x" })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ProviderCallError);
    expect(err).toMatchObject({ kind: "validation", retryable: false });
    expect(resolverCalls).toBe(0); // never resolved a credential
    expect(transportCalls).toBe(0); // never transmitted
    expect(receipts).toHaveLength(0); // no receipt handed to the sink
  });

  it("rejects an unknown extra field on the request (strict schema, no transport)", async () => {
    const { invoker, calls } = neverAdapter();
    const err = await invoker(
      { runId: newRunId(), body: { operation: "generateText", request: { model: MODEL, prompt: { ref: PROMPT_REFS.synthesize }, input: "hi", maxTokens: 8, smuggled: "x" } } } as never,
    ).catch((e: unknown) => e);
    expect(err).toMatchObject({ kind: "validation" });
    expect(calls()).toBe(0);
  });

  it("rejects a mismatched operation/request shape (embed body under generateText, no transport)", async () => {
    const { invoker, calls } = neverAdapter();
    const err = await invoker(
      { runId: newRunId(), body: { operation: "generateText", request: { model: EMBED_MODEL, texts: ["a"], dimensions: 4 } } } as never,
    ).catch((e: unknown) => e);
    expect(err).toMatchObject({ kind: "validation" });
    expect(calls()).toBe(0);
  });
});

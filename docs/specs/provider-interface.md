# Provider interface contract — Atlas V1 Phase 2

> **SUPERSEDED (2026-07-22, phase-2-in-process-cutover · task 2.1).** The IPC/egress-broker
> framing this document mandates is **retired**. The Gemini adapter, the provider credential, and
> the outbound network now live **IN-PROCESS** inside `@atlas/models`: there is **no egress-broker
> seam, no run-bound capability, no in-broker payload/response scan, and no per-run budget**, and the
> operation signatures are `(req, run: RunBinding, signal?)` — a `RunBinding` (`{ runId }`), NOT a
> `(req, cap, signal?)` capability arg. The **normative** description of the surviving in-process
> interface is the `@atlas/models` package doc + code: [`packages/models/CLAUDE.md`](../../packages/models/CLAUDE.md)
> and `packages/models/src/client.ts` (`ModelsClient`, `createInProcessInvoker`, `EgressInvokeParams`).
> The sections below are retained **for historical reference only** (request/result shapes, batch
> semantics, the `AbortSignal` contract, and the `ProviderError` taxonomy binding are still accurate;
> everything about the broker seam / capability / in-broker scan is not).

**Owner task:** 2.0 · **Consumed by:** Task 2.8 (`@atlas/models` typed IPC client + the Gemini adapter
inside the egress broker). This fixes the request/result types, batch semantics, the `AbortSignal`
contract, and the binding to the `ProviderError` taxonomy (`@atlas/contracts`). The adapter is
**extraction/classification/synthesis only** — it is provably restricted to non-mutating provider
calls; it never touches the vault, git, or the ledger.

> Seam _(historical — superseded above)_. Every provider call crossed the egress-broker IPC seam
> (D10). The request/result shapes here are the framed-JSON messages validated by `@atlas/contracts`
> schemas on both sides. Each call carried a run-bound capability (D19) and was scanned in-broker
> (payload + response). This contract defined the CLIENT surface; the broker's capability/budget/scan
> enforcement was Task 2.8.

## 1. Operations

Three non-mutating operations. All are `AbortSignal`-aware and adapter-retry-owned.

- `generateText(req, cap, signal?) → GenerateTextResult` — free-form generation (extraction/synthesis
  prompt).
- `generateObject<T>(req, cap, signal?) → T` — schema-constrained generation. **Schemas are
  registered by ID, never sent over IPC** (a Zod object cannot cross the process seam): the request
  carries only a `schemaId` string that names an entry in the shared `@atlas/contracts` schema
  registry (e.g. `"ChangePlan"`). The broker-side adapter resolves `schemaId` to the SAME registered
  Zod schema the caller referenced, validates the model output against it, and maps a violation to
  `ProviderError{ kind: "validation" }`. The typed result `T` is the caller's `z.infer` of that
  registered schema. An unknown `schemaId` is a `ProviderError{ kind: "validation" }` (fail-closed).
- `embed(req, cap, signal?) → EmbedResult` — batch embeddings; `dimensions` pinned by config (D7:
  768).

## 2. Request / result types

```json providerRequestExample
{
  "generateText": {
    "model": "gemini-3-5-flash",
    "prompt": { "ref": "prompts/extract-claims@1" },
    "input": "<normalized source text>",
    "maxTokens": 2048,
    "temperature": 0
  },
  "generateObject": {
    "model": "gemini-3-5-flash",
    "prompt": { "ref": "prompts/classify@1" },
    "input": "<normalized source text>",
    "schemaId": "ChangePlan"
  },
  "embed": {
    "model": "gemini-embedding-001",
    "texts": ["chunk-1", "chunk-2"],
    "dimensions": 768
  }
}
```

```json providerResultExample
{
  "generateText": { "text": "…", "usage": { "inputTokens": 1200, "outputTokens": 340 }, "model": "gemini-3-5-flash" },
  "embed": {
    "vectors": [[0.01, 0.02], [0.03, 0.04]],
    "dimensions": 768,
    "usage": { "inputTokens": 24 }
  }
}
```

- `PromptRef` is an identifier + version (`prompts/<name>@<n>`) — never an inline raw prompt in the
  audit/ledger surface (allowlisted metadata only).
- `schemaId` is a **registry key**, not a serialized schema: both the CLI caller and the broker
  adapter resolve it against the shared `@atlas/contracts` schema registry, so only the string
  crosses IPC. The framed `generateObject` request therefore carries `schemaId` (as in the example),
  never a schema body; the adapter's output validation runs broker-side against the resolved schema.
- `usage` carries token counts for the per-run cost/byte budget (D19) and the `model_calls` ledger
  row.

## 3. Batch semantics (`embed`)

- `embed` accepts N texts and returns N vectors in input order.
- A partial batch failure is surfaced as `ProviderError{ kind: "partial_batch", succeededIndices:
  number[] }` — the input-order indices whose vectors computed. **A partial batch is never persisted
  as complete**; the caller re-drives only the indices absent from `succeededIndices`. `dimensions`
  in the result MUST equal the requested value or the whole result is a `validation` error (dimension
  drift opens a new index generation by construction, D7).

## 4. `AbortSignal` contract

- Every operation accepts an optional `AbortSignal`. Abort before the call ⇒ immediate
  `ProviderError{ kind: "cancelled", retryable: false }` with zero provider round-trips.
- Abort during the call ⇒ the in-flight request is cancelled and `cancelled` is returned; no partial
  result is persisted.
- Abort mid-batch (`embed`) ⇒ `cancelled`; already-computed vectors are discarded (not returned as a
  partial success).

## 5. Error taxonomy binding

Every failure maps to exactly one `ProviderError` kind from `@atlas/contracts`
(`validation | authentication | quota | rate_limit | timeout | transport | cancelled | partial_batch
| model_incompatible`), each carrying `{ retryable, retryAfter? }`. `retryAfter` (ms) is propagated
from a provider `Retry-After` into the CLI error envelope's `retryAfterMs`. These examples validate
against `ProviderErrorSchema`:

```json providerErrors
[
  { "kind": "rate_limit", "retryable": true, "retryAfter": 2000, "message": "rate limited" },
  { "kind": "authentication", "retryable": false, "message": "invalid api key" },
  { "kind": "timeout", "retryable": true },
  { "kind": "validation", "retryable": false, "message": "model output failed schema" },
  { "kind": "partial_batch", "retryable": true, "succeededIndices": [0, 1, 3] },
  { "kind": "model_incompatible", "retryable": false },
  { "kind": "quota", "retryable": true, "retryAfter": 60000 },
  { "kind": "transport", "retryable": true },
  { "kind": "cancelled", "retryable": false }
]
```

Mapping rules (adapter-owned):

- `authentication` ⇒ stable `authentication`, `retryable: false`, **zero retries**, sanitized
  diagnostics (never the key).
- `rate_limit`/`quota`/`timeout`/`transport`/`partial_batch` ⇒ `retryable: true` (subject to the
  adapter's bounded retry). `rate_limit` and `quota` both propagate provider `Retry-After` into
  `retryAfter` when supplied. **`quota` has exactly one mapping — `retryable: true`** (a provider
  quota clears with time; it is classified `transient` in `jobs-contract.md §2`, never `permanent`).
- `validation`/`model_incompatible`/`cancelled` ⇒ `retryable: false`.

## 6. Non-mutation guarantee

- The adapter performs ONLY provider I/O. It has no vault/git/ledger handle and cannot emit a
  `ChangePlan` mutation — synthesis output is returned to the CLI, which drives the mutation through
  the validated ChangePlan → patch → git path (Phase 4).
- Phase-2 operation gate (`policies.operationGate`, Task 2.8): capture/projection ops allowed,
  synthesis ops rejected fail-closed, reserved task ops rejected always.

## 7. Acceptance (implemented by Task 2.8 tests)

- The adapter suite exercises malformed/truncated output, schema violations, timeouts, rate-limit
  `retryAfter → retryAfterMs`, cancellation before/during/mid-batch, and auth failures with the
  stable mappings above.
- `ATLAS_LIVE_GEMINI=1` smoke passes nightly; no provider key readable outside `atlas-egress`.

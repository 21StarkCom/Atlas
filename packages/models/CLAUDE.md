# `@atlas/models` — CLI-side typed IPC client for the egress broker

**Purpose.** The CLI-side, capability-bound wire client for the three non-mutating provider ops — `generateText` / `generateObject<T>` / `embed` — plus CLI-side capability minting (D19) and `model_calls` ledger persistence (D6/D18). It **never touches a provider key, the outbound network, the Gemini adapter, or the payload scan**: all of those live INSIDE `@atlas/broker`, which runs as the separate `atlas-egress` OS identity. This package is the *client half* of the D10 egress seam (`src/index.ts:1-8`, `src/client.ts:1-16`).

Normative spec (owner Task 2.0, consumed by Task 2.8): [`docs/specs/provider-interface.md`](../../docs/specs/provider-interface.md). Response-scan boundary: [`docs/adr/0001-egress-response-scan-released-bytes.md`](../../docs/adr/0001-egress-response-scan-released-bytes.md). Root constitution: [`../../CLAUDE.md`](../../CLAUDE.md).

## How it fits

- **Depends on** `@atlas/broker` (owns the request/result/receipt types, the `.strict()` Zod schemas, `ProviderCallError`/`EgressRefusal`, `mintEgressCapability`), `@atlas/contracts` (`SCHEMA_REGISTRY`), `@atlas/sqlite-store` (`finalizeLedgerWrite`), `zod`. Dev-only: `@atlas/scan`, `@atlas/testing`.
- **Consumed by** `apps/cli` (query/index/enrich commands mint a capability, drive the client, journal + persist receipts).
- `package.json`: `private`, `version: 0.0.0` — no semver (playground posture). Build `tsc -p tsconfig.json`; test `vitest run --passWithNoTests`.

## Key files

| File | Role |
|------|------|
| `src/client.ts` | `ModelsClient` — the three ops, `connect()`, mandatory receipt emission, abort handling, schema-identity fail-closed. |
| `src/capability.ts` | `mintEgressCapability(run, limits)` over a custody-resolved shared secret; `setCapabilityMintSecretResolver`, `CAPABILITY_KEY_ENV`. |
| `src/ledger.ts` | `persistModelCalls`, `buildModelCallStatement`, `modelCallId`, `modelCallAuditRecord`, `ModelCallAuditRecordSchema` — CLI-side `model_calls` write via `finalizeLedgerWrite`. |
| `src/receipt-journal.ts` | `DurableReceiptSink`, `loadJournaledReceipts`, `finalizeRunModelCalls` — crash-safe per-run receipt journal. |
| `src/types.ts` | Re-export shim for the broker-owned request/result/receipt shapes + errors; also defines `ReceiptSink`. |
| `src/index.ts` | Barrel. |
| `test/harness.ts` | Wires the REAL cross-store path in-process (temp git repo, F4 audit-signing `BrokerService` in `testMode`, file-backed `Store`, `EgressService` + injectable `fakeAdapter`, in-memory quarantine) — no OS provisioning. |
| `test/models-client.test.ts` | Typed client surface (9 cases). |
| `test/egress.bypass.test.ts` | In-broker secret block + quarantine + `model_calls` persistence + durable journal + D17 Seatbelt layer (7 cases). |

**The load-bearing provider code lives in `@atlas/broker`** (not in scope but you'll trace into it): `packages/broker/src/egress/{gemini.ts,provider-error.ts,types.ts,capability.ts,scan.ts,server.ts}`. `egress/types.ts` defines the `.strict()` Zod schemas this package re-exports. **To change a contract, edit the broker — not here.**

## Public surface (essentials)

- `ModelsClient(invoker, receiptSink, { schemaRegistry? })` — `receiptSink` is **MANDATORY** (D6/D18). `static connect(socketPath, receiptSink, opts)` connects via `EgressClient.connect`.
- The 3rd arg to every op is `SignalOrOptions = AbortSignal | CallOptions`. A **bare `AbortSignal` MUST work** (provider-interface §1 signature `(req, cap, signal?)`); `toCallOptions` duck-types the signal (`aborted` boolean + `addEventListener`), never `instanceof` — cross-realm safe (`src/client.ts:65-73`).
- `GenerateObjectClientRequest<T>` (`src/client.ts:76`) carries BOTH the caller's Zod `schema` (types `T`, re-validates locally) AND the `schemaId` string — only the id crosses IPC.
- `mintEgressCapability(run: RunBinding, limits: EgressLimits, opts?)` — `opts` (`secret`/`keyId`/`now`/`nonce`) is TESTS-ONLY; production resolves the secret from custody via `@atlas/broker`'s shared `resolveCapabilitySecret` — the SAME resolver the egress daemon verifies with, so the two ends cannot drift on representation. It accepts the custody-**path** form (`ATLAS_EGRESS_CAPABILITY_KEY`) or the command-scoped **fd** form (`ATLAS_EGRESS_CAPABILITY_KEY_FD`, how the #60 launchd sync wrapper hands the Keychain value to the drain); fd wins when both are set, and absent/unreadable/empty custody throws (never an empty-key mint). Constants: `CAPABILITY_KEY_ENV = "ATLAS_EGRESS_CAPABILITY_KEY"`, `CAPABILITY_KEY_FD_ENV = "ATLAS_EGRESS_CAPABILITY_KEY_FD"`, `DEFAULT_CAPABILITY_KEY_ID = "atlas-egress-cap-v1"`, `DEFAULT_CAPABILITY_TTL_SECONDS = 300` (matches the broker nonce TTL).
- `modelCallId(runId, requestHash)` = `mc_` + first 32 hex of `sha256(runId \0 requestHash)` — the deterministic idempotency key (`src/ledger.ts:42-45`). `buildModelCallStatement` → `INSERT ... ON CONFLICT(call_id) DO NOTHING`; row is cost/usage-only (DDL owned by `0001_core`, §2.7).

## Invariants & guardrails

- **Client-only; zero credential/network/scan access.** Everything provider-facing is broker-side (`src/client.ts:1-16`).
- **Schema-identity fail-closed** (`src/client.ts:158-164`): `generateObject` rejects a caller whose Zod `schema` is not **reference-identical** to the one registered for `schemaId` in `@atlas/contracts` (`SCHEMA_REGISTRY`; a test may inject an overlay). Throws `ProviderCallError{ kind:"validation", retryable:false }` with **no transmission**. Unknown `schemaId` → same error. Guarantees CLI and broker never validate against different schemas.
- **Exactly one receipt per transmission** (D6/D18): every success, refusal, OR provider error hands its receipt to the sink BEFORE the method returns/throws (`settle`, `src/client.ts:216-223`). A `model_calls` row is written for refused/errored transmissions too, with tokens/cost actually consumed (0 for a pre-flight refusal).
- **Pre-abort never transmits** (`assertNotAborted`, `src/client.ts:209-213`): an already-aborted call throws `ProviderCallError{ kind:"cancelled" }` with **zero round-trips and no receipt**. An in-flight abort still yields an `error`-outcome receipt (the call was dispatched).
- **Audit cardinality D6:** many transmissions attach to a run's SINGLE terminal audit event — a transmission does NOT emit its own `run.*` event. `persistModelCalls` folds ALL a run's receipts into ONE `finalizeLedgerWrite` (`src/ledger.ts:98-125`). Proof: 3 calls → 3 `model_calls` rows, 1 `audit_events` row (`test/egress.bypass.test.ts:144-167`).
- **Idempotent per `(runId, requestHash)`:** re-driving is a no-op via the derived `call_id` + `ON CONFLICT DO NOTHING` (`test/egress.bypass.test.ts:77-97`).
- **No lost receipt across a crash:** `DurableReceiptSink` fsync's each NDJSON line to `<dir>/<runId>.receipts` BEFORE the call returns; a crash before finalize leaves the journal, and the next `finalizeRunModelCalls` unions journal ∪ in-memory, dedups by `(runId, requestHash)`, finalizes once, then clears (`src/receipt-journal.ts`). `journalPath` refuses a non-filename-safe `runId` (traversal guard, `:26-30`).
- **Audit record cannot drift from the receipt contract:** `ModelCallAuditRecordSchema` is DERIVED from the SSOT `ModelCallReceiptSchema` (`.omit({runId}).extend({callId}).strict()`) — every carried field keeps the receipt's strict validation (`sha256:` hashes, enums, non-negative-int metrics); `.strict()` rejects any non-allowlisted key. Consumers MUST share it, never hand-copy (`src/ledger.ts:138-141`).
- **Mint secret custody:** the capability-MAC secret is **shared** (CLI mints, broker verifies), so it is NOT in the `atlas-egress`-only `0700` keys dir — it lives at a CLI-readable custody path named by `ATLAS_EGRESS_CAPABILITY_KEY`, read via the injectable resolver (`src/capability.ts`). Caller passes only `(run, limits)`.
- **`embed` batch semantics** (provider-interface §3): N vectors in input order; result `dimensions` MUST equal the requested value or it's a `validation` error (dimension drift opens a new index generation, D7). A `partial_batch` error names `succeededIndices`; a partial batch is **never persisted as complete** — the caller re-drives only the missing indices.

## Gotchas & sharp edges

- **This package re-exports almost everything from `@atlas/broker`.** The types, `ProviderCallError`/`EgressRefusal`, schemas, and `mintEgressCapability` are broker-defined and merely re-surfaced (`src/types.ts`, `src/capability.ts`). Edit contracts in the broker.
- **No single-error-envelope command emits exit 7.** The provider-interface taxonomy names exit 7 (provider-retryable), and the CLI `EXIT` set caps at 6 (`apps/cli/src/errors/envelope.ts:15,26`; `ExitCode = 1 | 2 | 3 | 4 | 5 | 6`). Retryability rides on `ProviderCallError.retryable` + `retryAfterMs`, which the jobs runner consumes — and the `jobs run` batch aggregate IS the one process path that can return 7 (jobs-run schema `exitCode` enum). `query` maps a retryable provider/embed failure to **exit 4 (INTERNAL)** carrying `retryable`/`retryAfterMs` (`apps/cli/src/commands/query.ts:607-628`); `index rebuild/repair` maps a retryable partial to **exit 6 (ACTION_REQUIRED)** with per-item `retryable` flags (`apps/cli/src/commands/index-ops.ts:189-193`). Outside that batch path, treat exit 7 as a taxonomy label, not a code you can code against.
- **`retryable` is FIXED per error kind, never caller-chosen** — the broker's `providerError()` computes it: retryable = NOT (`validation`|`authentication`|`cancelled`|`model_incompatible`) (`packages/broker/src/egress/provider-error.ts:72`). `quota` maps to `retryable:true` (classified `transient` in jobs-contract §2). `retryAfter` is present only for `rate_limit`/`quota` and is propagated into both `retryAfter` and the CLI alias `retryAfterMs`.
- **`model_calls.operation` semantic label needs a caller override.** The IPC surface has 3 operations, but the ledger domain is `generate|extract|classify|synthesize|embed`. `buildModelCallStatement` defaults to the structural `OPERATION_MAP` (`generateText`/`generateObject`→`generate`, `embed`→`embed`, `src/ledger.ts:35-39`); the semantic label (`extract` vs `synthesize`) is a per-receipt `operationFor` override on `persistModelCalls` (`src/ledger.ts:88,104-108`). Without it, extraction and synthesis are indistinguishable in the ledger.
- **`effectiveSensitivity` is a Phase-2 placeholder.** `CallOptions.declaredSensitivity` defaults to `internal` (`DEFAULT_SENSITIVITY`) and passes straight through as `effectiveSensitivity` until Task 4.3 gives it real resolution (`src/client.ts:46-53`).
- **What `generateText().text` actually contains is decided broker-side.** Gemini 3.5 thinking responses interleave `thought:true` parts; the adapter's `extractText` drops them so raw reasoning never releases (`packages/broker/src/egress/gemini.ts:594-597`, PR #149). Invisible here but load-bearing for callers.
- **The response scan runs on RELEASED bytes, not the raw envelope** (ADR-0001, #146/#148). Gemini attaches an opaque ~1–4 KB base64 `thoughtSignature` to every response — secret-shaped, and `thinkingBudget:0` doesn't remove it — so raw-bytes scanning refused every answer. Requests + error/intermediate bodies still scan raw; receipts keep `responseHash` = sha256 of the RAW provider bytes.
- **The D17 OS-layer bypass test is provisioning-gated.** The Seatbelt-layer check runs unprivileged on macOS with a mandatory positive control and LOUD-SKIPs when the host can't reach the probe URL unsandboxed (`test/egress.bypass.test.ts:215-243`); the per-UID pf-anchor layer needs root and is asserted by the provisioning suite. The in-process harness needs no `ATLAS_PROVISIONED`/`ATLAS_LIVE_GEMINI`.

## History (real PR numbers)

- **#61** — Phase-0 scaffold (`package.json`, `tsconfig`, stub `index.ts`).
- **#67** — Phase-2 contracts gate: `docs/specs/provider-interface.md` (the normative request/result/batch/AbortSignal/error-taxonomy contract).
- **#76** — the whole package lands with the egress broker + operation gate, plus the D17 sandbox-escape fix (`(allow process-exec (with no-sandbox))` in `agent.sb` ran the exec'd child with NO profile, so `(deny network*)` was a no-op; the rewritten bypass test proves denial with a positive control). Also: NUL bytes in the composite-key template literals made git treat the source as binary — replaced with escapes.
- **#79** — Phase-2 exit test + observability release gate: hardened `ledger.ts` so `TerminalExtras.detail` no longer accepts arbitrary data into the signed audit ref — this is where the narrow, DERIVED `ModelCallAuditRecordSchema` was introduced.
- **#146/#148 (ADR-0001)** + **#149** (both broker) — response scan on released bytes; Gemini parse drops `thought:true` parts. Both change what this client observes without touching it.

## Open items

- **`effectiveSensitivity` real resolution deferred to Task 4.3** (`src/client.ts:52`).
- **Ledger semantic-operation labeling** — `extract`/`classify`/`synthesize` recorded only when the caller supplies `operationFor`; otherwise everything collapses to `generate`.
- **Exit-7 taxonomy vs binary divergence** is unresolved by design — call it out wherever the exit set is documented: only the `jobs run` batch aggregate returns exit 7; no single-command run does.
- **`db rebuild --from-git` does NOT reproduce `model_calls`** — Task 4.11 shipped (`apps/cli/src/workflows/rebuild-from-git.ts`) and resolved this by surfacing ledger state (incl. `model_calls`) as an explicit DR **gap**: those rows live only in SQLite + the AEAD backup, never in canonical Markdown.

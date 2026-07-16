# 0001 — Egress response scan runs on the RELEASED bytes, not the raw provider envelope

- **Status:** accepted
- **Date:** 2026-07-16
- **Issue:** #146

## Context

The egress broker scans every transmission in-broker with `@atlas/scan`
(INVARIANT 2). Until this ADR, both directions scanned the **exact raw HTTP
bytes**: the serialized request before dispatch, and the raw 2xx response
before parse (error/intermediate bodies via the transmit hook).

Gemini 3.5 attaches a **`thoughtSignature`** to every `generateContent`
response — an opaque ~1–4 KB base64 reasoning signature. By shape it is
indistinguishable from a real secret (a long, contiguous, digit-bearing
high-entropy run is precisely what the entropy rule exists to flag), and
`thinkingConfig.thinkingBudget: 0` shrinks but does not remove it. Result:
**every** `generateText` through the broker was refused
(`egress.secret_detected`, response direction) — observed on the 2026-07-16
live drive. Thinking-era provider envelopes make this structural: an
unavoidable high-entropy blob rides in every response.

## Decision

For the **final (2xx) response only**, the scan boundary moves from the raw
provider envelope to the **canonical serialization of the RELEASED result** —
the exact typed value (`generateText` text, `generateObject` object, `embed`
vectors + usage) the broker returns to the CLI. Order becomes
parse → serialize released result → scan → release.

Unchanged:
- The **request** direction still scans the exact serialized HTTP bytes.
- **Error and intermediate-retry bodies** are still scanned raw via the
  transmit hook (they are never parsed, so raw is their only form).
- A dirty released payload is still quarantined (ciphertext-only sealed spool)
  and the transmission refused with `egress.secret_detected`.

## Rationale

The response scan's threat model is **secret material re-entering the host**
(a provider echoing back a secret, which the CLI would then persist into the
ledger/vault). Envelope fields the adapter's `parse` step discards —
`thoughtSignature`, `responseId`, protocol metadata — never leave the broker
process and can reach no sink. Scanning bytes that are dropped on the floor,
and refusing the call over them, over-blocks without guarding anything: the
raw-envelope scan protected a boundary nothing crosses.

A secret echoed in the **generated text** (the actual re-entry vector) is in
the released bytes by definition and still blocks — the existing
echoed-secret test passes unchanged under the new boundary.

## Consequences

- `generateText`/`generateObject` work against thinking-era Gemini models.
- A secret hidden by the provider in a **discarded** envelope field is no
  longer refused. It also never re-enters the host (the broker drops it), so
  nothing downstream can persist it; the residual exposure — the bytes existed
  in broker memory — is identical to before (the scan never prevented that).
- The code-level "EXACT raw response bytes" wording (scan.ts / server.ts) is
  amended; the design SSOT's "secret-scans each request/response" still holds
  (each response's released content is scanned).
- Receipts keep `responseHash` = sha256 of the raw provider bytes (unchanged
  audit semantics).

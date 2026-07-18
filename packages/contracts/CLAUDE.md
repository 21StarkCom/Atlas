# `@atlas/contracts` — the process-seam leaf

**Zero-dependency (Zod-only) leaf** owning every value/type that must serialize
**byte-identically across the CLI ↔ broker process boundary**: stable IDs, canonical
serialization, the identity-key algorithm, the ChangePlan envelope + all 17 op payloads,
the run manifest, the audit/WORM/signer/authorization Zod mirrors, the provider-error
taxonomy, the `generateObject` schema registry, the note-type registry, and the shared
cross-boundary DTOs (D14).

**Why a leaf.** The CLI mints a plan/challenge/manifest; the broker (a separate OS
identity) independently re-derives and re-verifies it. Both sides must agree *to the byte*
or the signed audit chain / authorization verification / ChangePlan integrity breaks. One
shared package guarantees both sides run the *same* ID parser, the *same* canonicalizer, the
*same* schemas — no private copies that can drift. It also hosts the D14 structural DTOs so
workspace packages consume them from here rather than from `apps/cli`, which kills the
`package→app` build cycle (`src/index.ts` header states this).

Runtime deps: **`zod` + `node:crypto` only**. No `@atlas/*` dependency exists (and none may —
see guardrails). `private`, `version 0.0.0`, ESM, single export `.` → `dist/` via `tsc`.

## Where it fits

- **Consumers** (`@atlas/contracts: workspace:*`): `apps/cli` (re-exported via its `domain`
  layer), `packages/{broker,git,jobs,lancedb-index,models,scan,sources,sqlite-store}`,
  `tools/`. The broker uses it on **both** daemons — integration (`atlas-broker`) + egress
  (`packages/broker/src/egress/{schema-registry,provider-error,protocol}.ts`).
- **Specs it mirrors:** [`../../docs/specs/security-broker-contract.md`](../../docs/specs/security-broker-contract.md)
  (audit, authorization, canonicalization, opaque-id rules — §5/§5.1/§6/§7/§8.2/§9/§12)
  and [`../../docs/specs/2026-07-11-atlas-v1-design.md`](../../docs/specs/2026-07-11-atlas-v1-design.md)
  (ChangePlan ops, claims & provenance). `SCHEMA_REGISTRY` is the `generateObject` seam from
  [`../../docs/specs/provider-interface.md`](../../docs/specs/provider-interface.md); the type
  registry drives graduation
  ([`../../docs/specs/2026-07-16-open-type-system-spec.md`](../../docs/specs/2026-07-16-open-type-system-spec.md)).

## Key files (flat `src/` + `ops/`; barrel `src/index.ts` = the entire public surface)

- `ids.ts` — **the ONLY module that parses/serializes source handles (D3).** `ContentId`
  (`sha256:<hash>:<mediaType>`, 3 segments), `RenditionId` (+extractor/normalizer version,
  5 segments), `parseSourceHandle`. Also `newRunId` (ULID), `saltedOpaqueId`, `OPAQUE_ID_RE`.
- `canonical.ts` — `atlas-jcs-v1` (RFC 8785 JCS). `canonicalSerialize`→`Uint8Array`,
  `canonicalStringify`, `CANONICALIZATION_ID`. Pure, dependency-free.
- `identity.ts` — `atlas-identity-key-v1`: `normalizeIdentityKey`, `IDENTITY_KEY_VECTORS`,
  and the hand-pinned full Unicode case-fold table (`FULL_CASE_FOLD`, ~104 entries).
- `primitives.ts` — shared string-shape Zod: `Ulid`, `OpaqueId`, `CommitHash` (SHA-1),
  `Rfc3339Ms`, `Nonce`, `Ed25519Sig`/`Ed25519PubKey`, `Sha256Digest`, `SchemaVersion1`.
- `changeplan-envelope.ts` / `changeplan.ts` — stable Phase-1 wrapper + `RISK_TIERS`;
  `ChangePlanSchema` = `.strict()` envelope over the discriminated union of all 17 ops, with a
  load-time coverage invariant + a `superRefine` cross-field dispatcher.
- `ops/op-result.ts` — cross-op primitives: `CHANGE_PLAN_OPS` (SSOT list of 17 names),
  `RESERVED_OPS`, the enums, the generic `OpResult<Name,ErrorCode>` envelope.
- `ops/*` (14 files, barrel `ops/index.ts`) — one file per op-group. Each exports
  `<Op>OpSchema`, `<OP>_ERROR_CODES`, `<Op>Result`.
- `schema-registry.ts` — `SCHEMA_REGISTRY` (`schemaId`→Zod) + `resolveRegisteredSchema`. A Zod
  schema can't cross IPC, so `generateObject` carries a `schemaId` string both sides resolve
  here. **Seeded with `ChangePlan` only.**
- `run-manifest.ts`, `audit.ts`, `authorization.ts`, `provider-errors.ts`, `dtos.ts`
  (zero-runtime D14 types), `type-registry.ts` (open note-type system, `SCHEMA_VERSION = 1`).

## Invariants — do not break

- **Byte-identity across the seam IS the contract.** `test/contracts.operations.test.ts`
  spawns `serialize-op-worker.mjs` (a *separate* node process importing built `dist`) twice and
  asserts its stdout is identical run-to-run AND equal to the vitest process's own
  parse-then-serialize hashes — three independent processes, one canonical form.
- **No workspace package may import `apps/cli` (D14).** `test/contracts.no-app-import.test.ts`
  scans the whole `packages/` tree repo-wide and asserts zero offenders. This is what keeps the
  leaf a leaf. Never add an `@atlas/*` dep or an `apps/cli` import here.
- **`ChangePlanSchema` is `.strict()` at BOTH envelope and payload levels (R3-F2).** An unknown
  key is a hard rejection, never silently stripped — a stripped stowaway would make the two seam
  processes disagree on canonical bytes.
- **Load-time union-coverage invariant** (`changeplan.ts:78-87`): the union must cover *exactly*
  the 17 `CHANGE_PLAN_OPS` names — a mismatch throws at module load, not a silent gap. Adding or
  removing an op means updating `CHANGE_PLAN_OPS` **and** the union together.
- **Canonical rules** (`canonical.ts`, pinned by `contracts.canonical.test.ts`): UTF-8 no BOM;
  keys normalized to **NFC before sorting** (sort-then-normalize orders differently across
  processes); sort by UTF-16 code unit; `undefined`/absent omitted (never `null`);
  NaN/Infinity/bigint rejected; `undefined` in an array rejected (not coerced); NFC-collision
  keys rejected as ambiguous (no last-wins merge).
- **Source handles parsed ONLY in `ids.ts` (D3).** `ProvenanceRef`/`PinnedRenditionRef` validate
  via `parseSourceHandle` (R3-F4), not a local regex; `PinnedRenditionRef` requires
  `kind === "rendition"` (rejects a bare 3-segment contentId) so an extractor/normalizer upgrade
  can't silently re-point evidence.
- **`ProviderError` retryability is a literal per kind**, not caller-chosen:
  `rate_limit|quota|timeout|transport|partial_batch`⇒`true`;
  `authentication|validation|model_incompatible|cancelled`⇒`false`. `retryAfter` only on
  `rate_limit`/`quota`; `succeededIndices` on and only on `partial_batch`; every member `.strict()`.
- **`id` is immutable in V1.** `SetFrontmatterField` rejects `field:"id"` in-schema;
  `ProposeRename` cannot touch id (and rejects an empty rename).
- **Reserved ops (`CreateTask`,`UpdateTaskState`) ship validating schemas but are policy-rejected
  in V1** (`reserved-operation`) — they must round-trip like every other op so a future task
  workflow slots in without a schema break. `ProposeDelete` is intentionally absent from the gate
  (`ops/op-result.ts:25` — it's the Tier-3 Phase-4 `maintain`/`reconcile` op).
- **`classificationToSensitivity` never maps above `internal`** (`public`→`public`, else→
  `internal`; the vault forbids `confidential`/`secret`). Unknown `schemaId` → `undefined` so the
  caller maps it to a fail-closed `validation` error, never a silent unvalidated pass.

## Gotchas

- **Opaque-id length is pinned to the contract's EXAMPLES, not its prose** (`ids.ts:146-160`):
  prose says `…[:16bytes]` but every JSON example uses a 16-hex-char (8-byte) digest
  (`n_9f2c1a8e0b3d4f56`), so `saltedOpaqueId` truncates to 16 hex and `OPAQUE_ID_RE` follows.
  Latent discrepancy — worth a note in the security-broker-contract if prose is ever normative.
- **Some primitive schemas are deliberately lenient** (`primitives.ts`): `Ed25519Sig`/`PubKey`
  check only the `ed25519:` prefix, `Sha256Digest` only `sha256:` — the contract's JSON examples
  truncate bodies with `...` and those examples are the acceptance target
  (`contracts.authorization.test`). `CommitHash` is SHA-1 (40 hex) — V1.
- **`identity.ts` hand-maintains a full Unicode case-fold table** because `String.toLowerCase()`
  is simple 1:1 folding only — it leaves ligatures (ﬀ→ff, ﬁ→fi, ß→ss) intact and gets Greek final
  sigma wrong (ς→σ patched). Pinned to one Unicode version for cross-process determinism; a
  Unicode/CaseFolding revision is a conscious edit here, never automatic.
- **`LEDGER_EVENT_KINDS` are SQLite-only** (`db.backup|db.restore|db.force_unblock|
  evidence.retry_enqueued`) — NOT in the `refs/audit/runs` enumeration and NOT chained into the
  WORM anchor's `eventCount` (`audit.ts:43`). Easy to confuse with `AUDIT_EVENT_KINDS` (the 10
  `run.*` kinds).
- **`UpdateEvidenceVerification` is intentionally minimal/OPEN** (`ops/evidence.ts:98-102`): it
  models only the re-anchor-to-`valid` transition. Status-only outcomes (`stale`/`pending`/
  `failed`, no re-anchor) are **deferred to Phase 4** — add them before the verification workflow
  lands.
- **type-registry is open**: 14 registered types (11 strict + 3 loose); an unknown type resolves
  to a loose def keeping its asserted name (door open for a future type). Kept honest by an
  **unconditional CI drift test** against `test/fixtures/vault-taxonomy.json`, plus an optional
  live check against `main-vault/00_System/Vault Schema.md`.
- **No semver** — playground posture. Evolve schemas, bump `opVersion` per payload or the
  `atlas-*-vN` algorithm id when a shape must change, and let the seam tests catch drift.

## History (real PRs)

Landed early and stayed remarkably stable — most later PRs only *append*.

- **#61** (Phase 0) — scaffold: `package.json`, `tsconfig.json`, empty `index.ts`.
- **#62** (Phase 1) — the bulk in one ~1600-line commit: `ids`, `canonical`, `identity`,
  `primitives`, envelope, `dtos`, `audit`, `authorization`, `provider-errors`, `run-manifest`, +
  `contracts.no-app-import` (D14) and `contracts.authorization` (validates the
  security-broker-contract's JSON examples against the Zod mirrors).
- **#67** (Phase-2 contracts gate, closes #26) — the big shape change: all 17 op payloads,
  `changeplan.ts` (union + strict full schema), `contracts.operations.test` +
  `serialize-op-worker.mjs`, provider-errors upgraded to a discriminated union. Fixes tagged
  in-code: **R3-F1** (discriminated ProviderError/ChangePlan), **R3-F2** (strict envelope),
  **R3-F3** (in-schema cross-field invariants), **R3-F4** (provenance via `parseSourceHandle`).
- **#76** (egress broker, closes #34) — `schema-registry.ts`, the shared `generateObject`
  `schemaId`→Zod SSOT both the models client and the in-broker Gemini adapter resolve against.
- **#91** — one `run.*` kind added to `audit.ts` (Tier-3 review-loop regeneration).
- **#139** — `evidence.retry_enqueued` added to `LEDGER_EVENT_KINDS`.
- **#152** (open type system, over #151) — `type-registry.ts` + `vault-taxonomy.json` +
  `type-registry.test.ts`. Contracts became the taxonomy authority (14 registered types).

## Open items

- **`UpdateEvidenceVerification` status-only variants** (`stale`/`pending`/`failed`) — Phase 4.
- **`SCHEMA_REGISTRY` seeded with `ChangePlan` only** — extraction/classification schemas are
  registered by the tasks that introduce them (or injected as a test overlay).
- **Opaque-id 16-hex assumption** (see Gotchas) — reconcile the security-broker-contract prose to
  its examples.

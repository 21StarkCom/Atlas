# `@atlas/contracts` — the zero-dep shared-value leaf

**Zero-dependency (Zod-only) leaf** owning every value/type the single `brain`
process shares across its packages: stable IDs, `atlas-jcs-v1` canonical
serialization, the `atlas-identity-key-v1` algorithm, the ChangePlan envelope +
its 12 op payloads, the run manifest, the `generateObject` schema registry, the
provider-error taxonomy, the open note-type registry, and the shared
cross-boundary DTOs (D14).

**Why a leaf — two reasons survive v2.** (1) **One canonical form, many
processes.** Canonical serialization + ID parsing + identity folding are defined
*once*, so a `RunManifest` written on a git commit trailer round-trips
byte-identically when read back, a ChangePlan hashes to a stable digest, and the
sync `content_hash` cursor is reproducible run-to-run — no private copy can
drift. (2) **D14 build-cycle break.** Hosting the structural DTOs here (not in
`apps/cli`) lets workspace packages consume them without a `package→app` build
edge (`src/index.ts` header states this).

Runtime deps: **`zod` + `node:crypto` only.** No `@atlas/*` dependency exists
(and none may — see invariants). `private`, `version 0.0.0`, ESM, single export
`.` → `dist/` via `tsc`.

> **v2 posture (ADR-0003).** The privilege boundary this leaf once served — a
> separate-identity process independently re-deriving/verifying every plan across
> an IPC seam — is **gone**. Atlas v2 is one process; **git is the only safety
> mechanism** (one commit per applied ChangePlan; undo = `git revert <sha>` +
> `brain sync`). The determinism guarantees above still matter (git trailer,
> ChangePlan digest, sync cursor), but "byte-identity across a trust boundary" is
> no longer the framing.

## Where it fits

- **Consumers** (`@atlas/contracts: workspace:*`): `apps/cli` (re-exported via its
  `domain` layer), `packages/{git,jobs,lancedb-index,models,sources,sqlite-store}`,
  `tools/`. `@atlas/broker` and `@atlas/scan` are **deleted** in v2 — no longer
  consumers.
- **Authorities it implements:** the ChangePlan ops + provenance model from the
  design SSOT ([`../../docs/specs/2026-07-11-atlas-v1-design.md`](../../docs/specs/2026-07-11-atlas-v1-design.md));
  the `generateObject` seam from [`../../docs/specs/provider-interface.md`](../../docs/specs/provider-interface.md);
  the open note-type system from [`../../docs/specs/2026-07-16-open-type-system-spec.md`](../../docs/specs/2026-07-16-open-type-system-spec.md).
  The v1 security contract that once fixed the canonical/ID/audit rules is
  **superseded** by [ADR-0003](../../docs/adr/0003-retire-security-architecture.md)
  + the [v2 spec](../../docs/specs/2026-07-21-atlas-v2-single-process-simplification-spec.md);
  the canonical/ID/identity algorithms it specified carry forward unchanged.

## Key files (flat `src/` + `ops/`; barrel `src/index.ts` = the entire public surface)

- `ids.ts` — **the ONLY module that parses/serializes source handles (D3).** `ContentId`
  (`sha256:<hash>:<mediaType>`, 3 segments), `RenditionId` (+extractor/normalizer version,
  5 segments), `parseSourceHandle`. Also `newRunId` (ULID), `isUlid`, `saltedOpaqueId`,
  `ULID_RE`, `OPAQUE_ID_RE`.
- `canonical.ts` — `atlas-jcs-v1` (RFC 8785 JCS). `canonicalSerialize`→`Uint8Array`,
  `canonicalStringify`, `CANONICALIZATION_ID`. Pure, dependency-free.
- `identity.ts` — `atlas-identity-key-v1`: `normalizeIdentityKey`, `IDENTITY_KEY_VECTORS`,
  `IDENTITY_KEY_ALGORITHM_ID`, and the hand-pinned full Unicode case-fold table
  (`FULL_CASE_FOLD`, 104 entries).
- `primitives.ts` — shared string-shape Zod: `Ulid`, `OpaqueId`, `CommitHash` (SHA-1),
  `Rfc3339Ms`, `Nonce`, `Sha256Digest`, `SchemaVersion1`. Also the crypto-string primitives
  (`Ed25519Sig`/`Ed25519PubKey`, `P256Sig`/`P256PubKey`, `AuthzSignature`, `PublicKeyString`) —
  **vestigial**, see the retired-mirror note below.
- `changeplan-envelope.ts` — the stable Phase-1 wrapper. `RISK_TIERS` is v2-narrowed to
  `tier-1`/`tier-2` (#335: the Tier-3 = review-required escalation is retired with the
  trust/review architecture; the field is **advisory only**, never read to gate an apply) +
  `REVERSIBILITY`.
- `changeplan.ts` — `ChangePlanSchema` = `.strict()` envelope over the discriminated union
  of all **12** ops, with a load-time coverage invariant + a `superRefine` cross-field
  dispatcher (`SetFrontmatterField`, `ProposeRename`).
- `ops/op-result.ts` — cross-op primitives: `CHANGE_PLAN_OPS` (SSOT list of 12 names),
  `RESERVED_OPS`, `SectionSelector`, `ProvenanceRef`, `RELATIONSHIP_PREDICATES` (6), the
  enums, the generic `OpResult<Name,ErrorCode>` envelope.
- `ops/*` (11 op-payload files, barrel `ops/index.ts`) — one file per op-group. Each exports
  `<Op>OpSchema`, `<OP>_ERROR_CODES`, `<Op>Result`. `relationship.ts` = `CreateRelationship`
  (typed edge, closed predicate enum); `links.ts` = `SetLink` (plain `[[wiki-link]]` add/remove).
- `schema-registry.ts` — `SCHEMA_REGISTRY` (`schemaId`→Zod) + `resolveRegisteredSchema`.
  `generateObject` carries a `schemaId` string that the in-process Gemini client
  (`@atlas/models`) and the CLI plan generator both resolve here to the same schema.
  **Seeded with `ChangePlan` only.**
- `run-manifest.ts` — `RunManifestSchema` + `WORKFLOW_STATES` (v2: `review-pending` retired,
  #335 — a run advances `agent-committed → integrated` directly). Committed as a git commit
  trailer and MUST round-trip byte-identically (`@atlas/git` reads it back).
- `provider-errors.ts` — the `ProviderError` discriminated union (9 kinds).
- `dtos.ts` — zero-runtime D14 structural types: `WikiLink`, `Relationship`, `ParsedNote`,
  `VaultSnapshot`, `NormalizedRendition`, `Chunk`, … `ParsedNote.relationships` +
  `Relationship` are the markdown home of a `CreateRelationship` edge (v2, #331 — see below).
- `type-registry.ts` — the open note-type system: `resolveType`, `classificationToSensitivity`,
  `STRICT_TYPES` (12) + `LOOSE_TYPES` (3) = 15 registered, `MANAGED_FRONTMATTER`, `SCHEMA_VERSION = 1`.

**Retired mirrors, still in-tree (`audit.ts`, `authorization.ts`) — vestigial, pending deletion.**
These mirrored the v1 signed-audit-ledger + authorization-challenge subsystem that
[ADR-0003](../../docs/adr/0003-retire-security-architecture.md) retired. No v2 code path
serializes a plan across a privilege boundary: `authorization.ts` has **no live `src/`
consumer**, and the `audit.ts` ledger/anchor machinery is dead — only its `AuditEvent`
*type* is still referenced by `@atlas/sqlite-store` for plain operational-run bookkeeping.
The signer-string primitives in `primitives.ts` are vestigial for the same reason. Treat
none of them as a live contract; do not build on them.

## Invariants — do not break

- **Canonical serialization is deterministic across processes.**
  `test/contracts.operations.test.ts` spawns `serialize-op-worker.mjs` (a *separate* node
  process importing built `dist`) twice and asserts its stdout is identical run-to-run AND
  equal to the vitest process's own parse-then-serialize hashes — three independent
  processes, one canonical form. This underpins the git-trailer round-trip, the ChangePlan
  digest, and the sync `content_hash` cursor.
- **No workspace package may import `apps/cli` (D14).** `test/contracts.no-app-import.test.ts`
  scans the whole `packages/` tree repo-wide and asserts zero offenders. This is what keeps the
  leaf a leaf. Never add an `@atlas/*` dep or an `apps/cli` import here.
- **`ChangePlanSchema` is `.strict()` at BOTH envelope and payload levels (R3-F2).** An unknown
  key is a hard rejection, never silently stripped — a stripped stowaway would make two
  processes disagree on the canonical bytes.
- **Load-time union-coverage invariant** (`changeplan.ts`): the union must cover *exactly*
  the **12** `CHANGE_PLAN_OPS` names (10 active + the 2 reserved task ops) — a mismatch throws
  at module load, not a silent gap. Adding or removing an op means updating `CHANGE_PLAN_OPS`
  **and** the union together.
- **Canonical rules** (`canonical.ts`, pinned by `contracts.canonical.test.ts`): UTF-8 no BOM;
  keys normalized to **NFC before sorting** (sort-then-normalize orders differently across
  processes); sort by UTF-16 code unit; `undefined`/absent omitted (never `null`);
  NaN/Infinity/bigint rejected; `undefined` in an array rejected (not coerced); NFC-collision
  keys rejected as ambiguous (no last-wins merge).
- **Source handles parsed ONLY in `ids.ts` (D3).** `ProvenanceRef` validates via
  `parseSourceHandle` (R3-F4), not a local regex — so a producer and verifier can never
  disagree on what a provenance ref means. (`PinnedRenditionRef` was removed with the
  claims/evidence ops in #337.)
- **`ProviderError` retryability is a literal per kind**, not caller-chosen:
  `rate_limit|quota|timeout|transport|partial_batch`⇒`true`;
  `authentication|validation|model_incompatible|cancelled`⇒`false`. `retryAfter` only on
  `rate_limit`/`quota`; `succeededIndices` on and only on `partial_batch`; every member `.strict()`.
- **`id` is immutable in V1.** `SetFrontmatterField` rejects `field:"id"` in-schema;
  `ProposeRename` cannot touch id (and rejects an empty rename).
- **Reserved ops (`CreateTask`,`UpdateTaskState`) ship validating schemas but are policy-rejected
  in V1** (`reserved-operation`) — they must round-trip like every other op so a future task
  workflow slots in without a schema break. `ProposeDelete` is intentionally absent from the gate
  (`ops/op-result.ts`) — it is the deletion-*proposal* op the Phase-4 `maintain`/`reconcile` loop
  emits and is gated with that phase.
- **`classificationToSensitivity` never maps above `internal`** (`public`→`public`, else→
  `internal`; the vault forbids `confidential`/`secret`). Unknown `schemaId` → `undefined` so the
  caller maps it to a fail-closed `validation` error, never a silent unvalidated pass.

## Gotchas

- **Opaque-id length is pinned to the contract's EXAMPLES, not its prose** (`ids.ts:146-160`):
  the v1 prose said `…[:16bytes]` but every JSON example used a 16-hex-char (8-byte) digest
  (`n_9f2c1a8e0b3d4f56`), so `saltedOpaqueId` truncates to 16 hex and `OPAQUE_ID_RE` follows.
  That spec is now superseded, but the pinned 16-hex behavior stands.
- **Some primitive schemas are deliberately lenient** (`primitives.ts`): `Ed25519Sig`/`PubKey`
  check only the `ed25519:` prefix, `Sha256Digest` only `sha256:` — the v1 contract's JSON
  examples truncate bodies with `...` and those examples are the acceptance target
  (`contracts.authorization.test`, still present against the vestigial mirrors). `CommitHash`
  is SHA-1 (40 hex) — V1.
- **`identity.ts` hand-maintains a full Unicode case-fold table** because `String.toLowerCase()`
  is simple 1:1 folding only — it leaves ligatures (ﬀ→ff, ﬁ→fi, ß→ss) intact and gets Greek final
  sigma wrong (ς→σ patched). Pinned to one Unicode version for cross-process determinism; a
  Unicode/CaseFolding revision is a conscious edit here, never automatic.
- **Typed relationships are markdown-DERIVED (v2, #331).** `Relationship` /
  `ParsedNote.relationships` model the note's frontmatter `related:` list — the markdown home of
  a `CreateRelationship` edge (non-null `predicate`, projected into a distinct `note_links` row).
  Distinct from `WikiLink` (plain `[[wiki-link]]` body occurrence, `predicate` NULL). Relationships
  are re-derived from frontmatter (`db rebuild` + the v2 sync fold both rebuild them from here);
  they are NOT projection-authored state.
- **The v1 claims/evidence ops are retired (#337).** `CreateClaim`, `AttachEvidence`,
  `UpdateEvidenceVerification` (+ `ops/claim.ts`/`ops/evidence.ts`, the `VerificationState` enum,
  and `PinnedRenditionRef`) were removed with the flat vault-derived `evidence` model — evidence
  is authored via the dedicated `evidence` commands, not a ChangePlan op. This dropped the op gate
  from 15 → **12**. `ProvenanceRef` + `parseSourceHandle` stay (the source/rendition provenance
  model is untouched).
- **type-registry is open**: 15 registered types (12 strict + 3 loose); an unknown type resolves
  to a loose def keeping its asserted name (door open for a future type). Kept honest by an
  **unconditional CI drift test** against `test/fixtures/vault-taxonomy.json`, plus an optional
  live check against `main-vault/00_System/Vault Schema.md`.
- **No semver** — playground posture. Evolve schemas, bump `opVersion` per payload or the
  `atlas-*-vN` algorithm id when a shape must change, and let the determinism tests catch drift.

## History (real PRs)

Landed early and stayed remarkably stable; v2 then subtracted from it.

- **#61** (Phase 0) — scaffold: `package.json`, `tsconfig.json`, empty `index.ts`.
- **#62** (Phase 1) — the bulk in one ~1600-line commit: `ids`, `canonical`, `identity`,
  `primitives`, envelope, `dtos`, `run-manifest`, provider-errors, + `contracts.no-app-import`
  (D14).
- **#67** (Phase-2 contracts gate, closes #26) — the big shape change: the op payloads,
  `changeplan.ts` (union + strict full schema), `contracts.operations.test` +
  `serialize-op-worker.mjs`, provider-errors upgraded to a discriminated union. Fixes tagged
  in-code: **R3-F1**…**R3-F4**.
- **#76** — `schema-registry.ts`, the shared `generateObject` `schemaId`→Zod SSOT.
- **#152** (open type system, over #151) — `type-registry.ts` + `vault-taxonomy.json` +
  `type-registry.test.ts`. Contracts became the taxonomy authority.
- **v2 demolition** — **#327** finalized the ChangePlan union under contract demolition;
  **#331** moved typed relationships to the frontmatter `related:` list (`Relationship` DTO);
  **#335** cut the Tier-3 / `review-pending` surface (`RISK_TIERS` → `tier-1`/`tier-2`,
  advisory); **#337** dropped the claims/evidence ops + `PinnedRenditionRef` (op gate 15 → 12).
  ADR-0003 retired the security architecture the `audit.ts`/`authorization.ts` mirrors served.

## Open items

- **`SCHEMA_REGISTRY` seeded with `ChangePlan` only** — extraction/classification schemas are
  registered by the tasks that introduce them (or injected as a test overlay).
- **`audit.ts` / `authorization.ts` (+ the signer-string primitives) are vestigial** and slated
  for deletion — they no longer back any live path. Until removed, do not build on them.
</content>
</invoke>

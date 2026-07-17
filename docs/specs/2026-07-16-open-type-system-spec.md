# Open type system — full-vault ingestion (spec)

- **Date:** 2026-07-16
- **Issue:** #151
- **Status:** draft (brainstorm output; awaiting review → plan)
- **Provenance:** the 2026-07-16 production graduation + live drive graduated only 32/206 notes; 122 were refused solely for carrying a `type:` Atlas didn't recognize. This spec makes ingestion total.

## Problem

Atlas's known note types are `note`, `concept`, `person`, `source`, `project`
(`KNOWN_TYPES` / `GRADUATION_KNOWN_TYPES`; `POLICY_TARGET_TYPES` omits `note`).
The real vault (`~/Code/Vaults/main-vault`, 208 notes) uses its own documented
taxonomy (`00_System/Vault Schema.md`) of **11 types**, of which Atlas recognizes
only `person` and `project`. Every note of the other nine types is refused
(`unknown-type`), plus refusals for `unsupported-schema-version` and rejects for
missing frontmatter / missing id / identity collision / broken link. Result: 85%
of the vault cannot enter.

The notes are **not malformed** — they conform to a stricter schema than Atlas's.
They are refused only because Atlas doesn't know the type *names*.

## Decisions (from brainstorm)

1. **Everything of any shape enters.** No note is refused for its type, a missing
   field, a missing id, a collision, or a broken link. The migration is a **total
   function**: every input note → a normalized managed note.
2. **Secrets remain the one boundary.** A note with a detected live credential is
   still quarantined (ciphertext, recoverable), never silently ingested. This is a
   security boundary, not a shape gate — unchanged from today.
3. **Accept whatever fields exist; enforce only the identity minimum; apply
   deterministic judgement to fill the rest.** Do not rigidly require the vault's
   11 base fields — a note missing `confidence`/`status`/etc. is normalized with a
   sensible default, never refused.
4. **Model the real taxonomy, don't genericize it.** The registry mirrors the
   vault's own `Vault Schema.md` (the SSOT it tracks), including the strict/loose
   tier, so known types carry meaning; an unrecognized *future* type degrades to
   loose so the door stays open.
5. **Graduation stays deterministic.** Judgement = deterministic heuristics
   (path/frontmatter/slug), **not** per-note LLM inference — byte-exact fixtures
   and zero egress cost preserved. Model-assisted inference is an explicit
   **non-goal** of this spec (revisit separately if wanted).

## The taxonomy (from `00_System/Vault Schema.md`)

Base frontmatter (canonical): `id, type, status, title, aliases, tags, related,
updated, confidence, classification, source`; `review_after`/`expires` optional.
ID convention `<type>-<slug>`. `classification ∈ {public, personal, internal}`.

- **Strict types** (schema requires all base fields): `project` (20), `repo` (44),
  `tool` (3), `cloud` (6), `person` (56), `team` (6), `meeting` (11),
  `conversation` (8), `memory` (14).
- **Loose types** (schema requires only `id, type, title`): `research` (34),
  `personal` (7).
- **Untyped** (11): system/meta docs (`CLAUDE.md`, `AGENTS.md`, `README.md`,
  `GEMINI.md`, `00_System/*`).

Note: the vault uses **none** of Atlas's `note`/`concept`/`source`. Those stay in
the registry (back-compat with V1 fixtures) but are not vault-present.

## Design

### 1. Type registry (new module in `packages/contracts`)

A data-driven registry — one owner, drift-proof, mirroring the CLI-contract
registry pattern:

```
TypeDef = {
  name: string,
  tier: "strict" | "loose",
  // fields enforced at NORMALIZE time only as defaults-to-fill, never as refusals
  baseFields: canonical 11 (strict) | {id,type,title} (loose),
  isPolicyTarget: boolean,   // replaces the POLICY_TARGET_TYPES hardcode
  defaultSensitivity: Sensitivity,
}
```

- Registered types = the vault's 11 + V1's `note`/`concept`/`source` (retained).
- **Open fallback:** any `type:` string not in the registry is accepted and
  treated as a **loose** type with generic defaults. This is what keeps ingestion
  total for a future 12th type.
- The registry documents `Vault Schema.md` as its upstream SSOT; a test asserts
  the registered names/tiers match that doc so the two cannot silently drift.

### 2. Graduation migrate becomes total (`graduation/migrate-plan.ts`)

Remove the two refusal branches (`unknown-type`, `unsupported-schema-version`).
`inferType` already resolves type by frontmatter → folder → filename-prefix →
default; extend `KNOWN_TYPES` to the registry and make the "unknown string" case
**fall through to loose** (keep the asserted type name; treat as loose) instead of
refusing. `unsupported-schema-version` → coerce to the supported value.

Normalization judgement (deterministic), per gap:

| Gap | Judgement |
|---|---|
| missing/unknown `type` | folder → filename-prefix → `note`; unknown asserted string kept as a loose type |
| missing frontmatter entirely | synthesize base (id from slug, type inferred, status `active`) |
| missing/invalid `id` | derive `<type>-<slug>` from path |
| strict type missing a base field | fill default (`status: active`, `confidence: medium`, `classification: internal`, empty `aliases/tags/related`, `updated` = migration date) — never refuse |
| `schema_version` unsupported/absent | coerce to current |
| id / identity collision | deterministic disambiguation (suffix), reported |
| broken / ambiguous / incompatible link | migrate note; link kept verbatim (today's `released` path becomes the default) |
| detected secret | **quarantine (unchanged)** |

The migrate report keeps `refused` in its schema for back-compat but it is now
**always empty for shape reasons** (only ever populated if a future hard-refusal
class is added); a new `normalized[]` section reports, **per note (capped list,
overflow counted)**, exactly which fields judgement filled or coerced — so nothing
is silently changed and the operator can audit every applied default.

### 3. Classification → sensitivity mapping

Vault `classification` → Atlas `declaredSensitivity` (drives the egress ceiling).
Atlas's ladder is `public | internal | confidential | restricted`
(`contracts/dtos.ts`), so the vault's `public` maps to a real distinct value:

| vault `classification` | Atlas `declaredSensitivity` |
|---|---|
| `public` | `public` |
| `personal` | `internal` |
| `internal` | `internal` |
| absent | `internal` (fail-safe default) |

The vault forbids `confidential`/`restricted` in `classification` (advisory), so
Atlas's higher sensitivities are unreachable from vault content — correct: nothing
in the vault can declare above `internal`.

### 4. Reader / rebuild (`vault/reader.ts`, `identity.ts`)

The strict reader's invariants (dangling link, identity collision, missing
required field) are **load-bearing for the normal `db rebuild`/index/query path**
and stay strict — because migration now produces a *normalized, well-formed*
managed vault, the reader passes on the output. Permissiveness lives only in the
migration/ingest normalization pass, not in the reader. (The `--from-git` DR path
already gaps collisions per #150.)

## Non-goals

- Per-note LLM/model-assisted type or field inference (determinism + cost).
- Per-type *specialized* schemas beyond the base contract + tier (e.g. `person`'s
  `identities`, `meeting`'s attendees) — a later incremental refinement; this spec
  gets every note in with correct tier validation.
- Changing the secret-scan boundary.
- Re-architecting the reader's strict mode.

## Testing

- **Deterministic fixtures** (byte-exact, extend `docs/specs/fixtures/bootstrap-migration/`):
  each judgement row — untyped→note, no-frontmatter→synthesized, strict-missing-field→filled,
  unknown-type→loose-kept, collision→disambiguated, broken-link→kept, unsupported-schema→coerced.
- **Registry ↔ Vault Schema drift test**: registered names/tiers match `Vault Schema.md`.
- **Live re-graduation of the real vault** (the acceptance gate): `graduation migrate`
  over `main-vault` → `unknown-type` refusals = 0, ~all 208 notes graduate,
  secret-bearing notes still quarantined, `main-vault` HEAD unchanged.

## Acceptance

- Re-run graduation over the real vault graduates the large majority of 208 notes;
  unknown-type refusals → 0; only secret-bearing notes quarantined.
- `brain query` answers team/repo/meeting/cloud questions that today return
  "insufficient context" (e.g. "who runs the Cloud team").
- All existing suites green; new fixtures + drift test + live-drive record.

## Resolved decisions (2026-07-17)

1. **`public` classification** → maps to Atlas `public` (the ladder has a distinct
   `public`, confirmed in `contracts/dtos.ts`). `personal`/`internal`/absent →
   `internal`.
2. **Registry home** → `packages/contracts` — `isPolicyTarget`/`defaultSensitivity`
   are consumed beyond migration (policies, reader, egress ceiling).
3. **`normalized[]` report** → per-note capped list (overflow counted) of the exact
   fields filled/coerced, for auditability.

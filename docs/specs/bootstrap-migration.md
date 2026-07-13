# Bootstrap migration contract

Normative contract for the **one-time graduation of a legacy Markdown vault** (a copy of
`main-vault`) into an Atlas-managed vault. This document is a **contract that conforms to the plan**
(`docs/plans/atlas-v1-implementation-2026-07-12.md`, Phase 5 / §2.7 migration ownership) — it does not
restate the plan's decisions, it makes them executable. It is consumed by:

- **Task 5.2 `graduation audit`** — the read-only inventory; its report categories map **1:1** to the
  quarantine categories in §7 below.
- **Task 5.3 `graduation migrate` + `quarantine inspect|resolve`** — the deterministic, review-gated
  migration engine; the executable fixtures in §9 **are** its test corpus.
- **Task 5.4 graduation E2E** — rebuild-after-migration and rollback verification.

> **Authority of the executable fixtures (Task 5.0 review).** Where this prose and the executable
> fixtures under §9 (`docs/specs/fixtures/bootstrap-migration/`) disagree, **the fixtures are
> authoritative** — the acceptance criterion is that they *are* Task 5.3's test corpus, so 5.3 builds
> to the fixtures and this prose is reconciled to them, never the reverse. Three such reconciliations
> are known-open and MUST be resolved (prose → fixture) before 5.3 lands, tracked on the Phase-5
> tracker (#8): (1) the crash-after-rename **write-ahead sequence** — the fixture persists BOTH the
> pre- and post-image `sha256` *before* the rename and resumes a `pending` note by post-image match,
> which is the crash-safe behavior; the older prose treating `pending` as pre-image-only with a null
> `postImageSha256` is superseded. (2) **Rollback** binds the reverse `GraduateEffect` fields and
> fails closed on a `postImageSha256` conflict (never blind-restores a pre-image over a
> post-migration edit), per `graduation-migrate.schema.json` + the `rollback-conflict` fixture. (3)
> Rerun handling of quarantined/refused notes follows §7's released/re-migrate promotion, not an
> unconditional skip. Until the prose below is rewritten, read these three areas as defined by the
> fixtures.

The migration runs on the disposable copy only (`.scratch/atlas-graduation-copy`), under the
`vault-maintenance` lock, agent-branch-only, and is **Tier-3 review-gated** (broker-authorized
`--apply`, per `security-broker-contract.md` §7.5 op `graduation migrate`). It never touches the live
`main-vault`.

---

## 1. Principles

1. **Deterministic.** Given the same input vault and the same config, every derived id, inferred
   `type`, rewritten link, and checkpoint is bit-identical across runs and machines. No wall-clock,
   no randomness, no hash-map iteration order — collisions resolve by **sorted repo-relative path**.
2. **Non-destructive by default.** `graduation migrate` is a **preview** unless `--apply` is supplied
   (and authorized). A preview mutates nothing and emits no audit-ref event (§2.5 mutation default).
3. **Fail-closed on ambiguity.** Anything the algorithm cannot resolve unambiguously is **quarantined
   or refused**, never guessed. A duplicate identity, an unsupported `schema_version`, or an ambiguous
   alias stops that note — it does not corrupt the id space.
4. **Idempotent + resumable.** Every note migrates as an independent unit behind a per-note
   checkpoint (§5); an interrupted run rerun to completion produces the identical result and
   re-applies nothing.
5. **Provenance-preserving.** Unknown frontmatter, body content, and existing ids are preserved
   verbatim; migration only *adds* the managed keys it owns (`id`, `type`, `schema_version`, and the
   reader-required `title`, `created`, `updated` — §6.1) and *rewrites* resolvable links. An existing
   managed key is kept, never overwritten.

---

## 2. ID derivation

Every migrated note ends with a stable, unique `id` in frontmatter. Id assignment is a **two-pass**
process so an explicit id can never be squatted by a derived one:

- **Pass 1 — reserve all explicit ids.** Before any id is derived, every non-empty explicit `id`
  frontmatter across the whole copy is collected into the reserved id space. Two notes asserting the
  **same** explicit `id` are a genuine **duplicate identity** → quarantined (§7), **never** silently
  suffixed. (Reserving first is load-bearing: a derived id assigned before a later, identical explicit
  id would otherwise leave two notes with the same id — see the `explicit-collision` fixture, where a
  derived note sorts **before** and another **after** the explicit owner and both are suffixed.)
- **Pass 2 — derive the rest, in sorted repo-relative path order**, allocating against the already-full
  reserved space (§2.2).

Derivation precedence for a single note, highest first:

1. **Explicit `id` frontmatter** — if present and non-empty, it is authoritative and kept verbatim
   (reserved in pass 1).
2. **Derived from title** — otherwise the id is `"<type>-<slug>"`, where `<type>` is the inferred
   type (§3) and `<slug>` is the slug (§2.1) of the note's title. The title is the first-encountered
   of: frontmatter `title`, the first Markdown H1 (`# …`), else the filename stem.

### 2.1 Slug algorithm (deterministic)

1. Unicode-normalize to **NFKD** and strip combining marks (diacritics → ASCII: `Kóral` → `koral`).
2. Lowercase.
3. Replace every run of non-`[a-z0-9]` characters with a single `-`.
4. Trim leading/trailing `-`.
5. If the result is empty (title had no alphanumerics), the slug is `note` and the note is flagged
   `ambiguous-alias` for review (a title that slugs to nothing cannot carry identity).

### 2.2 Collision rule

Derived ids are assigned in **sorted repo-relative path order**, against the reserved explicit-id
space from pass 1 plus the derived ids already assigned this pass. When a *derived* id (precedence
rule 2) would collide with **any** reserved explicit id or an already-assigned id belonging to a
**distinct** note, that note is disambiguated with the lowest free **numeric suffix**: `note-atlas`,
then `note-atlas-2`, `note-atlas-3`, … The suffix is applied to the id only; the title and body are
untouched. Because explicit ids are reserved first, a derived note that sorts *before* the explicit
owner is suffixed just the same — the explicit owner always keeps the bare id. A collision between two
**explicit** ids is *not* a derivation clash — it is `duplicate-identity` (§7).

---

## 3. Type inference

`type` is resolved by the first matching rule, highest precedence first. The result records both the
`value` and its `source` (for the review artifact and the fixtures):

| # | source | rule |
|---|--------|------|
| 1 | `frontmatter` | explicit `type:` in frontmatter, if it is a known type |
| 2 | `folder` | top-level folder maps to a type: `People/ → person`, `Concepts/ → concept`, `Sources/ → source`, `Projects/ → project` |
| 3 | `filename` | filename stem prefixed with a known type + `-` (`person-koral.md → person`) |
| 4 | `default` | none of the above ⇒ `note` |

Known types (V1): `note`, `concept`, `person`, `source`, `project`. `type` is a **managed key**
migration owns (§6) — it cannot simultaneously preserve a note's asserted `type: alien` **and** write
an inferred managed value into the same YAML key. So an explicit `type:` that is present and non-empty
but **outside the known set** — an **unknown** value (`type: alien`) or a **malformed** non-string
value (`type: 42`) — is **refused** under the `unknown-type` category (§7): the note is **never
mutated** (migration neither overwrites the asserted value nor guesses a managed one), reported for
operator action, and excluded from the applied set. It falls through **only** for inference when the
key is **absent** (rules 2–4). Folder mapping is **case-sensitive** and only the top-level folder
segment is consulted.

---

## 4. Link rewrite & preservation

Migration rewrites references so they survive id assignment, and preserves everything it cannot
resolve.

- **Wikilinks** `[[Target]]` and `[[Target|Display]]` — `Target` is resolved (case-insensitively) to
  a note by title then filename stem. On a unique resolution the link is rewritten to
  `[[<newId>|Display]]`, preserving the original display text; when the wikilink had no explicit
  display, the **original target text becomes the display** so the human-readable link is unchanged
  (`[[Koral]] → [[person-koral|Koral]]`). Result recorded as `rewritten`.
- **Unresolved wikilinks** — a `Target` that resolves to **no** note is **preserved verbatim** and
  the containing note is flagged `incompatible-link` (§7) for review. Result recorded as
  `preserved-unresolved`. A note carrying an unresolved link is **blocked** (quarantined
  `incompatible-link`) and does **not** migrate until either the link is repaired **or** the operator
  authorizes an explicit **release** of the note as-is (`quarantine resolve --resolution release`,
  §7.1). On authorized release the note migrates with the link left verbatim as prose, and the per-note
  record carries a `released` entry naming the resolving `opaqueId` (see the `basic` fixture, where
  `Concepts/Atlas.md` migrates only because its unresolved-link quarantine was released).
- **Ambiguous wikilinks** — a `Target` that resolves to **more than one** note is preserved verbatim
  and flagged `incompatible-link`; the migration never picks a winner.
- **Markdown relative links** `](path.md)` — rewritten to the target's canonical note reference when
  `path` resolves to exactly one migrated note; otherwise preserved verbatim.

Every rewrite decision is recorded per note as `{ from, to, targetId, resolution }` (see the
fixtures' `linkRewrites`).

---

## 5. Per-note checkpoints (idempotent, resumable)

The migration persists a checkpoint keyed by note path so an interrupted run resumes exactly. The
checkpoint is a JSON document (`.checkpoint.json` at the copy root, see the `idempotent` fixture):

```json
{
  "version": 1,
  "migrationRunId": "<ULID>",
  "bootstrapTimestamp": "<RFC-3339>",
  "backupDir": ".bootstrap-backup",
  "notes": [
    {
      "path": "<repo-relative>",
      "oldId": null,
      "newId": "<id>",
      "schemaVersion": 1,
      "status": "migrated",
      "preImage": ".bootstrap-backup/<repo-relative>",
      "preImageSha256": "<hex>",
      "postImageSha256": "<hex>",
      "rollbackStatus": "not-started"
    }
  ]
}
```

Each note entry records **verified pre/post images** so recovery and rollback are byte-exact:

- **`preImage`** — a path under `backupDir` holding the note's **original bytes** verbatim, written
  (atomically) *before* the note is first mutated. **`preImageSha256`** pins those bytes.
- **`postImageSha256`** — the sha256 of the migrated bytes, written once the mutation lands (`null`
  while `pending`).
- **`rollbackStatus`** ∈ `not-started | reverted` — per-note rollback progress (§8.2).

Per-note `status` ∈ `pending | migrated | quarantined | refused | failed`. On rerun the engine:

1. Loads the checkpoint. For a note marked `migrated`, it **verifies** the on-disk bytes hash to
   `postImageSha256`; only then is the note **skipped** (proven already applied). `quarantined`/
   `refused` notes are skipped too.
2. For a `pending`/`failed` note it **verifies** the on-disk bytes still hash to `preImageSha256`
   (proving the mutation was never applied) and **applies** it — a resume never skips an unapplied
   mutation just because the checkpoint mentions the note. If the on-disk bytes match neither image,
   the note is `failed` for operator review (never silently re-mutated).
3. Produces an id map identical to a fresh run (determinism §1) — the id space is a pure function of
   the input tree, so a resume can never diverge.

A crash mid-note leaves the pre-image retained and the note's on-disk bytes still equal to
`preImageSha256` (the note file is written atomically: temp + rename), so recovery never sees a
half-written note and the crash-window resume (the `crash-window` fixture) re-applies exactly the
pending note.

---

## 6. Frontmatter & provenance preservation

Migration is **additive** to frontmatter. It injects `id`, `type`, and `schema_version: 1` and leaves
**all other keys byte-identical** — unknown/custom keys (`custom_field`, `source_url`, `tags`, …),
key order of surviving keys, and body content are preserved (see the `guards` fixture's
`preservedFrontmatter`). Migration never deletes or rewrites a key it does not own.

**`schema_version` guard.** A note that already carries `schema_version` greater than the build's
`supportedSchemaVersion` (V1: `1`) is **refused** — recorded `unsupported-schema-version`, `mutated:
false`, and excluded from the applied set. Migration never downgrades or silently rewrites a
future-versioned note.

### 6.1 Reader-required field initialization (deterministic)

A migrated note MUST satisfy the canonical vault reader's required frontmatter set
(`apps/cli/src/vault/frontmatter.ts`): `id`, `type`, `schema_version`, **`title`**, **`created`**,
**`updated`** (`status` defaults to `active` in the reader, so migration need not write it). Migration
initializes each missing required key **deterministically** — a pure function of the input vault +
config, never wall-clock (§1):

- **`title`** — the derived title: first-encountered of frontmatter `title`, first Markdown H1, else
  the filename stem (the same title used for id derivation, §2).
- **`created` / `updated`** — from the note path's **git history in the copy** (first-commit author
  date → `created`, last-commit author date → `updated`). When the path has **no** git history, both
  fall back to the config **`bootstrapTimestamp`** (recorded in the checkpoint and the migration-plan
  digest, so the value is pinned and reproducible). The executable fixtures are plain dirs (no
  history), so every fixture note uses the `bootstrapTimestamp` fallback (`2026-07-12T00:00:00Z`).

An already-present required key is preserved verbatim (additive, §6). Each note's
`initializedFrontmatter` records the exact managed frontmatter written, so Task 5.3 can assert the
migrated note parses cleanly through the real reader and Task 5.4's rebuild-after-migration succeeds.

---

## 7. Quarantine categories & operator flows

`graduation audit` (Task 5.2) inventories the copy into the **eight** categories below; `graduation
migrate` quarantines or refuses the same categories. The audit report categories **map 1:1** to this
list (`graduation-audit.schema.json` exposes all eight). Note the two non-audit-derived rows:
`detected-credential` is surfaced by `graduation scan` (encrypted quarantine) and re-reported by
audit; `unsupported-schema-version` is a **refusal** — audit reports it for operator action, but it is
**not quarantined** and therefore **not inspectable** via `quarantine inspect` (its category enum
omits it). The three self-detected identity/alias/link rows plus `detected-credential` are the four
quarantine-inspectable categories.

| category | detected when | disposition |
|----------|---------------|-------------|
| `missing-id` | no explicit `id` frontmatter | auto-derived (§2) — informational, not blocking |
| `missing-type` | no explicit `type` frontmatter | auto-inferred (§3) — informational |
| `missing-schema-version` | no `schema_version` frontmatter | auto-initialized to `1` — informational |
| `ambiguous-alias` | a title/alias that slugs to nothing, or an alias claimed by >1 note | **quarantined** — operator decides the canonical alias owner |
| `duplicate-identity` | ≥2 notes assert the same explicit `id` | **quarantined** — operator picks the survivor / re-ids the others |
| `incompatible-link` | a wikilink resolves to zero or >1 notes | flagged; link preserved verbatim, operator repairs |
| `detected-credential` | secret/sensitive-data hit from the Task 2.2 scan (§5.1) | **encrypted quarantine**; privileged `quarantine inspect|resolve` only |
| `unknown-type` | explicit `type` present but outside the managed set (unknown value or malformed non-string) | **refused** (§3); never mutated / never inspectable; operator corrects the `type` or removes the note |
| `unsupported-schema-version` | `schema_version` > supported max | **refused** (§6); operator upgrades the build or removes the note |

### 7.1 Operator flows (per category)

Non-credential categories (`ambiguous-alias`, `duplicate-identity`, `incompatible-link`) are inspected
and resolved with the **privileged** `quarantine inspect|resolve` commands (registry `privilege:
privileged`; broker `os-presence` per `security-broker-contract.md` §7.5). The flow:

1. `graduation audit` → operator sees the per-category note lists.
2. `quarantine inspect <opaqueId>` → **every invocation is challenge-bound** (the quarantine registry
   is privileged classification): even metadata-only inspection requires an authorization; `--reveal`
   **additionally** binds reveal intent and shows full content (a metadata authorization never
   authorizes a reveal). Without an authorization the command exits `6`.
3. `quarantine resolve <opaqueId> --resolution release|discard [--authorization <path>]`:
   - **`release`** — the operator asserts the item is safe/repaired; it re-enters the migrable set on
     the next `graduation migrate` run.
   - **`discard`** — the item is dropped from graduation (recorded, never migrated).
4. `graduation audit` post-resolve reports **zero unresolved** in that category (graduation criterion).

- **`ambiguous-alias`** — operator assigns the alias to one note (release the owner, discard/rename
  the claim on the others) or supplies an explicit `id`.
- **`duplicate-identity`** — operator releases the intended survivor and re-ids or discards the
  duplicates; migration will not proceed while two notes claim one id.
- **`incompatible-link`** — operator repairs the link target (or accepts the note with the link left
  as prose); the note migrates once no unresolved link remains, or the operator releases it as-is.
- **`detected-credential`** — content is AEAD-encrypted at rest; `quarantine inspect --reveal` and
  `quarantine resolve` are **privileged**, challenge-bound (purpose = reveal, caller + vault-bound,
  replay-protected), least-privilege (metadata by default), and each write is an audit record. The
  operator remediates the credential in the source, then `release`; or `discard` the file from
  graduation.
- **`unsupported-schema-version`** — refused, not quarantined; there is nothing to reveal. The
  operator upgrades Atlas to a build whose `supportedSchemaVersion` covers the note, or removes it.

---

## 8. Review artifacts & rollback

### 8.1 Review artifacts

An `--apply` migration is **Tier-3 review-gated**. Before integration it emits a review bundle so a
human can authorize the broker challenge:

- **id map** — `{ path → newId }` for every migrated note (see fixtures' `idMap`).
- **per-note plan** — inferred `type` + source, derived/kept id, link rewrites, preserved keys.
- **quarantine list** — every quarantined/refused note with its category and peers.
- **checkpoint** — the resumable state (§5).

The broker challenge for `graduation migrate` binds `fromGeneration`, `toGeneration`, and the
**migration plan digest** (`security-broker-contract.md` §7.5); the digest is recomputed at execute
time and any drift (`authz.migration_plan_mismatch`) rejects the apply.

### 8.2 Rollback

`graduation migrate --rollback` reverts a bootstrap using the per-note checkpoints, in **reverse
sorted-path order**. For each `migrated` note it restores the retained **pre-image bytes**
(`preImage`, verified against `preImageSha256` — a byte-exact reversal, not a re-derivation) and marks
the note `pending` with `rollbackStatus: reverted`. Rollback is **mutating and broker-authorized**
just like `--apply` (op `graduation migrate`, `security-broker-contract.md` §7.5): the challenge binds
the target `migrationRunId` and the `expectedCurrentGeneration`, so a **stale** rollback against a
moved generation is rejected `authz.generation_mismatch` (exit `6`) and a **replayed** authorization
is rejected `authz.nonce_replayed` (exit `1`); without an authorization `--rollback` exits `6`.
Rollback is itself checkpointed and **idempotent** — a re-invoked rollback re-reverts nothing already
`reverted` (the `rollback` fixture's `rerunRollback` asserts the empty second pass). After a full
rollback the copy's tree matches the pre-migration state and a `db rebuild` + `index rebuild`
reproduces byte-consistent projections (verified by Task 5.4).

---

## 9. Executable fixtures

The machine-consumable contract lives under
[`docs/specs/fixtures/bootstrap-migration/`](fixtures/bootstrap-migration/manifest.json). The
`manifest.json` enumerates cases; each case is an input vault tree (`input/`) plus an
`expected.json`. Task 5.3's suite runs the migration over `input/` and asserts the result equals
`expected.json`. `contract-lint.test.ts` validates the fixtures are well-formed and that the expected
outputs conform to the algorithms above (so the fixtures cannot drift from this contract).

| case | exercises |
|------|-----------|
| `basic` | type inference (folder), id derivation, reader-required-field init, wikilink rewrite + alias preservation, unresolved-link preservation + authorized release, audit categories |
| `collision` | derived-id numeric-suffix disambiguation, explicit-id `duplicate-identity` quarantine |
| `crash-window` | checkpoint crash window: resume skips a verified-migrated note and **applies** a still-legacy `pending` note (never skips an unapplied mutation) |
| `explicit-collision` | explicit ids reserved before derivation; a derived note sorting **before** and one **after** the explicit owner are both suffixed |
| `guards` | `unsupported-schema-version` refusal, unknown-frontmatter/provenance preservation, reader-required-field init |
| `idempotent` | checkpoint resume with verified pre/post images, idempotent rerun (no re-apply) |
| `rollback` | byte-exact rollback via pre-images in reverse sorted-path order; idempotent re-rollback |

Expected-output shape (per case, keys present as the case exercises them):

- `audit.categories` — the §7 category → note-path lists; `audit.treeHashUnchanged: true` asserts the
  read-only audit does not mutate the tree (Task 5.2).
- `migrate.mode` — `preview | applied | rolled-back`.
- `migrate.idMap` — `{ path → newId }`.
- `migrate.notes[]` — `{ path, oldId, newId, type: { value, source }, schemaVersion, status,
  initializedFrontmatter{ id, type, schema_version, title, created, updated }, linkRewrites[],
  collision?, preservedFrontmatter?, released? }`.
- `migrate.quarantined[]` — `{ path, category, … }`; `migrate.refused[]` — `{ path, category,
  outcome, mutated }`; `migrate.releases[]` — authorized incompatible-link releases.
- `migrate.rolledBack[]` / `migrate.rollbackOrder` (rollback case) — reverse-sorted-path reversal to
  each note's verified pre-image; `rerunRollback` asserts the idempotent empty second pass.
- `resume` (idempotent + crash-window cases) — `{ preCheckpoint[] (with pre/post sha256), rerunMode,
  skipped[], applied[], reapplied[], idMap, finalStatuses, verifiedPostImage, verifiedPreImage }`.
- `resume` (idempotent case) — `{ preCheckpoint[], rerunMode, skipped[], reapplied[], idMap,
  finalStatuses }`.

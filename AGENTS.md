# Atlas — agent working notes

Atlas is an LLM-native second-brain wiki engine, built as a **pnpm/TypeScript
monorepo** in six PR-gated phases. See `docs/specs/2026-07-11-atlas-v1-design.md`
(design SSOT) and `docs/plans/atlas-v1-implementation-2026-07-12.md` (implementation
plan). This file is the fast orientation for a coding agent.

## Layout (tree-A)

```
apps/cli/            the single CLI application (`brain`); hosts internal modules
packages/
  contracts/         leaf cross-process contract (stable IDs, schemas, canonical serialization)
  sources/           sandboxed md/txt/pdf/html normalization
  scan/              secret-scan engine + guards (leaf)               [lands Phase 2]
  sqlite-store/      DB connection + migration runner + projection/ledger repos
  lancedb-index/     chunk + embed + hybrid (fts + vector) search
  models/            provider-neutral generate/embed adapter
  git/               branch / worktree / commit / broker client
  jobs/              SQLite-backed queue (sole owner of jobs/job_attempts)
  broker/            privilege-separated integration broker (separate OS identity)
  testing/           fixture-vault helpers
tools/               retained CLI-contract harness (generator + contract-lint)
docs/                specs (incl. cli-contract/), plans
fixtures/  prompts/  schemas/  migrations/   [seeded by later tasks]
```

Every directory under `packages/` and `apps/` is a placeholder in Phase 0 (empty
`src/index.ts`, builds clean). Each phase fills its packages per the plan.

## Build & test

```bash
pnpm install
pnpm -r build          # tsc per package (strict / ESM / NodeNext)
pnpm -r test           # vitest per package
node tools/gen-cli-contract.ts --check   # CLI-contract determinism gate
```

Requires Node ≥ 24 and pnpm ≥ 10. Dependency versions are pinned once in the
`catalog:` of `pnpm-workspace.yaml`; packages reference them as `"vitest": "catalog:"`.

## Retained CLI-contract harness (`tools/` + `docs/specs/cli-contract/`)

The command surface is **data-driven and drift-proof from day one**. This harness
is the Phase-0 bootstrap and is **never reverted** (plan Rollback).

- `docs/specs/cli-contract/commands.json` — the single command **registry**. One row
  per command/subcommand, shape:
  `{ name, schemaRef, phase: 0|1|2|3|4|5, idempotency: "key-accepting"|"intrinsic"|"none", privilege: "shared"|"privileged", implemented: boolean }`.
  Command **membership**, **privilege class**, and **phase** have exactly one owner: this file.
  `policies`/broker **read** the `privilege` field, never re-classify (D-registry SSOT).
- `docs/specs/cli-contract/cli-surface.fixture.txt` — the human prose inventory that
  `contract-lint` parses. Every command line here must have a registry row and vice versa.
- `tools/gen-cli-contract.ts` — deterministic generator. `--write` regenerates derived
  files (`docs/specs/cli-contract/commands-overview.md`); `--check` (used by CI + lint)
  asserts registry↔fixture↔schema-presence consistency and that no derived file has drifted.
- `tools/contract-lint.test.ts` — the vitest gate. Fails if a command is added to the
  fixture without a registry row (proven by an in-memory fixture-mutation test), if an
  `implemented:true` row lacks its `schemaRef` file, or if the generator is non-deterministic.

**Adding / renaming a command** is a one-row diff in `commands.json` + the matching
`cli-surface.fixture.txt` line, then `pnpm run contract:write`. `contract-lint` gates the rest.

**Flipping a command to `implemented: true`** requires its `schemaRef` schema file to
exist (`docs/specs/cli-contract/<slug>.schema.json`, `<slug>` = command name with spaces
→ hyphens) — those schemas land per delivering phase (Task 0.5 for Phase-1 commands, etc.).

## Conventions

- TypeScript strict / ESM / NodeNext; compile with `tsc` (no runtime type-stripping in prod).
- Exit codes: `0` ok · `1` validation · `2` config/vault · `3` secret-scan · `4` internal ·
  `5` user/usage · `6` action-required · `7` provider-retryable.
- Commits authored `Aryeh Stark <aryeh@21stark.com>`. Branch + PR for everything.

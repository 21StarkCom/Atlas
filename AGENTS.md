# AGENTS.md — Atlas

Atlas is an **LLM-native second-brain wiki engine**: a pnpm/TypeScript monorepo whose CLI binary is `brain`. Markdown is memory; SQLite the operational projection; LanceDB the retrieval projection; Git the safety/audit mechanism. Built security-first and contract-first (privilege-separated brokers, scan-before-persist, WORM audit anchor) across six PR-gated phases. Layout: `apps/cli` + `packages/{broker,contracts,git,jobs,lancedb-index,models,scan,sources,sqlite-store,testing}` + `tools/` (CLI-contract harness) + `provisioning/` + `docs/` + `fixtures/`.

## Build & test

```bash
pnpm install                              # Node ≥ 24, pnpm ≥ 11
pnpm -r build                             # tsc per package (strict / ESM / NodeNext)
pnpm -r test                              # vitest per package
node tools/gen-cli-contract.ts --check    # CLI-contract determinism gate
```

Deps are pinned once in the `catalog:` of `pnpm-workspace.yaml`. `ATLAS_PROVISIONED=1` unlocks the real two-UID / key-custody suites (CI provisions via `sudo -E provisioning/ci/setup.sh`; locally an in-process subset runs).

## Rules

- Commits authored `Aryeh Stark <aryeh@21stark.com>`. Branch + PR for everything — never direct-to-main.
- Playground, not product: no semver, merge to main when green. Update docs in the same change.

**The full constitution — architecture, security model, per-directory map, conventions, exit codes, the CLI-contract workflow, and open work — lives in [`CLAUDE.md`](CLAUDE.md). Read it first.** Every package has its own `CLAUDE.md`; read the directory's before working in it.

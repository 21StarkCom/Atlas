# Atlas install runbook — clean machine → verified working install

The complete cold-start path for **Atlas** (the LLM-native second-brain wiki engine; the CLI binary is `brain`). Every command here is real and runs from a repo checkout. Atlas is a **personal-project playground, not a shipped product** — there is no published package, no semver, no installer; you run from the repo.

**v2 posture ([ADR-0003](adr/0003-retire-security-architecture.md)).** Atlas is **one process** — no host provisioning, no OS identities, no daemons, no `sudo`. `brain` opens the vault working tree + SQLite + LanceDB, mutates notes, commits to git, exits. **Git is the only safety mechanism.** The whole install is: clone → build → point the config at your vault → migrate → rebuild → index. Root constitution: [`../CLAUDE.md`](../CLAUDE.md). v2 authority: [ADR-0003](adr/0003-retire-security-architecture.md) + the [v2 spec](specs/2026-07-21-atlas-v2-single-process-simplification-spec.md).

---

## 0. Fresh-machine quickstart (macOS)

The whole path on one screen, in the order that works first-try (each step is detailed below; run from the repo root). **No `sudo` anywhere.**

```bash
# 1  build + test (Node ≥24, pnpm ≥11.15)
pnpm install --frozen-lockfile && pnpm -r build && pnpm -r test

# 2  point the config at your vault
cp brain.config.example.yaml brain.config.yaml     # set vault.path (defaults to ~/Code/Vaults/main-vault)
alias brain="node $PWD/apps/cli/dist/bin.js"

# 3  provider key: env override, or the macOS Keychain item
export ATLAS_GEMINI_API_KEY=…                      # or: security add-generic-password -s atlas-gemini-api-key -w …

# 4  build the stores (local; no network for migrate/rebuild)
brain db migrate        # create the SQLite DB + apply all migrations
brain db rebuild        # regenerate the vault-derived projection from Markdown
brain index rebuild     # chunk → embed → write the LanceDB retrieval index (needs the Gemini key)

# 5  use it
brain status                              # health + counts, exit 0
brain query "who runs the Cloud team"     # grounded, cited answer
```

Ordering that bites if violated: **`db migrate` before `db rebuild`** (§4 — rebuild does not create the DB), and **the Gemini key exported before any embed/generate command** (`index rebuild`, `index eval`, `query`, `enrich`, `maintain`).

---

## 1. Prerequisites

| Requirement | Version / note |
|---|---|
| **Node** | `>= 24` — the repo uses `node:sqlite` (`DatabaseSync`) which needs 24+ (`engines.node` in [`../package.json`](../package.json); CI runs **26**). |
| **pnpm** | `>= 11.15` (`packageManager: pnpm@11.15.0`). **11.12.0 is a broken release** — `pnpm -r test` exits 127/1; if pnpm misbehaves check the pin first, and beware a stale/blank global shim shadowing a good install. Deps are pinned via `catalog:` in [`../pnpm-workspace.yaml`](../pnpm-workspace.yaml). |
| **OS** | **macOS** is the supported target (the Keychain key read is macOS-only). Linux runs the platform-neutral suite as a CI portability canary; use the `ATLAS_GEMINI_API_KEY` env var for the key there. |
| **git** | The vault is a git repository; `brain` commits one applied ChangePlan per commit onto `refs/heads/main`. |
| **Gemini API key** | Only for embed/generate commands (`index rebuild`, `index eval`, `query`, `enrich`, `maintain`). Not needed to build, test, migrate, rebuild the projection, or run `status`. |

---

## 2. Clone, install, build, test

```bash
git clone git@github.com:21StarkCom/Atlas.git atlas
cd atlas

pnpm install --frozen-lockfile   # lockfile-exact; CI uses the same flag
pnpm -r build                    # tsc across every workspace package
pnpm -r test                     # vitest across the monorepo — zero provisioning, no daemons
```

**Ordering is load-bearing:** `pnpm -r build` **must** precede `pnpm -r test` — the contract harness imports built `@atlas/contracts`, and `apps/cli` depends on every package's `dist/`.

**Zero provisioning.** The full suite runs with no environment setup: no OS identities, no daemons, no `ATLAS_PROVISIONED`. That matches CI exactly ([`../.github/workflows/ci.yml`](../.github/workflows/ci.yml)).

> **The executable is `dist/bin.js`, not `dist/index.js`.** `apps/cli/src/index.ts` is a pure re-export (the `@atlas/cli` library surface) — running `node apps/cli/dist/index.js <cmd>` does nothing and exits 0. The `brain` bin maps to `dist/bin.js` (`void main()`). For readability the rest of this doc assumes an alias:
> ```bash
> alias brain="node $PWD/apps/cli/dist/bin.js"
> ```

---

## 3. Config file

There is no `init` command — the config is hand-authored YAML at `<cwd>/brain.config.yaml` (or `--config <path>`). Copy the example and adjust paths:

```bash
cp brain.config.example.yaml brain.config.yaml
```

The schema is **strict** ([`../apps/cli/src/config/schema.ts`](../apps/cli/src/config/schema.ts)) — an unknown key or bad value fails startup with `ConfigError` (exit 2) naming the file + key. **Set `vault.path` to your vault git repo.** It defaults to the real working tree `~/Code/Vaults/main-vault` (`DEFAULT_VAULT_PATH`), so a config that omits it points at the graduated vault, not a stale target.

To make the target explicit (e.g. in a live drive), export **`ATLAS_EXPECT_VAULT=<intended vault>`**: `loadConfig` canonicalizes (`~`-expand + `realpath`) both it and `vault.path` and **fail-closed-rejects (exit 2)** any mismatch, so a stale operator override can never silently run against the wrong repository. The var is inert when unset.

> The strict schema still declares a few **inert v1 residue** sections (`broker`, `quarantine`, and `sqlite.ledger_backup`) that nothing in v2 reads — the example config carries them so a copied config validates. Leave them as shipped; the config-schema demolition that drops them is pending. Do not wire anything to them.

---

## 4. Environment variables

Each verified against source before documenting.

| Var | Read by | What it does |
|---|---|---|
| **`ATLAS_GEMINI_API_KEY`** | `packages/models/src/client.ts` (`GEMINI_API_KEY_ENV`) | The Gemini API key. **The env var wins**; if unset, `brain` reads the macOS Keychain generic-password item `atlas-gemini-api-key` (`security find-generic-password -s atlas-gemini-api-key -w`) directly. Resolved lazily on the first provider call and held **in-process only** — never written to disk, logs, or git. Required for `index rebuild`, `index eval`, `query`, `enrich`, `maintain`. |
| **`ATLAS_EXPECT_VAULT`** | `apps/cli/src/config/load.ts` (`EXPECT_VAULT_ENV`) | Pins the intended vault. `loadConfig` canonicalizes it and `vault.path` and rejects a mismatch (exit 2). Inert when unset. |
| **`ATLAS_ROOT`** | `apps/cli/src/main.ts` | Overrides the auto-detected cli-contract root (where `docs/specs/cli-contract/commands.json` lives). Precedence: `options.root` → `env.ATLAS_ROOT` → `findRoot` (walks up from the module dir). Only needed to run the binary from outside the repo layout; running from the checkout, auto-detect works. |

Config `ATLAS_<SECTION>_<KEY>` overrides (e.g. `ATLAS_INDEXING_DIMENSIONS=768`) are a separate mechanism handled in `apps/cli/src/config/load.ts`.

---

## 5. First-run sequence

Every command below exists in [`specs/cli-contract/commands.json`](specs/cli-contract/commands.json) (version 2, 24 commands, all `implemented:true`).

```bash
# Create the SQLite DB + apply all migrations. db migrate is the SOLE migration
# composition root (it registers the feature migrations BEFORE store.migrate()).
# Pure local — no network. (#145: a fresh drive that skips this dies later.)
brain db migrate

# Regenerate the vault-derived projection (notes/sections/links/evidence + chunk
# metadata) from the vault Markdown at vault.path. No provider call. Operational
# tables (jobs, source, model_calls, agent_runs) are RETAINED across rebuild.
brain db rebuild

# Build the LanceDB retrieval index (chunk → embed → write). Needs the Gemini key:
export ATLAS_GEMINI_API_KEY=…            # or the Keychain item atlas-gemini-api-key
brain index rebuild

# First grounded, cited query.
brain query "who runs the Cloud team"
```

**Populating the vault.** `db rebuild` reads whatever valid Markdown is at `vault.path` (filtered by `vault.note_globs`, default `**/*.md`). To add notes, hand-author Markdown, `brain note add`, or `brain ingest` a local source. After any out-of-band edit to the tree, `brain sync` reconciles the working tree against the projection by per-note content hash and reindexes the delta.

**Mutating commands** (`note add`, `link`, `enrich --apply`, `maintain --apply`, `evidence resolve`) each produce **exactly one commit** on `refs/heads/main` touching only the ChangePlan's paths. Undo is `git revert <sha>` **followed by `brain sync`** (the revert restores the tree; the sync refolds the derived stores).

---

## 6. Verification

```bash
brain status           # merged health: vault + db + index + sync sub-objects, plus checks[]
```

`status` (which absorbed the retired `doctor` / `db status` / `index status` / `sync status`) runs the surviving health probes — `vault-reachable`, `git-healthy`, `provider-key-present`, `index-not-stale`, `migrations-current`. It exits **0 whenever a payload was produced** — a failed probe is data (`ok:false`), not a process failure; consumers inspect `ok`. It exits **2** only when the vault/config is unresolvable. A fresh/unmigrated DB reports an empty schema version + zero counts — if you see that after §5, `db migrate` didn't run against this config.

Exit codes (stable, from [`../apps/cli/src/errors/envelope.ts`](../apps/cli/src/errors/envelope.ts)): `0` ok · `1` validation · `2` config/vault/lock · `4` internal · `5` usage. The single error envelope carries `retryable:true` + `retryAfterMs` at exit 4 for provider-retryable outcomes; the only process path that returns `7` is the `jobs run` batch aggregate (jobs-run schema `exitCode` enum). The old secret-scan (`3`) and action-required (`6`) codes retired with the security architecture — no command emits them.

---

## 7. CI parity

[`../.github/workflows/ci.yml`](../.github/workflows/ci.yml) is the reference sequence — **zero-provisioning, daemon-free**. Mirror it locally to reproduce a CI result:

```bash
pnpm install --frozen-lockfile
pnpm -r build
pnpm -r test
node tools/gen-cli-contract.ts --check    # command-registry drift gate (must be clean)
```

Matrix: `ubuntu-latest` + `macos-15`, Node **26**. `gen-cli-contract.ts --check` is the only tool invoked as an explicit CI step; failpoints/state-table drift is caught inside `pnpm -r test`. The ubuntu leg is a portability canary for the platform-neutral suite; macOS is the supported target.

---

## 8. Troubleshooting

- **`node apps/cli/dist/index.js <cmd>` prints nothing and exits 0.** `index.js` is the library entry, not the executable. Use `dist/bin.js` or the linked `brain` (§2).

- **`db rebuild` reports no ledger / no DB.** A fresh DB needs `db migrate` **before** `db rebuild` — rebuild does not create the store. Re-run `brain db migrate`, then `brain db rebuild`.

- **A provider call fails "no Gemini API key".** `ATLAS_GEMINI_API_KEY` isn't set and the Keychain item `atlas-gemini-api-key` isn't present. Export the env var (it wins) or `security add-generic-password -s atlas-gemini-api-key -w <key>`. Needed for `index rebuild`, `index eval`, `query`, `enrich`, `maintain`.

- **`vault.path resolves to … but ATLAS_EXPECT_VAULT pins …` (exit 2).** The config's `vault.path` canonicalizes somewhere other than the pinned expectation. Point `vault.path` at the intended vault, or clear `ATLAS_EXPECT_VAULT`.

- **A mutating command exits 1 "out of sync" / "uncommitted changes".** The dirty-vault doctrine: a mutation refuses to build on a note it edits/names that is dirty — either the on-disk hash ≠ projection `content_hash` (run `brain sync`) or the note carries an uncommitted git diff vs `HEAD` (commit or stash it first). Unrelated dirt elsewhere is fine.

- **A mutating command exits 2 "HEAD is not refs/heads/main".** Atlas commits directly onto `main`; check out main (`git switch main`) before mutating. A feature-branch or detached HEAD is refused before any write.

- **A writer exits 2 `locked:<scope>` or `git-index-locked`.** Another `brain` invocation holds the advisory vault lock, or an external git process left an `index.lock`. Wait for the other writer, or clear a stale `index.lock`.

- **Retrieval below the gate / FTS scoring poorly.** The eval gate is **recall@10 ≥ 0.85, MRR ≥ 0.70** (`index eval`). Default **hybrid** is the recommended config (recall 0.911 / MRR 0.830) — a real stemmed/stop-word FTS index (`packages/lancedb-index/src/fts.ts` `ensureFtsIndex`) is built at the end of `index rebuild`. If FTS was never built, FTS-weighted RRF collapses recall — re-run `index rebuild` so the index exists; `retrieval.fts.enabled: false` (vector-only) is the fallback, not the default.

---

## 9. Cleaning up a v1 host

If this machine ran **v1** (brokers, OS identities, launchd services, signer/capability Keychain items), v2 leaves that host substrate behind. One human-run, `sudo`-gated script deletes it:

```bash
provisioning/macos/deprovision-macos.sh --plan          # preview the ordered deletion plan (no sudo, no mutation)
sudo provisioning/macos/deprovision-macos.sh --confirm  # execute; irreversible except via the v1-fortress tag
```

It deletes exactly the retired v1 resources enumerated in `provisioning/deprovision-allowlist.txt` (launchd services, the three `atlas-*` OS users + groups, sockets, the audit-anchor dir, and the retired signer/capability Keychain items) and **preserves `atlas-gemini-api-key`** — the credential `brain` reads directly. It refuses to run in CI. A fresh machine that never ran v1 needs none of this.

---

Everything the retired v1 architecture provided (brokers, scan engine, signed ledger, graduation, authorization signer, Console) is revivable from the **`v1-fortress`** annotated tag — code + provisioning only, not migrated data. See [ADR-0003](adr/0003-retire-security-architecture.md).

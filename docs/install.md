# Atlas install runbook — clean machine → verified working install

The complete cold-start path for **Atlas** (the LLM-native second-brain wiki engine; the CLI binary is `brain`). Every command here is real and runs from a repo checkout. Atlas is a **personal-project playground, not a shipped product** — there is no published package, no semver, no installer; you run from the repo. Root constitution: [`../CLAUDE.md`](../CLAUDE.md). Design SSOT: [`specs/2026-07-11-atlas-v1-design.md`](specs/2026-07-11-atlas-v1-design.md).

The privilege-separated architecture means a *complete* install has two halves: (1) the pnpm/TypeScript build (no privileges), and (2) the OS substrate — two service identities, keys, a WORM anchor, sockets — that the broker + egress daemons run inside. Half (2) is the **one `sudo`-required step**; nothing else in the build needs root.

---

## 0. Fresh-machine quickstart (macOS)

The whole path on one screen, in the order that works first-try (each step is detailed in the sections below; run from the repo root). Steps 3–7 need `sudo`.

```bash
# 1  build + test (Node ≥24, pnpm ≥11.15)
pnpm install --frozen-lockfile && pnpm -r build && pnpm -r test

# 2  preview, then provision the OS substrate (identities, keys, dirs, sockets)
sudo ATLAS_DRY_RUN=1 provisioning/dev/setup.sh
sudo provisioning/dev/setup.sh

# 3  agent network denial (D17)
AGENT_UID=$(id -u atlas-agent)
sed "s/<AGENT_UID>/$AGENT_UID/" provisioning/macos/agent-pf.conf | sudo pfctl -a atlas/agent -f -
sudo pfctl -e

# 4  real keys: Gemini credential + quarantine recipient pub (generation: §3)
sudo -u atlas-egress tee /usr/local/etc/atlas/keys/atlas-egress/atlas.gemini.key < /path/to/gemini.key >/dev/null
#    …then the openssl X25519 steps in §3 for quarantine-recipient.pub

# 5  daemon binaries: bundle, hash-verify, install root-owned (D16)
tools/build-artifact.sh
sudo provisioning/install-artifact.sh dist-artifact

# 6  vault repo at the launcher default, broker-writable (BEFORE services start)
sudo git init /var/lib/atlas/vault      # or git clone <existing>
sudo chown -R atlas-broker:atlas-git /var/lib/atlas/vault && sudo chmod -R g+rX /var/lib/atlas/vault

# 7  launchd services (RunAtLoad + KeepAlive) + verify
sudo provisioning/macos/services.sh install
provisioning/macos/services.sh status                 # both: loaded (pid N)
tail -3 /usr/local/var/log/atlas/*.log                # "…listening on…" ×2

# 8  first run (config → ledger → projections → index): §5
export ATLAS_PROVISIONED=1

# 9  (optional, after §5.4 adoption) enable continuous sync — §5.6
sudo security add-generic-password -a atlas-agent -s atlas-egress-capability \
  -w "$(sudo cat /usr/local/etc/atlas/keys/shared/egress-capability.key)" -U
provisioning/macos/services.sh sync-gate "$VAULT"            # read-only: shows what's missing
sudo ATLAS_UPSTREAM_PULLER_LABEL=<puller-label> \
  provisioning/macos/services.sh enable-sync "$VAULT"
```

Ordering that bites if violated: **artifact before services** (`services.sh` refuses without the launchers), **vault before services** (the broker validates `refs/audit/runs` at startup and crash-loops on a missing repo), **`db migrate` before `db rebuild`** (§5.3), **adoption before `enable-sync`** (the timer needs a seeded `sync_cursors` row).

---

## 1. Prerequisites

| Requirement | Version / note |
|---|---|
| **Node** | `>= 24` — the repo uses `node:sqlite` (`DatabaseSync`) which needs 24+ (`engines.node` in [`../package.json`](../package.json); CI runs **26**). |
| **pnpm** | `>= 11.15` (`packageManager: pnpm@11.15.0`). **11.12.0 is a broken release** — `pnpm -r test` exits 127/1; if pnpm misbehaves check the pin first, and beware a stale/blank global shim at `~/Library/pnpm/bin/pnpm` shadowing a good Homebrew install. Deps are pinned via `catalog:` in [`../pnpm-workspace.yaml`](../pnpm-workspace.yaml). |
| **OS** | **macOS** (Darwin, tested arm64) or **Linux** (`x86_64` / `arm64`). Any other host fails the sandbox capability probe closed (`sandbox-contract.md`). |
| **`sudo`** | Root access — **only** for `provisioning/` (creates OS users + protected dirs). The build/test/first-run itself never needs root. |
| **git** | The vault is a git repository; the broker is the sole writer of its protected refs. |
| **Gemini API key** | Only for egress-bearing commands (`index rebuild`, `index eval`, `query`). Not needed to build, test, provision, migrate, or run diagnostics. |

---

## 2. Clone, install, build, test

```bash
git clone git@github.com:21StarkCom/Atlas.git atlas
cd atlas

pnpm install --frozen-lockfile   # lockfile-exact; CI uses the same flag
pnpm -r build                    # tsc across every workspace package (root script: pnpm -r build)
pnpm -r test                     # vitest across the monorepo
```

**Ordering is load-bearing:** `pnpm -r build` **must** precede `pnpm -r test`. The contract harness (`tools/contract-lint.test.ts`, `tools/test-signer.ts`) imports built `@atlas/broker` + `@atlas/contracts`, and `apps/cli` depends on every package's `dist/`.

**`ATLAS_PROVISIONED` gates the OS-level suites.** Without it, `pnpm -r test` runs the full in-process suite and **skips** the live two-identity suite `approval-boundary.adversarial` (`packages/broker/test/approval-boundary.adversarial.test.ts`), which gates on `process.env.ATLAS_PROVISIONED === "1"`. To exercise it, provision first (§3) then:

```bash
export ATLAS_PROVISIONED=1
pnpm -r test                     # now the provisioning-gated suite runs instead of skip
```

The `approval-boundary.adversarial` two-UID case additionally needs passwordless `sudo -n` to **both** root and `atlas-agent` (`packages/broker/test/approval-boundary.adversarial.test.ts`). CI always provisions, so nothing skips there.

> **The executable is `dist/bin.js`, not `dist/index.js`.** `apps/cli/src/index.ts` is a pure re-export (the `@atlas/cli` library surface) — running `node apps/cli/dist/index.js <cmd>` does nothing and exits 0. The `brain` bin maps to `dist/bin.js` (`void main()`). For readability the rest of this doc assumes an alias:
> ```bash
> alias brain="node $PWD/apps/cli/dist/bin.js"
> ```

---

## 3. Host provisioning (`sudo`)

Read the scripts before running them — this is the human-led, security-critical step (authored directly, not agent-dispatched). Full detail: [`../provisioning/CLAUDE.md`](../provisioning/CLAUDE.md) and [`../provisioning/README.md`](../provisioning/README.md).

### What `provisioning/dev/setup.sh` actually creates

Read directly from the script (`provisioning/dev/setup.sh`, 8 numbered steps):

- **Two runtime service identities** — `atlas-broker` (protected-ref writes, approval verify, audit append, WORM anchor) and `atlas-egress` (sole provider-credential holder + sole outbound-network process, **no vault access**).
- **A non-login agent UID** `atlas-agent` — the unprivileged CLI + parser + workflow, network-denied at the UID (D17).
- **The `atlas-git` group** — members are `atlas-agent` + `atlas-broker` **only**; `atlas-egress` is deliberately excluded (D18: the internet-facing identity has no vault/object read).
- **Per-identity `0700` key custody** — ed25519 (`audit-attestation`, `atlas-test-approver`) + AEAD (`backup-aead`, `quarantine-aead`) + the provider-credential placeholder (`atlas.gemini.key`), each with the exact owner/mode from `keys.acl.json`.
- **Cross-identity egress artifacts** under `…/keys/shared/` (owner `atlas-egress`, group `atlas-git`, group-accessible so the CLI reaches them as group while egress stays out of `atlas-git`): `egress-capability.key` (0640), `quarantine-recipient.pub` (0644) — plus the egress state dir (`budget-state.json` 0660, `quarantine-spool/` 2770 setgid).
- **The WORM audit anchor** (D8) — broker-owned `0600`, parent `0700`, **outside** the vault+repo.
- **The setgid socket run dir** (D10, 2770 group `atlas-git`) so sockets inherit the group without `atlas-egress` being a member.
- **The root-owned install dir** (D16) for the hash-verified privileged binaries.
- **Sandbox parser prerequisites** (Linux only): `bubblewrap` + `util-linux`, unprivileged-userns unblock, cgroup-v2 `atlas.slice` delegation.

`approval-verify.pub` and `atlas.gemini.key` are seeded **empty** — the operator installs the enrolled approver's public key and the real Gemini key. UID/GID base is `ATLAS_UID_BASE` (default **8420**). Every helper guards on existence — the script is idempotent, safe to re-run.

### Entry points

| Target | Command |
|---|---|
| **Preview** (no mutation) | `sudo ATLAS_DRY_RUN=1 provisioning/dev/setup.sh` |
| **Dev host** | `sudo provisioning/dev/setup.sh` |
| **Reverse** | `sudo provisioning/dev/teardown.sh` |
| **CI** | `sudo -E provisioning/ci/setup.sh` — runs dev setup, then writes `/etc/sudoers.d/atlas-ci` (0440, `visudo -cf`-validated) scoping the runner to `sudo -u atlas-broker`/`atlas-egress` the **two launchers only** (D1). |
| **macOS D17 kernel half** | `AGENT_UID=$(id -u atlas-agent); sed "s/<AGENT_UID>/$AGENT_UID/" provisioning/macos/agent-pf.conf \| sudo pfctl -a atlas/agent -f -` then `sudo pfctl -e` (pf has no name→UID variable; the anchor ships a literal `<AGENT_UID>` placeholder). |
| **Linux D17** | `sudo provisioning/linux/netns.sh setup` + `sudo provisioning/linux/agent-cgroup.sh setup`. |

### Install the privileged binaries

The broker/egress daemons are **never** run privileged from the agent-writable repo `dist/` (D16). Build, then install hash-verified copies into the root-owned install dir:

```bash
tools/build-artifact.sh                          # bundles both bins + sha256 manifests into dist-artifact/
sudo provisioning/install-artifact.sh dist-artifact
# Installs them + the two launchers into /usr/local/lib/atlas/bin (macOS) or /opt/atlas/bin (Linux),
# recording <bin>.installed.sha256 for the planned provisioning.integrity suite (named in script comments; not yet implemented).
```

### Run the daemons as services (macOS)

Install both daemons as launchd system services — `RunAtLoad` + `KeepAlive` (restart on crash, start at boot), per-identity `UserName`, logs under `/usr/local/var/log/atlas/`:

```bash
sudo provisioning/macos/services.sh install      # copy plists to /Library/LaunchDaemons, bootstrap, start
provisioning/macos/services.sh status            # per-daemon loaded/pid
sudo provisioning/macos/services.sh uninstall    # bootout + remove
```

The broker's vault path defaults to `/var/lib/atlas/vault` (`ATLAS_VAULT_REPO_DIR` in the launcher) — to point at a different clone, add `ATLAS_VAULT_REPO_DIR` to `EnvironmentVariables` in `provisioning/macos/com.atlas.broker.plist` and re-run `install`. For a one-off foreground run (no service), the launchers still work directly: `sudo -u atlas-broker /usr/local/lib/atlas/bin/broker-launcher.sh`. Linux service units (systemd) are not provided yet.

Finally, write the real Gemini key into the egress-only credential (replacing the placeholder) and export the marker:

```bash
sudo -u atlas-egress tee /usr/local/etc/atlas/keys/atlas-egress/atlas.gemini.key < /path/to/gemini.key >/dev/null
export ATLAS_PROVISIONED=1
```

Two more shared artifacts are **required before egress will serve**: the quarantine recipient public key and the capability-MAC secret. Setup deliberately does **not** create placeholders (empty files brick startup — the daemon treats an empty capability key as present and fails an empty pub with `Failed to read asymmetric key`; a *missing* capability key it bootstraps itself). On a fresh machine, generate the quarantine keypair and install the public half (the daemon consumes SPKI **DER**):

```bash
# X25519 quarantine keypair. PRIVATE half stays with the operator/CLI (it opens the
# sealed spool) — keep it OUT of any repo; e.g. ~/.config/atlas/quarantine-recipient.key.
openssl genpkey -algorithm X25519 -outform DER -out ~/.config/atlas/quarantine-recipient.key
openssl pkey -inform DER -in ~/.config/atlas/quarantine-recipient.key -pubout -outform DER -out /tmp/quarantine-recipient.pub
sudo install -o atlas-agent -g atlas-git -m 0644 /tmp/quarantine-recipient.pub /usr/local/etc/atlas/keys/shared/quarantine-recipient.pub && rm /tmp/quarantine-recipient.pub
# capability-MAC secret: leave the file ABSENT — the daemon bootstraps it 0640 on
# first start. To pin one explicitly instead:
#   openssl rand -base64 32 | sudo install -o atlas-egress -g atlas-git -m 0640 /dev/stdin /usr/local/etc/atlas/keys/shared/egress-capability.key
```

(Migrating an existing install? Copy the previous machine's key set instead of generating — otherwise old sealed spool artifacts and any in-flight capabilities become unopenable/unverifiable.)

---

## 4. Environment variables

Each verified against source before documenting.

| Var | Read by | What it does |
|---|---|---|
| **`ATLAS_PROVISIONED`** | `apps/cli/src/commands/doctor.ts:356`; the two-UID gate in `packages/broker/test/approval-boundary.adversarial.test.ts:127` (the one suite that skips without it) | `="1"` enables the OS-level test suites and tells `doctor` the custody-key/identity checks are active (a dev host that hasn't provisioned reports `provisioning-presence` as info, not a failure). Purely a gate — no runtime behavior beyond that. |
| **`ATLAS_EGRESS_CAPABILITY_KEY_FD`** | `packages/broker/src/egress/capability-custody.ts` — the one resolver both the CLI mint path and the egress daemon use | An already-open **file descriptor** carrying the raw capability-MAC secret, as an alternative to the path form below. This is how the launchd sync wrapper hands the Keychain-fetched secret to the `index:reconcile` drain: never written to disk, never in any environment (the env carries only the integer), command-scoped — it dies with the process. **Wins when both forms are set** (an explicit hand-off must not be silently downgraded to a standing on-disk credential), and never bootstraps a secret. Fail-closed on an unreadable fd or an empty payload. You do not set this by hand; `atlas-sync-wrapper.sh` does. |
| **`ATLAS_EGRESS_CAPABILITY_KEY`** | `packages/broker/src/egress/capability-custody.ts`, via `packages/models/src/capability.ts` (CLI mint) and `packages/broker/bin/atlas-egress.ts` (daemon verify) | Path to the **shared** capability-MAC secret file. The CLI reads it to *mint* a run-bound egress capability; the egress daemon reads the **same** file to *verify* it. **Must be exported for every mint-bearing command** (`index rebuild`, `index repair`, `index eval`, `query`) or the mint throws before the provider call. The launcher points it at `…/keys/shared/egress-capability.key` (0640, group `atlas-git`) — the CLI must run as an identity that can read it (member of `atlas-git`, e.g. `atlas-agent`). |
| **`ATLAS_VAULT_REPO_DIR`** | `packages/broker/src/keys.ts:167` (`throw` if unset), `provisioning/bin/broker-launcher.sh:18` (default `/var/lib/atlas/vault`, overridable) | The git repo the **broker** mutates — it is the sole writer of that repo's protected refs (`refs/heads/main`, `refs/audit/runs`, `refs/trust/ledger`). Point it at the same directory as your config `vault.path`. The broker validates `refs/audit/runs` in this repo **at startup** and exits 4 if the repo doesn't exist yet — start the broker only *after* the repo exists. |
| **`ATLAS_ROOT`** | `apps/cli/src/main.ts:94-95` | Overrides the auto-detected cli-contract root (where `docs/specs/cli-contract/commands.json` lives). Precedence: `options.root` → `env.ATLAS_ROOT` → `findRoot` (walks up from the module dir). You only need it if you run the binary from outside the repo layout; running from the checkout, auto-detect works. |

The broker/egress **launchers** export the rest of the daemon env (`ATLAS_BROKER_SOCKET`, `ATLAS_BROKER_KEYS_DIR`, `ATLAS_AUDIT_ANCHOR_PATH`, `ATLAS_EGRESS_SOCKET`, `ATLAS_EGRESS_KEYS_DIR`, `ATLAS_GEMINI_KEY_FILE`, `ATLAS_EGRESS_QUARANTINE_PUBKEY`, `ATLAS_EGRESS_QUARANTINE_SPOOL`, `ATLAS_EGRESS_BUDGET_STATE`) — you don't set those by hand. Config `ATLAS_<SECTION>_<KEY>` overrides (e.g. `ATLAS_INDEXING_DIMENSIONS=768`) are a separate mechanism handled in `apps/cli/src/config/load.ts`. **`ATLAS_TEST_MODE` is production-forbidden** — the launchers never set it (D20; the broker hard-rejects the test signer without it).

---

## 5. First-run sequence

Every command below exists in [`specs/cli-contract/commands.json`](specs/cli-contract/commands.json) (50 commands, all `implemented:true`).

### 5.1 Config file

There is no `init` command — the config is hand-authored YAML at `<cwd>/brain.config.yaml` (or `--config <path>`). Copy the example and adjust paths:

```bash
cp brain.config.example.yaml brain.config.yaml
```

The schema is **strict** ([`../apps/cli/src/config/schema.ts`](../apps/cli/src/config/schema.ts)) — 12 required sections (`vault sqlite lancedb indexing retrieval git models policies jobs logs broker quarantine`); an unknown key or bad value fails startup with `ConfigError` (exit 2) naming the file + key. Set `vault.path` to your vault git repo. **The example's `broker.socket_path` / `egress_socket_path` / `git.audit_anchor_path` use macOS paths** — on Linux change them to `/var/run/atlas/*.sock` and `/var/lib/atlas/audit-anchor`. They must match the launcher's per-OS socket paths.

### 5.2 Start the daemons

The broker daemon is needed for any command that appends an audit event; the egress daemon for any command that calls the provider.

**macOS default — launchd services** (§3 "Run the daemons as services"). The broker validates `refs/audit/runs` in `ATLAS_VAULT_REPO_DIR` at startup, so the vault repo must exist at the launcher default **before** `services.sh install`, owned so the broker can write it and the `atlas-git` group can read it:

```bash
# fresh vault (or `git clone <existing>` instead of init):
sudo git init /var/lib/atlas/vault
sudo chown -R atlas-broker:atlas-git /var/lib/atlas/vault
sudo chmod -R g+rX /var/lib/atlas/vault

sudo provisioning/macos/services.sh install
provisioning/macos/services.sh status      # both: loaded (pid N)
tail -3 /usr/local/var/log/atlas/*.log     # "…listening on …" per daemon
```

A different vault location = add `ATLAS_VAULT_REPO_DIR` to `EnvironmentVariables` in `provisioning/macos/com.atlas.broker.plist`, then (re-)run `install`.

**Foreground alternative** (Linux, or one-off debugging — dies with the terminal, no restart-on-crash):

```bash
sudo -u atlas-broker env ATLAS_VAULT_REPO_DIR="$VAULT" \
  /usr/local/lib/atlas/bin/broker-launcher.sh &
sudo -u atlas-egress /usr/local/lib/atlas/bin/egress-launcher.sh &
```

### 5.3 Ledger, projections, index, query

```bash
# Create the ledger + apply all migrations. db migrate is the SOLE migration
# composition root (it registers 0002_jobs / 0006_workflow_idempotency / 0008
# BEFORE store.migrate()). Pure local — no daemon. (#145: a fresh drive that skips
# this dies later with "no such table: index_config_revisions".)
brain db migrate

# Build the SQLite projections from the vault Markdown. Reads vault.path, appends one
# run.projection audit event (needs the BROKER daemon). No provider call.
brain db rebuild

# Build the LanceDB retrieval index (chunk → embed → activate). Needs the EGRESS
# daemon + a real Gemini key + the capability key exported:
export ATLAS_EGRESS_CAPABILITY_KEY="/usr/local/etc/atlas/keys/shared/egress-capability.key"
brain index rebuild
brain index verify        # confirm the index is consistent with the projections

# First grounded, cited query (needs broker + egress + the capability key).
brain query "who runs the Cloud team"
```

**Populating the vault.** `db rebuild` reads whatever valid Markdown is at `vault.path`. To onboard an existing real vault instead of hand-authoring notes, use the graduation path — `graduation scan` → `graduation audit` → `graduation migrate --apply` (byte-exact, deterministic, fail-closed; [`specs/bootstrap-migration.md`](specs/bootstrap-migration.md), fixtures authoritative over prose). `graduation migrate --apply` is broker-authorized (`--export-challenge` → sign → `--authorization <path>`, security-broker-contract §7.5); `--yes` never authorizes. For the exact real-vault drive, follow the retro runbook, **not** the search-index plan (§7 below).

### 5.4 Adopting a live vault for continuous sync (60-A)

**Do not run this section until Phases 1–4 of the `live-vault-adoption-sync` plan (#263–#266) are installed and `brain sync --dry-run` passes on a throwaway clone.** The adoption bootstrap is one-time and idempotent; the first real `brain sync` immediately follows.

After graduation, run the provisioning bootstrap to create the `refs/atlas/main` baseline commit, lock the namespace to the broker, migrate the DB to include `sync_cursors`, and seed the zero-state cursor:

```bash
# Requires: root, provisioned host, brain binary built, apps/cli/dist/sync/seed-cli.js built.
sudo provisioning/adopt-vault.sh \
  --config /path/to/config-dir \
  --source-id main-vault \
  --vault /path/to/vault-repo \
  [--upstream-ref refs/heads/main]    # default: refs/heads/main
  [--canonical-ref refs/atlas/main]   # default: refs/atlas/main
```

What the script does (idempotent — safe to re-run):

1. **Creates `refs/atlas/main`** at a broker-attributed empty-tree baseline commit (deterministic epoch timestamp; never at `refs/heads/main`).
2. **Locks `.git/refs/atlas/`** — `chown atlas-broker:atlas-broker` + `chmod 0700`. Enforces OQ#2: only the broker can write `refs/atlas/*` going forward. (ATLAS_PROVISIONED=1 only.)
3. **OQ#2 adversarial gate** — proves `atlas-agent` is denied write on `refs/atlas/main`, broker is not. Halts on failure. (ATLAS_PROVISIONED=1 only.)
4. **`brain db migrate`** — applies `0012_sync_cursors` (and any outstanding migrations).
5. **Seeds `sync_cursors`** — inserts the zero-state row via `node dist/sync/seed-cli.js` (INSERT OR IGNORE, so re-running never clobbers an advanced cursor).
6. **Validates** — `refs/atlas/main` resolves, upstream ref is unchanged, re-seeding is a no-op, config `git.canonical_ref` matches.

**Config requirement:** set `git.canonical_ref: refs/atlas/main` in `brain.config.yaml` before adoption. A config with the default routes Atlas writes onto the live upstream.

**Packed-refs caveat (60-F):** `git pack-refs` by a non-broker user can pack `refs/atlas/main` into `.git/packed-refs`, bypassing the per-directory ACL. Restrict `gc`/`pack-refs` to `atlas-broker` until the bare-mirror variant (60-F) ships.

**Activation sequencing:**
```
adoption bootstrap  →  brain sync --dry-run (throwaway clone)  →  brain sync
```
Do NOT run `brain sync` until all of Phases 1–4 are installed; a premature sync against an un-adopted vault will fail cleanly (canonical ref not found), but a partially-adopted state can leave the cursor unseeded.

### 5.5 Enrolling a Secure-Enclave approver (SP-3)

Every privileged op (`purge`, `graduation migrate --apply/--rollback`, `db restore`, `git approve/rollback`, `source trust promote/revoke`, `quarantine inspect/resolve`) is authorized by the non-interactive challenge/response flow (`--export-challenge` → sign → `--authorization <path>`). Out of the box **no production signer is enrolled** — `approval-verify.pub` is seeded empty and the only working signer is the D20-gated test fixture. SP-3 fills that with a **Secure-Enclave-born, Touch-ID-gated P-256 key** owned end-to-end by `atlas-signer` (the agent UID can't read the blob; the broker holds only the public key).

**Two commands, one per side of the trust boundary** (the enrollment MUST stay a separate, `sudo`-gated, human-typed step — it crosses from operator-space into broker custody):

```bash
# 1  operator-space: build + link + mint the SE key (fires Touch ID) + export the pubkey
console/signer/install.sh                    # builds -c release, links ~/bin/atlas-signer,
                                             # keygen (Touch ID), pubkey --out approver.pem,
                                             # and prints the exact enroll line below

# 2  sudo: install the public key into broker custody + restart the broker
sudo provisioning/enroll-signer.sh --pubkey approver.pem --signer-id approver-se-<host>-v1 --alg p256 --presence
```

`--presence` grants the two `os-presence` quarantine ops (it is refused on `--alg ed25519` — a file key proves custody, not presence). The script materializes the derived registry first (never dropping the attestation/test entries), refuses aliasing / silent key-swaps / silent rights changes, and restarts the broker so it loads the new signer (enrollment is **not** live-reloaded). `brain doctor` gains a `signer-registry` check that flags a dropped attestation entry, a quarantine op without presence, `ATLAS_TEST_MODE` on a provisioned host, or an orphaned `approval-verify.pub`.

**The terminal round trip** (identical shape to the old test-mode flow):

```bash
brain source trust promote --source s_… --to tier1 --export-challenge > challenge.json
atlas-signer sign < challenge.json > authorization.json     # displays the exact effect, Touch ID
brain source trust promote --source s_… --to tier1 --authorization authorization.json
```

`atlas-signer` exit codes are its own table (the SP-2 Console branches on them): `0` signed · `1` internal · `2` malformed/invalid challenge · `3` expired (checked before the prompt) · `4` cancelled/biometry-failed · `5` key invalidated by biometry re-enrollment.

**Re-enrollment (biometry change).** Adding/removing a fingerprint invalidates a `.biometryCurrentSet` SE key; `atlas-signer sign` then exits **5**. Recover by rotation — the `-v(N+1)` id is derived automatically:

```bash
atlas-signer keygen --force                                  # mints approver-se-<host>-v(N+1); Touch ID
atlas-signer pubkey --out approver.pem
sudo provisioning/enroll-signer.sh --pubkey approver.pem --signer-id approver-se-<host>-v(N+1) --alg p256 --presence
sudo provisioning/enroll-signer.sh --revoke --signer-id approver-se-<host>-vN    # revoke the old id
```

Key loss is an **enrollment event, not a DR event** — the vault/ledger/audit chain are indifferent to which enrolled signer approves. The broker restart voids in-flight nonces (5-min TTL), so re-export any pending challenge.

### 5.6 Enabling continuous sync (60-B, Phase 6)

Adoption (§5.4) makes `brain sync` *possible*; this makes it *continuous*. `com.atlas.sync` is a 300 s launchd timer running `atlas-sync-wrapper.sh` as `atlas-agent`, which does the two steps that must both happen for a new note to become retrievable:

```
brain sync --json          absorb upstream refs/heads/main → refs/atlas/main, enqueue index:reconcile
brain jobs run --all --json   drain that job (this is the step that indexes)
```

`services.sh install` copies the plist but leaves the timer **disabled**. Enabling it is a separate, gated command — a timer started before its prerequisites hold looks healthy in `launchctl` while fail-closing every cycle.

```bash
# 1  provision the capability secret into the atlas-agent Keychain (the wrapper's custody point)
sudo security add-generic-password -a atlas-agent -s atlas-egress-capability \
  -w "$(sudo cat /usr/local/etc/atlas/keys/shared/egress-capability.key)" -U

# 2  dry-run the gate — read-only, tells you exactly which prerequisite is missing
provisioning/macos/services.sh sync-gate /path/to/vault-repo

# 3  enable (root; names the brain-hub puller that advances local refs/heads/main)
sudo ATLAS_UPSTREAM_PULLER_LABEL=com.example.brainhub.sync \
  provisioning/macos/services.sh enable-sync /path/to/vault-repo

provisioning/macos/services.sh status          # com.atlas.sync: loaded
tail -f /usr/local/var/log/atlas/sync.log
```

**The five gates, and why each one exists:**

| Gate | If unmet |
|---|---|
| wrapper installed + executable | nothing runs |
| the wrapper's baked-in `brain` path is absolute and executable | launchd has no shell PATH — a bare `brain` dies at command resolution *every cycle* |
| `atlas-agent` can open the vault repo (repo-specific `safe.directory`) | the wrapper runs as a different user than the vault owner; git's dubious-ownership guard kills the first `readRef` even with every other gate green |
| the Keychain item is reachable **as `atlas-agent`** | every drain fail-closes with no credential |
| `ATLAS_UPSTREAM_PULLER_LABEL` names a **loaded** puller | `brain sync` reads the **local** `refs/heads/main` and `atlas-agent` is network-denied (D17) — without a puller the timer never observes a single remote push |

**Interactive-session posture only.** The Keychain fetch needs an unlocked keychain, so this is supported for a logged-in session. The fully-headless (logged-out) unlock story and the stronger broker-mediated per-run capability handoff are both deferred (plan OQ#1(a)/(b)); do not enable the timer for unattended/logged-out use until those are settled.

**Rotating the capability secret** — a restart cutover, not a dual-key window (the egress broker loads exactly one secret at startup and has no reload machinery). Full procedure + rollback: [`../provisioning/CLAUDE.md`](../provisioning/CLAUDE.md) § "Egress capability key custody".

**Rollback:** `sudo provisioning/macos/services.sh disable-sync`. Sync reverts to manual `brain sync` on demand; no data change.

### Daemon requirements at a glance

| Command | broker | egress + `ATLAS_EGRESS_CAPABILITY_KEY` |
|---|---|---|
| `db migrate`, `db status`, `db verify`, `inspect`, `status`, `doctor` | no¹ | no |
| `db rebuild` | **yes** (audit) | no |
| `index rebuild` / `repair` / `eval`, `query` | **yes** | **yes** |
| `graduation migrate --apply` | **yes** (authorization + protected-ref advance) | no |

¹ `doctor` *probes* the broker socket but tolerates its absence (reports it, never crashes).

---

## 6. Verification

```bash
brain doctor           # read-only host/vault health; NOT a run (emits no audit event)
brain db status        # applied migration head + per-table row counts + watermark health
```

`doctor` runs the Phase-1 check inventory (`apps/cli/src/commands/doctor.ts`) — `modes-permissions`, `lock-liveness`, `backup-watermark`, `audit-anchor`, `provisioning-presence` (active only under `ATLAS_PROVISIONED=1`), `encrypted-volume`, `quarantine-security`, `sandbox-capability`. Aggregate exit **0** = all pass/warn/degrade; **6** (action-required) names the failing check in its `detail`. `--reclaim-locks` is its one narrow mutation (removes lock records held by a provably-dead pid).

`db status` is a **pure diagnostic** — no lock, no audit, and it stays available even when the backup watermark is `blocked` (so you can always inspect a blocked store). A fresh/unmigrated DB reports an empty head + no tables — if you see that after §5.3, `db migrate` didn't run against this config.

Exit codes (stable, from `apps/cli/src/errors/envelope.ts`): `0` ok · `1` validation · `2` config/vault/lock · `3` secret-scan · `4` internal · `5` usage · `6` action-required. **The single-error envelope never emits exit 7** — provider-retryable outcomes ride as exit 4/6 carrying `retryable:true` + `retryAfterMs`. The one process path that can return exit 7 is the `jobs run` batch aggregate (jobs-run schema `exitCode` enum).

---

## 7. CI parity

[`../.github/workflows/ci.yml`](../.github/workflows/ci.yml) is the reference sequence — mirror it locally to reproduce a CI result:

```bash
sudo -E provisioning/ci/setup.sh          # dev provision + sudoers drop-in (D1)
pnpm install --frozen-lockfile
pnpm -r build
ATLAS_PROVISIONED=1 pnpm -r test          # provisioning-gated suites run, don't skip
node tools/gen-cli-contract.ts --check    # command-registry drift gate (must be clean)
```

Matrix: `ubuntu-latest` + `macos-15`, Node **26**, both with passwordless sudo. `gen-cli-contract.ts --check` is the only tool invoked as an explicit CI step; failpoints/state-table drift is caught inside `pnpm -r test`.

---

## 8. Troubleshooting

Live-drive gotchas, cross-checked against [`retros/2026-07-18-search-index-live-drive-retro.md`](retros/2026-07-18-search-index-live-drive-retro.md) (the authoritative source; its six corrections **supersede** the search-index plan's Task-5 runbook).

- **Host provisioned before 2026-07-19 and a daemon crash-loops `EACCES` / `Failed to read asymmetric key` / `budget state … unreadable/corrupt`?** Old `setup.sh` had four first-deploy lockouts (shared-keys-dir owner, anchor-parent `0700` over the egress state dir, run-dir owner vs D18, empty placeholder key/budget files). All fixed in current `main` — **re-run `sudo provisioning/dev/setup.sh`** (idempotent), delete any zero-byte `budget-state.json` / `egress-capability.key` / `quarantine-recipient.pub`, then follow §3's real-key step. Daemon-side rule of thumb: *missing* files are handled, *empty* ones fail closed.

- **`broker.audit_seq_nonmonotonic: seq 0 is not the next sequence 1` at startup.** You pointed the drive broker at a graduated copy that already carries graduation's `refs/audit/runs`, so a fresh ledger (seq 0) collides. A drive broker needs its **own** vault repo + **fresh** anchor: `git clone` the grad-copy into a new `drive-vault` (clone drops custom `refs/audit/*`), point config `vault.path` **and** `ATLAS_VAULT_REPO_DIR` there, use a separate anchor.

- **`db rebuild` fails `rebuild-failed` on ~209 frontmatter-less notes.** `graduation migrate --apply` writes migrated notes into the copy's **working tree (uncommitted)** plus a `.bootstrap-backup/` dir of pre-migration originals. **Commit the migration before cloning** the drive vault, and `git rm -r .bootstrap-backup` from the clone — otherwise the rebuild reads the originals and refuses the partial snapshot.

- **`db-unavailable: no ledger database exists yet` on `db rebuild`.** A fresh ledger needs `db migrate` **before** `db rebuild` — rebuild does not create the ledger.

- **The embed/generate mint throws before any provider call.** `ATLAS_EGRESS_CAPABILITY_KEY` isn't exported (or points at the wrong file, or your user can't read the 0640/group-`atlas-git` shared secret). Export it for every `index rebuild`/`index eval`/`query`; run as a user in `atlas-git`.

- **Broker exits 4 (`ENOENT`) at startup.** It validates `refs/audit/runs^{commit}` in `ATLAS_VAULT_REPO_DIR` on boot. Start it only after the vault repo exists (§5.2 orders `git init` before the broker).

- **`nonce expired` / unmapped `internal` (exit 4) on `graduation migrate --apply`.** The apply challenge nonce has a short TTL (5 min default; a ~2 h gap expired it on the live drive). Re-export the challenge → re-sign → apply promptly, close together.

- **`the egress broker is unreachable at <socket>` (exit 2).** The egress daemon isn't running, or your config `egress_socket_path` doesn't match the launcher's per-OS socket. Check the daemon is up and the paths agree (the example config is macOS-pathed; Linux uses `/var/run/atlas/egress.sock`).

- **`node apps/cli/dist/index.js <cmd>` prints nothing and exits 0.** `index.js` is the library entry, not the executable. Use `dist/bin.js` or the linked `brain` (§2). Some other docs still reference `index.js` — treat it as `bin.js`.

- **Retrieval below the gate / FTS scoring poorly.** The eval gate is **recall@10 ≥ 0.85, MRR ≥ 0.70** (`index eval`). Default **hybrid** is now the recommended config (recall 0.911 / MRR 0.830) since #159 built a real stemmed/stop-word FTS index (`packages/lancedb-index/src/fts.ts`, `ensureFtsIndex`, run at the end of `index rebuild`/`repair`). If FTS was never built, FTS-weighted RRF collapses recall (~0.49) — re-run `index rebuild` so the index exists; `retrieval.fts.enabled: false` (vector-only) is the fallback, no longer the default.

- **`graduation scan` blocks with tens of thousands of findings.** Scan ruleset v2 (#143) fixed a 36,598-false-positive block on real prose; confirm you're on current `main` — an older ruleset flags ordinary text.

- **`doctor exits 0` fails deterministically on a real host** because e2e fixtures wrote sealed bundles into the shared OS state dir. Pin `quarantine.dir` inside a temp root, outside repo+vault (#144). The example config leaves it unset (uses the OS state dir) — set it for isolated runs.

### Known-open items (won't block a first install)

- **#60** — graduation E2E remaining slices: workflow-runs + purge live on the migrated copy, `tools/scale-bench.ts` (5k/50k profiles), the ingest→index auto-hook. Real-copy apply stays human-gated (D20).
- **#65** — ledger/backup DR hardening residuals from the #23 review (seq-allocator rewind after restoring an older cut, interrupted-restore recovery not wired into universal startup, `--force-unblock` wrongly requiring the AEAD key). Durability edges, not authorization bypasses.

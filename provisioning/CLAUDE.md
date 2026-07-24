# provisioning/ — host identity + key + anchor substrate

**The one human-led, `sudo`-required step in the whole build** (`provisioning/README.md:8-9`). `sudo` is needed here and **nowhere else**. These scripts create the OS layout — three identities, one group, per-identity key custody, WORM anchor, socket run dir, hash-verified install dir, sandbox prereqs, agent network confinement — that every security suite depends on (broker #22/#23, egress #34/#76, sandbox #29). Authored **directly, not dispatched** because it is security-critical and human-run (`3ca265a` body).

This is a plain directory, not a workspace package (no `package.json`). Its ACL contract is tested from `tools/` (`tools/provisioning-acl.test.ts`, always-on, no sudo); the live OS-level assertions live in `packages/broker/test/` and gate on `ATLAS_PROVISIONED=1`.

## What it provisions

- **Two runtime service identities** — `atlas-broker` (protected-ref writes, approval verification, audit append, WORM anchor) and `atlas-egress` (sole provider-credential holder + sole outbound-network process, **no vault access**) (`keys.acl.json:6-7`).
- **Non-login agent UID** `atlas-agent` (`$ATLAS_AGENT_USER`) — unprivileged CLI + parser + workflow; network-denied at the UID (D17) (`lib.sh:29`).
- **`atlas-git` group** — vault-repo read + object-store write; members are `atlas-agent` + `atlas-broker` only; `atlas-egress` **deliberately excluded** (D18) (`dev/setup.sh:24-27`, `keys.acl.json:10-15`).
- **Per-identity `0700` key custody** — ed25519/AEAD/provider keys with exact owner+mode from the ACL matrix (`dev/setup.sh:29-60`).
- **WORM audit anchor** (D8), **setgid socket run dir** (D10), **hash-verified install dir** (D16), **cross-identity egress state** (#34/D19).
- **Sandbox parser prereqs** (#29, Linux): bubblewrap + unprivileged userns + cgroup-v2 delegation (`dev/setup.sh:97-141`).
- **Agent network confinement** (D17): macOS pf anchor + Seatbelt profile; Linux netns + cgroup slice.

## Key files

| File | Role |
|---|---|
| `keys.acl.json` | ACL matrix SSOT — identities, group membership, per-key `readableBy`/mode/owner, per-OS resolved paths, socket modes. Checked by `tools/provisioning-acl.test.ts` + the live `provisioning.separation` suite. |
| `lib.sh` | Shared no-side-effect-on-source helpers: per-OS path resolution (`Darwin` vs `Linux`), portable `create_group`/`create_service_user`/`add_to_group`/`ensure_dir`/`gen_ed25519`/`gen_aead`, `require_root` (exits 2), `free_id_at_or_above`, the `run()` dry-run wrapper. |
| `dev/setup.sh` | Dev host provision — idempotent, 8 numbered steps, sources `lib.sh`. |
| `dev/teardown.sh` | Reverse of setup — deletes users/group/keys/anchor/sockets/install dir. Idempotent. |
| `ci/setup.sh` | **RETIRED no-op stub** (phase-2-in-process-cutover, #312) — CI is zero-provisioning, so this no longer runs `dev/setup.sh` nor writes the `/etc/sudoers.d/atlas-ci` D1 sudoers. Deleted (not skipped) in Phase 3. For a real host provision run `dev/setup.sh` directly (the D1 CI sudoers it historically layered on top is no longer written anywhere). |
| `bin/broker-launcher.sh` · `bin/egress-launcher.sh` | Fixed-path root-owned launchers; export the daemon env contracts, `exec` the installed binary. Never set `ATLAS_TEST_MODE` (D20). |
| `install-artifact.sh` | Hash-verified install of built privileged binaries into the root-owned `installBin`; records `<bin>.installed.sha256` for `provisioning.integrity.test`. The artifacts are produced by `tools/build-artifact.sh` (esbuild CJS single-file bundles of `@atlas/broker`'s two bins + sha256 manifests). |
| `enroll-signer.sh` + `enroll-signer-merge.mjs` | **SP-3 per-device signer enrollment / revocation.** `--pubkey <pem> --signer-id <id> --alg <ed25519\|p256> [--presence]` installs the exported public key as a `<keysDir>/atlas-broker/signers.json` entry (owner `atlas-broker`, `0600`); `--revoke --signer-id <id>` flips `status`. The bash wrapper owns args/validation/root-gate/ownership/**broker restart** (`launchctl kickstart -k` on macOS); the `.mjs` core owns the JSON merge (materialize-if-derived, **DER-SPKI-fingerprint identity**, aliasing/silent-swap/silent-rights-change refusal, idempotency) via `@atlas/broker`'s own derive + key-parse, so the file is exactly what `loadSignerRegistry` reads. `--presence` (the two `os-presence` quarantine ops) is refused on `--alg ed25519`. Escapes: `ATLAS_DRY_RUN=1`, `ATLAS_ENROLL_TEST_MODE=1` (skip root/chown/restart — the behavioral test seam), `ATLAS_ENROLL_SKIP_RESTART=1`. Behavioral contract: `tools/enroll-signer.test.ts`. The operator-space half (build + keygen + pubkey) is `console/signer/install.sh`. |
| `macos/services.sh` · `macos/com.atlas.{broker,egress}.plist` | launchd **system** services for the two daemons (`install\|uninstall\|status`): `RunAtLoad` + `KeepAlive`, per-identity `UserName`, `PATH` includes Homebrew (the bundles' shebang is `/usr/bin/env node`), logs `/usr/local/var/log/atlas/*.log`. Vault override = add `ATLAS_VAULT_REPO_DIR` to the broker plist's `EnvironmentVariables` + re-`install`. macOS-only; no systemd units yet. |
| `macos/com.atlas.sync.plist` · `macos/atlas-sync-wrapper.sh` | **The continuous-sync auto-hook (#60 Phase 6).** A 300 s `StartInterval` timer running as `atlas-agent` (`RunAtLoad false`, no `KeepAlive`) that executes the two-step wrapper: `brain sync --json`, then `brain jobs run --all --json` to drain the `index:reconcile` job sync enqueued — without step 2 the cursor advances and nothing is ever retrievable. The wrapper is rendered at install time with **four** substitutions (`@ATLAS_BRAIN_BIN@`, `@ATLAS_CONFIG_DIR@`, `@ATLAS_KEYCHAIN@`, `@ATLAS_SECURITY_BIN@`) because launchd supplies neither a shell PATH nor a useful cwd — it `cd`s into the config dir since `brain` resolves its config strictly as `<cwd>/brain.config.yaml` and launchd's cwd is `/`. The plist also pins **`HOME=/usr/local/var/atlas/agent`** (provisioned `0700` by `services.sh install`): launchd supplies no `HOME`, `atlas-agent`'s real one is the root-owned `/var/empty`, and the CLI's default quarantine state dir hangs off `HOME` — without it the first cycle that quarantines anything wedges. `install-artifact.sh` **SKIPS** the wrapper with a warning (never a hard fail) when `ATLAS_BRAIN_BIN`/`ATLAS_CONFIG_DIR` are unset or the resolved binary does not identify as the Atlas CLI, so hosts that never adopted a vault still install the daemons — and it **removes any stale wrapper** on that path rather than leaving old substitutions running. A non-executable `.js` entrypoint (plain `tsc` output is `0644`) is accepted via a root-owned `brain-shim.sh` in the same install dir, preserving both the wrapper's one-absolute-executable invariant and D16. Installed by `services.sh install` but **never bootstrapped there**; `services.sh enable-sync <vault-path>` is the only way in and runs `sync_gate` first. `disable-sync` is the rollback. Contract test: `tools/sync-plist.test.ts`; wrapper behavior: `apps/cli/test/sync-autohook.test.ts`. |
| `profiles/agent.sb` | macOS Seatbelt: `(deny default)` + `(deny network*)`, FS-restricted to vault + worker temp, keychain denied. |
| `macos/agent-pf.conf` · `macos/load-agent-pf.sh` | Per-UID pf anchor (`block drop out ... user <AGENT_UID>`) + its loader (substitutes the real UID at load — pf has no name→UID variable). |
| `linux/netns.sh` · `linux/agent-cgroup.sh` | Loopback-only netns (`{setup\|run -- <cmd>\|teardown}`) + systemd slice / cgroup-v2 confinement (`{setup\|teardown}`). |

## Per-OS path resolution (`lib.sh:9-25`, mirrored in `keys.acl.json:25-33`)

| Logical | Darwin | Linux |
|---|---|---|
| keys dir | `/usr/local/etc/atlas/keys` | `/etc/atlas/keys` |
| WORM anchor | `/usr/local/var/atlas/audit-anchor` | `/var/lib/atlas/audit-anchor` |
| run dir (sockets) | `/usr/local/var/run/atlas` | `/var/run/atlas` |
| egress state | `/usr/local/var/atlas/egress` | `/var/lib/atlas/egress` |
| install bin | `/usr/local/lib/atlas/bin` | `/opt/atlas/bin` |
| root group | `wheel` | `root` |

UID/GID: `free_id_at_or_above` claims the first FREE id ≥ `ATLAS_UID_BASE` (default **8420**, overridable); group takes base, service users take base+1 upward. macOS checks both `/Users` UniqueID and `/Groups` PrimaryGroupID to keep them aligned (`lib.sh:34,54-65`).

## ACL matrix — the key-custody contract (`keys.acl.json:16-23`)

`provisioning.separation.test` asserts no key is readable by more identities than its row lists.

| Key file | algo | readableBy | mode | owner |
|---|---|---|---|---|
| `approval-verify.pub` | ed25519-public | atlas-broker | 0640 | atlas-broker |
| `audit-attestation.key` | ed25519-private | atlas-broker | 0600 | atlas-broker |
| `audit-attestation.pub` | ed25519-public | atlas-broker, agent | 0644 | atlas-broker |
| `backup-aead.key` | aead-256 | trusted-cli | 0600 | agent |
| `quarantine-aead.key` | aead-256 | trusted-cli (`parserModelDenied`) | 0600 | agent |
| `atlas.gemini.key` | provider-credential | atlas-egress | 0600 | atlas-egress |
| `atlas-test-approver.key` | ed25519-private | atlas-broker (`testModeOnly`) | 0600 | atlas-broker |
| `signers.json` (SP-3) | registry-json | atlas-broker | 0600 | atlas-broker |

`trusted-cli` is an **alias resolving to `agent`** — the unprivileged CLI that writes the ledger owns backup + quarantine crypto (D13) (`keys.acl.json:8`).

## Launcher-exported env — the daemon contracts

- **Broker** (`bin/broker-launcher.sh:12-18`): `ATLAS_BROKER_SOCKET`, `ATLAS_BROKER_KEYS_DIR`, `ATLAS_AUDIT_ANCHOR_PATH` (broker also defaults per-OS), `ATLAS_VAULT_REPO_DIR` (default `/var/lib/atlas/vault`, **deployment-specific, overridable**), `ATLAS_CANONICAL_REF` (**live-vault adoption**: set to `refs/atlas/main` so the daemon mutates the adopted canonical ref, not `refs/heads/main`; unset ⇒ the plain-vault default. The launcher passes it through only when set).
- **Egress** (`bin/egress-launcher.sh:30-42`): `ATLAS_EGRESS_SOCKET`, `ATLAS_EGRESS_KEYS_DIR`, `ATLAS_GEMINI_KEY_FILE`, `ATLAS_EGRESS_CAPABILITY_KEY` (shared 0640: CLI mints/group-read, egress verifies/owner-read), `ATLAS_EGRESS_QUARANTINE_PUBKEY` (shared 0644), `ATLAS_EGRESS_QUARANTINE_SPOOL` (state, 2770 setgid), `ATLAS_EGRESS_BUDGET_STATE` (`budget-state.json`, egress-owned + egress-writable, 0660).

## Egress capability key custody (#60 Phase 6)

The capability-MAC secret is a **shared** secret with **two custody points**: the `atlas-egress` broker's copy (it VERIFIES) and the minting agent side (it MINTS). Both ends resolve it through one owner — `packages/broker/src/egress/capability-custody.ts` — which accepts two representations:

| Form | Env | Who uses it |
|---|---|---|
| custody **path** | `ATLAS_EGRESS_CAPABILITY_KEY` | the egress launcher (`…/keys/shared/egress-capability.key`, 0640 group `atlas-git`) and the interactive operator |
| **file descriptor** | `ATLAS_EGRESS_CAPABILITY_KEY_FD` | `atlas-sync-wrapper.sh` only — the Keychain value handed to the drain on fd 3 |

The fd form exists because the timer must not keep a standing on-disk credential in the agent's environment: the wrapper fetches the secret from the Keychain **after** `brain sync` has already finished, and passes it command-scoped to the drain. Never a here-string (`3<<<`) — bash backs those with a **temp file** on macOS, which would put the secret on disk. Process substitution + the `printf` builtin keeps it off disk and out of every argv. The fd form **wins** when both are set and **never bootstraps**; absent/unreadable/empty custody throws.

**Name the keychain FILE.** `-a atlas-agent` is only an *attribute*; with no keychain argument `security` reads the **invoking user's default keychain**, and `atlas-agent` is a home-less service UID (`NFSHomeDirectory /var/empty`) with no login keychain at all. Both the wrapper and the gate pass an explicit path — `/Library/Keychains/System.keychain` by default, overridable at install time with `ATLAS_SYNC_KEYCHAIN`.

**The fd read is memoized per process** (`fdSecretCache`). A pipe is drained by the first read, but the mint path resolves the secret on **every** `mintEgressCapability` and one `brain jobs run --all` drains many jobs in one process — un-memoized, the first minting job would consume the pipe and every later one would get an empty secret, failing as a transient `internal` until it burnt its attempt budget. Caching is exactly the fd form's semantics (command-scoped, immutable for the process lifetime); only *successful* reads are cached, so failures stay fail-closed. The **path form is deliberately not cached** — re-reading is what makes a rotation observable.

**Revocation is broker-side, not Keychain deletion.** Deleting the `atlas-agent` Keychain item stops the legitimate wrapper but does NOT revoke a value already exfiltrated from the agent — the `atlas-egress` copy is the authority. True revocation = invalidate the egress-side secret. (Per-*capability* revocation is structural: every minted capability is run-bound with a byte/token/cost budget and a 300 s TTL.)

**Rotation is a restart cutover, deliberately.** The egress broker loads exactly ONE capability secret at startup and has no key-ID / multi-key / reload machinery; a "stage new while still accepting old" protocol would mean building that machinery, which a single-operator vault does not need. The procedure accepts a brief mint gap:

1. `sudo provisioning/macos/services.sh disable-sync` — stop the timer.
2. Copy the old value aside (rollback material).
3. Write the **new** secret to **both** points: the shared key file (egress reads it at startup) and the `atlas-agent` Keychain item (`security add-generic-password … -U`).
4. Restart the egress broker so it loads the new secret (`sudo launchctl kickstart -k system/com.atlas.egress`).
5. Probe end-to-end: one real mint/reconcile (`brain jobs run --all --json` with the new key).
6. Confirm the **old** value is now rejected at the real mint boundary.
7. `enable-sync` again.

Both points are written *before* the restart, so there is no window where they disagree **while serving**. **Rollback from either half-applied state is the same move:** restore the retained old value to both points, restart egress, re-probe — "make both points agree, then restart" is well-defined regardless of which write failed. The `enable-sync` gate verifies the Keychain point is *reachable*; a successful mint probe (step 5) is what proves the two points are mutually valid.

> **CI parity gap — flagged, not assumed.** CI does not exercise the real Keychain fetch or the two-custody-point rotation: there is no unattended keychain-unlock in the ubuntu/macos-15 matrix. What CI *does* cover is the fd/path resolver and its fail-closed paths (`packages/broker/test/capability-custody.test.ts`), and the wrapper's sequencing/scoping against stubs (`apps/cli/test/sync-autohook.test.ts`). The Keychain step and rotation are verified **only** by the live-drive runbook (`docs/install.md` §5.6).

> **Interactive-session posture only.** The Keychain fetch needs an unlocked keychain. The fully-headless (logged-out) unlock story and the stronger broker-mediated per-run capability handoff (no standing agent-side secret at all) are both deferred — plan OQ#1(a)/(b), owner: operator. Do not enable the timer for unattended/logged-out use until they are settled.

## Invariants — do not break these

- **D18 — egress has NO vault access.** `atlas-egress` is out of `atlas-git` (`dev/setup.sh:27`); asserted by `provisioning-acl.test.ts:59-63`. The egress socket carries `atlas-git` only so the CLI IPC client can reach it (`keys.acl.json:36`).
- **D9 — file-based per-identity `0700` custody on BOTH OSes**, not macOS login keychains: broker/egress are non-login service accounts that cannot unlock a login keychain (`keys.acl.json:3`).
- **D8 — WORM anchor** broker-owned `0600`, parent `0700`, OUTSIDE vault+repo (`dev/setup.sh:84-88`).
- **D10 — setgid socket run dir** (2770, group `atlas-git`): sockets inherit the group without `atlas-egress` being a member (`dev/setup.sh:90-92`).
- **D16 — privileged binaries NEVER run from the agent-writable repo `dist/`.** Built → hashed → installed into the root-owned dir; launchers are fixed-path with fixed exec paths+args (`install-artifact.sh`, `bin/*-launcher.sh`). A compromised agent cannot swap them.
- **D17 — agent network denial is at the UID, not the launcher.** Two layers required: kernel pf/netns AND the Seatbelt/child-inherited sandbox. A direct `curl` from the agent must have no route even without a launcher.
- **D20 — `atlas-test-approver` is hard-rejected unless `ATLAS_TEST_MODE=1`.** Production launchers **never** set that var (`bin/broker-launcher.sh:19-20`); flagged `testModeOnly`, asserted (`provisioning-acl.test.ts:55-57`).
- **D1 — CI sudoers is scoped to the two launchers only** — nothing else. **Historical**: `ci/setup.sh` is now a retired no-op (CI is zero-provisioning, #312) and writes no sudoers at all; the invariant survives as the contract any future provisioned-CI sudoers must satisfy.
- **Single-holder secrets**: `atlas.gemini.key`, `quarantine-aead`, `audit-attestation` each `readableBy.length === 1` (`provisioning-acl.test.ts:65-69`).
- **Idempotency**: every creation helper guards on existence; safe to re-run.

## Gotchas & sharp edges (learned the hard way)

- **`agent` ≠ `atlas-agent`.** In the ACL matrix `agent`/`trusted-cli` are *identity keys* (and the keys-dir subdir name); the real OS account is `atlas-agent` (`$ATLAS_AGENT_USER`). #34 shipped a CI failure because the quarantine pubkey was `chown`ed to the bare string `agent`; the fix chowns to `$ATLAS_AGENT_USER` (`dev/setup.sh:74`).
- **Seatbelt `(with no-sandbox)` was a silent D17 bypass.** The original `agent.sb` (#16) carried `(allow process-exec (with no-sandbox))`, which runs the exec'd child with NO profile — every subprocess escaped and `(deny network*)` became a no-op. Proven: with the modifier `curl` reached the network; without it exit 134. Removed in #34/#76; the comment block at `profiles/agent.sb:16-24` is now **load-bearing documentation — do not reintroduce the modifier**.
- **The pf anchor ships a literal `<AGENT_UID>` placeholder** — pf has no name→UID variable, so `load-agent-pf.sh` substitutes the real provisioned UID at load. `agent-pf.conf` was never actually loaded by provisioning until #34 added the loader.
- **egress daemon could not start in production before #34.** `egress-launcher.sh` exported none of the vars the daemon `requireEnv`s → exit 4 at startup, and the budget-state default sat in a root-owned dir it can't write. Fixed by exporting the full cross-identity set + provisioning those artifacts with owner `atlas-egress`, group `atlas-git`, group-accessible mode — egress reaches them as OWNER, the CLI as GROUP, while `atlas-egress` stays OUT of `atlas-git` (D18 preserved) (`egress-launcher.sh:8-14`, `dev/setup.sh:62-82`).
- **Cross-identity egress state uses 2770 setgid** so spooled/drained files keep the `atlas-git` group — same trick as the socket run dir (`keys.acl.json:32`).
- **Placeholders, not real secrets:** `approval-verify.pub` (operator installs the enrolled approver's public key) and `atlas.gemini.key` (operator writes the real Gemini key via `sudo -u atlas-egress tee ...`) are seeded empty (`dev/setup.sh:44-60`, README §4).
- **Linux sandbox prereqs fail closed.** Ubuntu 24.04+ gates unprivileged userns behind AppArmor; setup sets `kernel.apparmor_restrict_unprivileged_userns=0` + installs `bubblewrap`/`util-linux` (warns if apt absent). cgroup-v2 delegation creates `/sys/fs/cgroup/atlas.slice` and chowns it to the runtime user; the operator must export `ATLAS_SANDBOX_CGROUP_ROOT` and run the sandbox suites inside that slice (or as root) or `probeSandbox()` reports resource-caps unavailable and fails closed. Stock hosted Linux CI can't provide delegated cgroups → Linux strictness is opt-in via `ATLAS_SANDBOX_REQUIRE=1` (#29/#72).
- **macOS teardown** deletes a service user's same-named primary group too (`teardown.sh:23`); Linux `userdel -r` is best-effort (falls back to plain `userdel`).

## `ATLAS_PROVISIONED` gating

Tests read `process.env.ATLAS_PROVISIONED === "1"` and skip when absent. **Two** OS-boundary cases actually gate on it — both are single `it.skipIf(...)` cases inside files whose surrounding in-process tests still run under CI:
- `approval-boundary.adversarial` — the two-UID `git update-ref` denial (`packages/broker/test/approval-boundary.adversarial.test.ts:127`); also needs passwordless `sudo -n` to **both** root and `atlas-agent` (`:127-130`).
- the **OQ#2 adoption boundary** — `atlas-agent` is denied `update-ref` on `refs/atlas/*` (`apps/cli/test/adopt-vault-bootstrap.test.ts:238-243`), gated on `ATLAS_PROVISIONED=1` **and** running as root (the `chown` to `atlas-broker` needs it).

Both files' other cases are ordinary in-process tests that execute normally on the zero-provisioning CI matrix — only these two boundary cases subset out. `provisioning.separation` / `provisioning.integrity` are **planned suite names that exist only in prose** (`keys.acl.json:3`, `dev/teardown.sh:8`, `install-artifact.sh:31`) — no such test files exist yet; `anchor.anti-truncation` runs fully in-process, ungated. `doctor` treats custody-key checks as active only under `ATLAS_PROVISIONED=1` (`apps/cli/src/commands/doctor.ts:356`). **CI is zero-provisioning** (phase-2-in-process-cutover, #312): `.github/workflows/ci.yml` leaves `ATLAS_PROVISIONED` unset and starts no daemons, so these suites cleanly subset (run their daemon-free in-process subset) there. `ci/setup.sh` is a retired no-op stub; the provisioned-only suites are deleted, not skipped, in Phase 3. Set `ATLAS_PROVISIONED=1` only on a local/manual provisioned host (via `dev/setup.sh`) to exercise the real two-UID paths.

## Operator entry points

```bash
sudo ATLAS_DRY_RUN=1 provisioning/dev/setup.sh   # preview every action, no mutation
sudo provisioning/dev/setup.sh                   # provision (idempotent)
sudo provisioning/dev/teardown.sh                # reverse
# NOTE: provisioning/ci/setup.sh is a RETIRED no-op (CI is zero-provisioning, #312) — use dev/setup.sh above for a real host
sudo provisioning/install-artifact.sh <dir>      # hash-verified privileged-binary install
sudo provisioning/enroll-signer.sh --pubkey approver.pem --signer-id approver-se-<host>-v1 --alg p256 --presence  # SP-3 enroll (restarts the broker)
sudo provisioning/enroll-signer.sh --revoke --signer-id approver-se-<host>-v1   # SP-3 revoke
provisioning/macos/services.sh sync-gate <vault>          # #60 Phase 6: probe the 5 gates, mutate nothing
sudo ATLAS_UPSTREAM_PULLER_LABEL=<label> provisioning/macos/services.sh enable-sync <vault>  # start the 300s timer
sudo provisioning/macos/services.sh disable-sync          # Phase-6 rollback (sync reverts to manual)
sudo provisioning/macos/load-agent-pf.sh         # macOS D17 kernel half
sudo provisioning/linux/netns.sh setup           # Linux D17 netns
export ATLAS_PROVISIONED=1                        # enable the provisioning-gated suites
```

Full runbook: `docs/install.md`. Live-drive gotchas: `docs/retros/2026-07-18-search-index-live-drive-retro.md` (authoritative).

## History

- **#16 → PR #63** (`3ca265a`): the whole tree in one shot (13 files). OS-portable macOS `dscl` / Linux `useradd`; egress excluded from `atlas-git` (D18) from day one; WORM anchor (D8), setgid socket dir (D10), root-owned install dir (D16), agent no-egress (D17). `tools/provisioning-acl.test.ts` + `ci/setup.sh` + `ATLAS_PROVISIONED=1` wired into `ci.yml`. Live separation/integrity/adversarial suites deferred to land with the broker.
- **#22/#23/#25 → PR #66** (`4909a65`): broker trio landed; `broker-launcher.sh` gained `ATLAS_AUDIT_ANCHOR_PATH` + `ATLAS_VAULT_REPO_DIR`. The live two-UID separation test was rewritten to genuinely run `git update-ref` AS `atlas-agent` (prior version ran as repo-owner → EACCES impossible → proved nothing); a `-c safe.directory` bypass surfaces the real ACL denial past git's dubious-ownership guard.
- **#29 → PR #72** (`2fa9c60`, HUMAN-LED): sandbox parser prereqs — bubblewrap install, AppArmor userns unblock, cgroup-v2 `atlas.slice` delegation. Linux strictness split to `ATLAS_SANDBOX_REQUIRE=1` (hosted runners lack delegated cgroups); macOS Seatbelt stays strict on CI.
- **#34 → PR #76** (`5b12be1`): the big correction pass — (1) removed the `(with no-sandbox)` D17 bypass + replaced the security-theater test with a real under-`agent.sb` probe with a positive control; (2) added `load-agent-pf.sh` to actually load the pf anchor with UID substitution; (3) fixed the egress daemon that could not start in prod (exported the cross-identity vars + provisioned owner-egress/group-atlas-git ACLs); (4) chown quarantine pubkey to `$ATLAS_AGENT_USER` not bare `agent`.

## Open items

- **Linux sandbox containment blockers deferred to real-host validation** (#5 / PR #72): seccomp still allows `execve`; FS jail mounts all of `/usr`; cgroup limit writes fail silently; Darwin `mach-lookup` unrestricted; darwin probes are a single allow-canary. These live in `packages/sources` but gate whether this dir's Linux sandbox prereqs are *sufficient* — confirm before trusting sandbox guarantees on a new host.
- **A host provisioned before #34 lacks the shared/ + egress-state layout** — re-run `dev/setup.sh` to add the cross-identity artifacts.
- **The `provisioning.separation` / `provisioning.integrity` suites were never implemented** — the names live in `keys.acl.json`, `dev/teardown.sh`, and `install-artifact.sh` comments only. Either implement them under those names or rename the references; until then only `approval-boundary.adversarial` exercises the live two-UID layout.
- **Ledger/backup DR residuals (#65)** touch the `backup-aead` custody this dir creates but are owned by `sqlite-store`.

## Cross-links

- Privilege-boundary SSOT: `docs/specs/security-broker-contract.md` (the ACL matrix + asset-class definitions this dir implements).
- Sandbox isolation contract: `docs/specs/sandbox-contract.md` (the guarantees the sandbox prereqs must satisfy).
- Consuming daemons: `packages/broker/` (`atlas-broker` + the `atlas-egress` daemon under `src/egress/`).
- Operator runbook: `docs/install.md`. ACL test: `tools/provisioning-acl.test.ts`. Design SSOT: `docs/specs/2026-07-11-atlas-v1-design.md`.

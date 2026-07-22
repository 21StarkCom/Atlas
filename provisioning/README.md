# Atlas host provisioning (Task 1.0 / #16)

Creates the two runtime identities (`atlas-broker`, `atlas-egress`), the non-login
`atlas-agent` UID, the `atlas-git` group, per-identity key custody, the WORM audit
anchor, the socket run dir, and the hash-verified install dir — the OS substrate the
broker/egress/ledger tasks (#22/#23/#25) and their security suites depend on.

**This is the one human-led step.** It needs `sudo` (creates OS users + protected
dirs). Nothing else in the build does. Review the scripts, then run the commands below.

## Files
| File | Purpose |
|---|---|
| `keys.acl.json` | machine-readable ACL matrix (the contract `provisioning.separation.test` checks) |
| `lib.sh` | shared helpers (OS-portable user/group/key creation) |
| `dev/setup.sh` · `dev/teardown.sh` | dev host provision / reverse |
| `ci/setup.sh` | retired no-op stub — CI is zero-provisioning (#312); deleted in Phase 3 |
| `bin/broker-launcher.sh` · `bin/egress-launcher.sh` | fixed-path privileged launchers (D16) |
| `install-artifact.sh` | hash-verified install of the privileged binaries (D16) — built by `tools/build-artifact.sh` |
| `macos/services.sh` · `macos/com.atlas.{broker,egress}.plist` | launchd system services (KeepAlive, per-identity UserName, logs in `/usr/local/var/log/atlas/`) |
| `profiles/agent.sb` · `macos/agent-pf.conf` | macOS agent sandbox + per-UID no-egress (D17) |
| `linux/netns.sh` · `linux/agent-cgroup.sh` | Linux agent no-egress netns + cgroup (D17) |

## Run it (macOS)

```bash
# 1. PREVIEW first — no changes, shows every action:
sudo ATLAS_DRY_RUN=1 provisioning/dev/setup.sh

# 2. Provision for real:
sudo provisioning/dev/setup.sh

# 3. Agent network-denial backstop (D17): load the per-UID pf anchor.
#    Substitute the provisioned UID first:
AGENT_UID=$(id -u atlas-agent)
sed "s/<AGENT_UID>/$AGENT_UID/" provisioning/macos/agent-pf.conf | sudo pfctl -a atlas/agent -f -
sudo pfctl -e   # if pf isn't already enabled

# 4. Real keys: Gemini credential (replaces the placeholder) + the quarantine
#    recipient PUBLIC key (generation commands: docs/install.md §3 — setup
#    deliberately creates NO empty placeholder; the daemon fails closed on one):
sudo -u atlas-egress tee /usr/local/etc/atlas/keys/atlas-egress/atlas.gemini.key < /path/to/gemini.key >/dev/null

# 5. Build + install the daemon binaries:
tools/build-artifact.sh
sudo provisioning/install-artifact.sh dist-artifact

# 6. Vault repo at the launcher default — MUST exist before services start
#    (the broker validates refs/audit/runs at startup and crash-loops without it):
sudo git init /var/lib/atlas/vault    # or git clone <existing>
sudo chown -R atlas-broker:atlas-git /var/lib/atlas/vault && sudo chmod -R g+rX /var/lib/atlas/vault

# 7. Run them as launchd services:
sudo provisioning/macos/services.sh install     # status | uninstall also available

# 8. Enable the provisioning-gated test suites:
export ATLAS_PROVISIONED=1
```

Reverse everything: `sudo provisioning/dev/teardown.sh`.

## What to verify (once #22–#25 land)
- `node apps/cli/dist/index.js doctor` — reports all provisioning checks green.
- `ATLAS_PROVISIONED=1 pnpm --filter @atlas/broker test` — `provisioning.separation`,
  `provisioning.integrity`, `approval-boundary.adversarial`, `anchor.anti-truncation` pass.

## V1 notes / decisions
- **Key custody (D9):** file-based per-identity `0700` dirs on **both** OSes (not macOS
  login keychains) — the broker/egress are non-login service accounts that can't unlock
  a login keychain. `provisioning.separation.test` verifies identity-scoped read access.
- **`approval-verify.pub` / `atlas.gemini.key`** are seeded as **placeholders** — the
  operator installs the enrolled approver's public key and the real provider credential.
- **`atlas-test-approver`** is generated but the broker **hard-rejects** it unless
  `ATLAS_TEST_MODE=1` (D20) — never set that outside CI fixture runs.
- **Network denial (D17)** is enforced at the UID (pf anchor / netns), so a direct
  `curl` from the agent has no route — it does **not** depend on using a launcher.
- **`atlas-egress` is excluded from `atlas-git`** (D18): the internet-facing identity
  has no vault/object-store read. Sockets inherit `atlas-git` via the setgid run dir.

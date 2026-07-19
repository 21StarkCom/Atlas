#!/usr/bin/env bash
# Atlas dev host provisioning (Task 1.0 / #16) — creates the two runtime identities,
# the agent UID, the atlas-git group, per-identity key dirs + keys, the WORM anchor,
# the socket run dir, and the hash-verified install dir. Idempotent; safe to re-run.
#
#   sudo provisioning/dev/setup.sh              # provision
#   sudo ATLAS_DRY_RUN=1 provisioning/dev/setup.sh   # preview only, no changes
#
# Sets ATLAS_PROVISIONED marker at the end. Reverse with provisioning/dev/teardown.sh.
set -euo pipefail
HERE="$(cd "$(dirname "$0")/.." && pwd)"
# shellcheck source=../lib.sh
source "$HERE/lib.sh"

require_root "$@"

step "Atlas provisioning on $ATLAS_OS (dry-run=$DRY_RUN)"

# 1) group + identities
create_group "$ATLAS_GROUP"
create_service_user "$ATLAS_AGENT_USER"
for u in "${ATLAS_USERS[@]}"; do create_service_user "$u"; done

# 2) group membership: agent + atlas-broker ONLY (D18 — atlas-egress excluded)
add_to_group "$ATLAS_AGENT_USER" "$ATLAS_GROUP"
add_to_group "atlas-broker" "$ATLAS_GROUP"
log "atlas-egress deliberately NOT added to $ATLAS_GROUP (D18: no vault access)"

# 3) per-identity key dirs (0700, owned by the identity) + keys (keys.acl.json)
ensure_dir "$ATLAS_KEYS_DIR" "root" "$ATLAS_ROOT_GROUP" 0755
ensure_dir "$ATLAS_KEYS_DIR/atlas-broker" "atlas-broker" "atlas-broker" 0700
ensure_dir "$ATLAS_KEYS_DIR/atlas-egress" "atlas-egress" "atlas-egress" 0700
ensure_dir "$ATLAS_KEYS_DIR/agent"        "$ATLAS_AGENT_USER" "$ATLAS_AGENT_USER" 0700

# broker keys
gen_ed25519 "$ATLAS_KEYS_DIR/atlas-broker/audit-attestation" "atlas-broker" "atlas-broker"
run "chmod 0600 '$ATLAS_KEYS_DIR/atlas-broker/audit-attestation.key'"
# audit-attestation public is also agent-readable by design → publish a group-readable copy.
# The shared dir is owned by atlas-egress: it must traverse it to reach the cross-identity
# artifacts (3b) it reads as OWNER — egress is deliberately NOT in atlas-git (D18), so
# any other owner locks it out entirely (observed live 2026-07-19: egress crash-looped
# EACCES on egress-capability.key behind an atlas-broker-owned 0750 dir).
ensure_dir "$ATLAS_KEYS_DIR/shared" "atlas-egress" "$ATLAS_GROUP" 0750
run "cp -f '$ATLAS_KEYS_DIR/atlas-broker/audit-attestation.pub' '$ATLAS_KEYS_DIR/shared/audit-attestation.pub'"
run "chown atlas-broker:$ATLAS_GROUP '$ATLAS_KEYS_DIR/shared/audit-attestation.pub'"
run "chmod 0644 '$ATLAS_KEYS_DIR/shared/audit-attestation.pub'"
# approval-verify (public verify key). In real use this is the enrolled approver's
# public key; provisioning seeds an empty placeholder the operator replaces.
run "touch '$ATLAS_KEYS_DIR/atlas-broker/approval-verify.pub'"
run "chown atlas-broker:atlas-broker '$ATLAS_KEYS_DIR/atlas-broker/approval-verify.pub'"
run "chmod 0640 '$ATLAS_KEYS_DIR/atlas-broker/approval-verify.pub'"
# atlas-test-approver (D20 — broker rejects it unless ATLAS_TEST_MODE=1)
gen_ed25519 "$ATLAS_KEYS_DIR/atlas-broker/atlas-test-approver" "atlas-broker" "atlas-broker"
run "chmod 0600 '$ATLAS_KEYS_DIR/atlas-broker/atlas-test-approver.key'"

# trusted-CLI (agent) keys: backup + quarantine AEAD
gen_aead "$ATLAS_KEYS_DIR/agent/backup-aead.key"     "$ATLAS_AGENT_USER" "$ATLAS_AGENT_USER"
gen_aead "$ATLAS_KEYS_DIR/agent/quarantine-aead.key" "$ATLAS_AGENT_USER" "$ATLAS_AGENT_USER"
run "chmod 0600 '$ATLAS_KEYS_DIR/agent/backup-aead.key' '$ATLAS_KEYS_DIR/agent/quarantine-aead.key'"

# egress provider credential placeholder (operator writes the real Gemini key)
run "touch '$ATLAS_KEYS_DIR/atlas-egress/atlas.gemini.key'"
run "chown atlas-egress:atlas-egress '$ATLAS_KEYS_DIR/atlas-egress/atlas.gemini.key'"
run "chmod 0600 '$ATLAS_KEYS_DIR/atlas-egress/atlas.gemini.key'"

# 3b) CROSS-IDENTITY egress artifacts (Task 2.8 / #34). The daemon requires these and exits 4
#     without them. They must NOT live in the egress-only 0700 keys dir: the CLI identity mints
#     capabilities and drains the quarantine spool. Same trick as the socket run dir — owner
#     atlas-egress, GROUP atlas-git, group-accessible; atlas-egress is NOT a group member, so
#     D18 (no vault/object read) still holds. Egress reaches these as OWNER, the CLI as GROUP.
#
#     capability MAC secret: CLI MINTS (group read), egress VERIFIES (owner read).
run "touch '$ATLAS_KEYS_DIR/shared/egress-capability.key'"
run "chown atlas-egress:$ATLAS_GROUP '$ATLAS_KEYS_DIR/shared/egress-capability.key'"
run "chmod 0640 '$ATLAS_KEYS_DIR/shared/egress-capability.key'"
#     quarantine recipient PUBLIC key: egress seals refused payloads to the CLI (public ⇒ 0644).
run "touch '$ATLAS_KEYS_DIR/shared/quarantine-recipient.pub'"
run "chown $ATLAS_AGENT_USER:$ATLAS_GROUP '$ATLAS_KEYS_DIR/shared/quarantine-recipient.pub'"
run "chmod 0644 '$ATLAS_KEYS_DIR/shared/quarantine-recipient.pub'"
#     egress state dir: budget file (egress-WRITABLE — the old default sat in a root-owned dir)
#     and the sealed-quarantine spool the CLI drains (2770 setgid so drained files keep the group).
ensure_dir "$ATLAS_EGRESS_STATE" "atlas-egress" "$ATLAS_GROUP" 2770
ensure_dir "$ATLAS_EGRESS_STATE/quarantine-spool" "atlas-egress" "$ATLAS_GROUP" 2770
run "touch '$ATLAS_EGRESS_STATE/budget-state.json'"
run "chown atlas-egress:$ATLAS_GROUP '$ATLAS_EGRESS_STATE/budget-state.json'"
run "chmod 0660 '$ATLAS_EGRESS_STATE/budget-state.json'"

# 4) WORM audit anchor (D8): broker-owned 0600, parent 0700, OUTSIDE vault+repo
ensure_dir "$(dirname "$ATLAS_ANCHOR")" "atlas-broker" "atlas-broker" 0700
run "touch '$ATLAS_ANCHOR'"
run "chown atlas-broker:atlas-broker '$ATLAS_ANCHOR'"
run "chmod 0600 '$ATLAS_ANCHOR'"

# 5) socket run dir (setgid atlas-git so egress/broker sockets inherit the group
#    without atlas-egress being a group member — D18 preserved)
ensure_dir "$ATLAS_RUN_DIR" "root" "$ATLAS_GROUP" 2770

# 6) install dir for the hash-verified privileged binaries (D16), root-owned
ensure_dir "$ATLAS_INSTALL_BIN" "root" "$ATLAS_ROOT_GROUP" 0755

# 7) sandbox parser prerequisites (Task 2.3 / #29): the untrusted-input parser worker
#    runs under a per-host jail. macOS uses the built-in Seatbelt (`sandbox-exec` —
#    always present). Linux needs bubblewrap (`bwrap`) + util-linux (`prlimit`) AND
#    unprivileged user namespaces enabled — Ubuntu 24.04+ gates those behind AppArmor
#    by default, which bwrap requires. Without these `probeSandbox()` fails closed and
#    `doctor` reports action-required, so provision them here (idempotent).
if [ "$ATLAS_OS" = "Linux" ]; then
  step "sandbox parser prerequisites (bubblewrap + unprivileged userns)"
  if ! command -v bwrap >/dev/null 2>&1; then
    if command -v apt-get >/dev/null 2>&1; then
      run "apt-get update -qq"
      run "DEBIAN_FRONTEND=noninteractive apt-get install -y -qq bubblewrap util-linux"
    else
      log "WARN: bwrap absent and apt-get unavailable — install bubblewrap manually (sandbox fails closed otherwise)"
    fi
  fi
  # Ubuntu 24.04+ blocks unprivileged user namespaces via AppArmor; bwrap needs them.
  if [ -e /proc/sys/kernel/apparmor_restrict_unprivileged_userns ]; then
    run "sysctl -w kernel.apparmor_restrict_unprivileged_userns=0 || true"
  fi

  # cgroup v2 per-worker resource caps (Task 2.3 / #29, finding 1): the parser worker is
  # placed in a fresh leaf cgroup that caps memory/pids/cpu and that it cannot leave. The
  # launcher needs a WRITABLE cgroup-v2 base whose subtree delegates memory/pids/cpu. We
  # provision a dedicated delegated slice so the (possibly non-root) runtime user can
  # create per-worker leaves + migrate the worker into them. Without this `probeSandbox()`
  # reports resource-caps unavailable and the sandbox fails closed.
  step "sandbox cgroup v2 delegation (per-worker memory/pids/cpu caps)"
  if [ -e /sys/fs/cgroup/cgroup.controllers ]; then
    ATLAS_CGROUP_SLICE="/sys/fs/cgroup/atlas.slice"
    # Delegate the controllers from the root, create the slice, delegate again into it,
    # and hand ownership to the runtime user so it can create+populate leaves. The user's
    # OWN shell should run inside this slice (or run the sandbox suites as root) so that
    # moving a worker into a leaf shares the slice as the (owned) common ancestor.
    run "sh -c 'echo +memory +pids +cpu > /sys/fs/cgroup/cgroup.subtree_control 2>/dev/null || true'"
    run "mkdir -p $ATLAS_CGROUP_SLICE"
    run "sh -c 'echo +memory +pids +cpu > $ATLAS_CGROUP_SLICE/cgroup.subtree_control 2>/dev/null || true'"
    run "chown -R \"${SUDO_USER:-$(id -un)}\" $ATLAS_CGROUP_SLICE 2>/dev/null || true"
    log "Export ATLAS_SANDBOX_CGROUP_ROOT=$ATLAS_CGROUP_SLICE (and run the sandbox suites"
    log "with your shell inside that slice, or as root) so resource-caps probes green."
  else
    log "WARN: cgroup v2 not mounted (/sys/fs/cgroup/cgroup.controllers absent) — the"
    log "sandbox resource-caps guarantee fails closed until cgroup v2 is available."
  fi
fi

# 8) OS-specific agent network confinement (D17) — best-effort, flagged if unavailable
if [ "$ATLAS_OS" = "Darwin" ]; then
  log "macOS: install the pf anchor + Seatbelt profile via provisioning/macos (see README §network-denial)"
else
  log "Linux: apply netns/cgroup confinement via provisioning/linux/{netns,agent-cgroup}.sh"
fi

step "DONE — verify with: node apps/cli/dist/index.js doctor  (once #22-#25 land)"
log "Set ATLAS_PROVISIONED=1 in your shell for the provisioning-gated test suites."

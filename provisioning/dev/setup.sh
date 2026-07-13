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
# audit-attestation public is also agent-readable by design → publish a group-readable copy
ensure_dir "$ATLAS_KEYS_DIR/shared" "atlas-broker" "$ATLAS_GROUP" 0750
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

# 7) OS-specific agent network confinement (D17) — best-effort, flagged if unavailable
if [ "$ATLAS_OS" = "Darwin" ]; then
  log "macOS: install the pf anchor + Seatbelt profile via provisioning/macos (see README §network-denial)"
else
  log "Linux: apply netns/cgroup confinement via provisioning/linux/{netns,agent-cgroup}.sh"
fi

step "DONE — verify with: node apps/cli/dist/index.js doctor  (once #22-#25 land)"
log "Set ATLAS_PROVISIONED=1 in your shell for the provisioning-gated test suites."

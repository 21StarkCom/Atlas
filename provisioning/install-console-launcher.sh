#!/usr/bin/env bash
# install-console-launcher.sh — install the Console's brain privilege-drop launcher (#298).
#
#   sudo provisioning/install-console-launcher.sh <operator-user>
#
# Installs `brain-as-agent.sh` root-owned into the fixed install dir (D16) and writes
# a visudo-validated /etc/sudoers.d rule letting <operator-user> run brain as
# atlas-agent WITHOUT a password — so an operator-launched Atlas Console can drive the
# privileged flow (which spawns brain, which needs the broker socket + atlas-git) while
# the operator stays OUT of atlas-git (D17/D18 preserved). Point the Console's
# `brainLauncher` setting (or ATLAS_BRAIN_LAUNCHER) at the installed path.
#
# THREAT MODEL (SP-3 spec §5.2 — single operator, single personal Mac): the rule grants
# the operator the ability to act as `atlas-agent`, which is a DELIBERATELY LESS-privileged
# UID (network-denied at the UID per D17, no root, not the credential/attestation holder).
# It is NOT root access and does NOT put the operator in atlas-git. Tighter command-scoping
# (bind the rule to exactly `env … node …/bin.js …`) is possible but fragile across
# node-path/arg variance and deferred; the boundary that matters (broker/root/attestation
# key) is untouched either way.
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
# shellcheck source=lib.sh
source "$HERE/lib.sh"
require_root "$@"

OPERATOR="${1:?usage: install-console-launcher.sh <operator-user>}"
id "$OPERATOR" >/dev/null 2>&1 || { echo "error: no such user: $OPERATOR" >&2; exit 2; }
AGENT_USER="${ATLAS_AGENT_USER:-atlas-agent}"
id "$AGENT_USER" >/dev/null 2>&1 || { echo "error: agent user $AGENT_USER not provisioned — run dev/setup.sh first" >&2; exit 2; }

DST="$ATLAS_INSTALL_BIN/brain-as-agent.sh"
step "install $DST (root-owned, D16)"
ensure_dir "$ATLAS_INSTALL_BIN" "root" "$ATLAS_ROOT_GROUP" 0755
install -m 0755 -o root -g "$ATLAS_ROOT_GROUP" "$HERE/bin/brain-as-agent.sh" "$DST"

SUDOERS=/etc/sudoers.d/atlas-console
step "write $SUDOERS (visudo-validated)"
rendered="$(mktemp -t atlas-console-sudoers)"
trap 'rm -f "$rendered"' EXIT
cat > "$rendered" <<EOF
# Atlas Console brain privilege-drop (#298). Lets $OPERATOR run brain as the
# unprivileged $AGENT_USER without a password, so the operator-run Console can reach
# the broker. $AGENT_USER is network-denied (D17) and holds no credential — this is not
# root and does not add $OPERATOR to atlas-git. Installed by install-console-launcher.sh.
Defaults:$OPERATOR env_keep += "ATLAS_ROOT ATLAS_EGRESS_CAPABILITY_KEY HOME"
$OPERATOR ALL=($AGENT_USER) NOPASSWD: ALL
EOF
# Validate BEFORE installing — a malformed sudoers file locks out sudo.
if ! visudo -cf "$rendered" >/dev/null 2>&1; then
  echo "error: generated sudoers failed visudo -c; not installing" >&2
  visudo -cf "$rendered" || true
  exit 2
fi
install -m 0440 -o root -g "$ATLAS_ROOT_GROUP" "$rendered" "$SUDOERS"
rm -f "$rendered"; trap - EXIT

step "DONE"
log "Console setting: brainLauncher = $DST   (or export ATLAS_BRAIN_LAUNCHER=$DST)"
log "verify: sudo -n -u $AGENT_USER true   # should succeed with no prompt"

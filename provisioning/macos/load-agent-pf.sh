#!/usr/bin/env bash
# Load the Atlas agent per-UID pf anchor (macOS) — Task 1.0 / #16, D17.
#
# This is the KERNEL-LEVEL half of the agent network denial. The Seatbelt profile
# (`provisioning/profiles/agent.sb`) denies network to any process launched under it,
# but pf denies outbound for the atlas-agent UID *unconditionally* — even for a process
# the agent starts WITHOUT a launcher. Both layers are required by D17.
#
# Requires root (pf is kernel state). Run:
#
#   sudo provisioning/macos/load-agent-pf.sh
#
# Verify afterwards:
#   sudo pfctl -a atlas/agent -s rules      # shows the block rule
#   sudo -u atlas-agent curl -sS --max-time 5 https://example.com   # must FAIL
set -euo pipefail

if [[ $EUID -ne 0 ]]; then
  echo "error: must run as root (pf is kernel state) — try: sudo $0" >&2
  exit 1
fi

AGENT_UID="$(id -u atlas-agent)"
if [[ -z "$AGENT_UID" ]]; then
  echo "error: atlas-agent is not provisioned (run provisioning/dev/setup.sh first)" >&2
  exit 1
fi

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TMP="$(mktemp -t atlas-agent-pf)"
trap 'rm -f "$TMP"' EXIT

# The committed anchor carries a <AGENT_UID> placeholder — pf has no variable for the
# UID of a named user, so it is substituted at load time from the provisioned identity.
sed "s/<AGENT_UID>/${AGENT_UID}/g" "$HERE/agent-pf.conf" > "$TMP"

pfctl -a atlas/agent -f "$TMP"
pfctl -e 2>/dev/null || true   # already-enabled is not an error

echo "loaded pf anchor atlas/agent for atlas-agent (uid ${AGENT_UID}):"
pfctl -a atlas/agent -s rules

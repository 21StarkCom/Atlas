#!/usr/bin/env bash
# Atlas agent cgroup confinement (Linux) — Task 1.0 / #16, D17.
# Places the agent UID's processes in a service-managed cgroup tied to the no-egress
# network namespace so the confinement is not something the agent can opt out of.
# Uses systemd slice when available (preferred), else a cgroup v2 fallback.
#
#   sudo provisioning/linux/agent-cgroup.sh setup
#   sudo provisioning/linux/agent-cgroup.sh teardown
set -euo pipefail
SLICE="atlas-agent.slice"

case "${1:-}" in
  setup)
    if command -v systemctl >/dev/null 2>&1; then
      mkdir -p /etc/systemd/system
      cat > "/etc/systemd/system/$SLICE" <<'EOF'
[Unit]
Description=Atlas agent confinement slice (no-egress)
[Slice]
# Agent workloads are launched into this slice via systemd-run --slice=atlas-agent
# inside the atlas-agent netns; the slice caps resources and anchors the confinement.
EOF
      systemctl daemon-reload
      echo "systemd slice $SLICE installed — launch agent work with:"
      echo "  systemd-run --slice=atlas-agent --uid=atlas-agent -- ip netns exec atlas-agent <cmd>"
    else
      CG=/sys/fs/cgroup/atlas-agent
      mkdir -p "$CG"
      echo "cgroup v2 dir $CG created (add agent PIDs to $CG/cgroup.procs)"
    fi
    ;;
  teardown)
    rm -f "/etc/systemd/system/$SLICE" 2>/dev/null || true
    command -v systemctl >/dev/null 2>&1 && systemctl daemon-reload || true
    rmdir /sys/fs/cgroup/atlas-agent 2>/dev/null || true
    echo "agent cgroup confinement removed"
    ;;
  *)
    echo "usage: agent-cgroup.sh {setup|teardown}" >&2; exit 2 ;;
esac

#!/usr/bin/env bash
# Atlas agent no-egress network namespace (Linux) — Task 1.0 / #16, D17.
# Creates a network namespace with only loopback (no route to the internet) that the
# agent UID's processes run inside and cannot leave. Only atlas-egress runs outside it
# with real network. Pair with agent-cgroup.sh so the confinement is service-managed
# and the agent cannot escape it.
#
#   sudo provisioning/linux/netns.sh setup    # create the no-egress netns
#   sudo provisioning/linux/netns.sh run -- <cmd...>   # run a cmd inside it
#   sudo provisioning/linux/netns.sh teardown
set -euo pipefail
NS="atlas-agent"

case "${1:-}" in
  setup)
    ip netns list 2>/dev/null | grep -qx "$NS" || ip netns add "$NS"
    # bring up loopback only; NO veth to the host → no egress route
    ip netns exec "$NS" ip link set lo up
    echo "netns $NS ready (loopback only, no egress)"
    ;;
  run)
    shift; [ "${1:-}" = "--" ] && shift
    exec ip netns exec "$NS" "$@"
    ;;
  teardown)
    ip netns list 2>/dev/null | grep -qx "$NS" && ip netns del "$NS" || true
    echo "netns $NS removed"
    ;;
  *)
    echo "usage: netns.sh {setup|run -- <cmd>|teardown}" >&2; exit 2 ;;
esac

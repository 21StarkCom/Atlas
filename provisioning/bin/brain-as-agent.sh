#!/usr/bin/env bash
# brain-as-agent.sh — the Atlas Console's brain privilege-drop launcher (#298).
#
# The Console runs as the OPERATOR, but `brain` needs `atlas-git` (broker socket +
# egress capability key) which the operator is normatively NOT in. This wrapper
# re-execs `brain` as `atlas-agent`, so an operator-launched Console can drive the
# privileged flow without adding the operator to `atlas-git` (D17/D18 preserved).
# The SIGNER is unaffected — it runs as the operator (its SE key lives in the
# operator's home, Touch-ID gated).
#
# Installed root-owned into the fixed install dir (D16). The Console points its
# `brainLauncher` setting / ATLAS_BRAIN_LAUNCHER at this path; the Console passes
# ATLAS_ROOT (and, for minting commands, ATLAS_EGRESS_CAPABILITY_KEY) in the child
# env, and this wrapper forwards exactly those into the atlas-agent invocation.
#
# REQUIRES a NOPASSWD sudoers rule letting the operator run brain as atlas-agent
# (installed by `provisioning/install-console-launcher.sh`); without it, `sudo -n`
# fails closed and the Console reports a blocking resolution error naming this path.
set -euo pipefail

: "${ATLAS_ROOT:?ATLAS_ROOT must be set — the Console passes it; the contract bundle + bin.js live under it}"
BIN_JS="$ATLAS_ROOT/apps/cli/dist/bin.js"
[ -f "$BIN_JS" ] || { echo "brain-as-agent: no $BIN_JS (run 'pnpm -r build' in the checkout)" >&2; exit 2; }

AGENT_USER="${ATLAS_AGENT_USER:-atlas-agent}"
AGENT_HOME="${ATLAS_AGENT_HOME:-/Users/Shared/atlas-agent-home}"
NODE_BIN="${ATLAS_NODE_BIN:-$(command -v node || echo /opt/homebrew/bin/node)}"

# Forward only what brain needs. ATLAS_EGRESS_CAPABILITY_KEY is passed through ONLY
# when the caller set it (the Console injects it transiently for the two minting
# commands) — never defaulted here, so a non-minting spawn carries no capability path.
declare -a passthru=(
  "HOME=$AGENT_HOME"
  "ATLAS_ROOT=$ATLAS_ROOT"
  "PATH=/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin"
)
if [ -n "${ATLAS_EGRESS_CAPABILITY_KEY:-}" ]; then
  passthru+=("ATLAS_EGRESS_CAPABILITY_KEY=$ATLAS_EGRESS_CAPABILITY_KEY")
fi

# -n: never prompt. A missing NOPASSWD rule fails here (fail-closed), never hangs.
exec sudo -n -u "$AGENT_USER" env "${passthru[@]}" "$NODE_BIN" "$BIN_JS" "$@"

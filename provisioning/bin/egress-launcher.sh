#!/usr/bin/env bash
# Fixed-path, root-owned launcher for the egress broker daemon (Task 1.0 / #16, D16).
# Exec's the hash-verified installed binary as atlas-egress — the sole outbound-network
# process and sole provider-credential holder (D18: no vault access).
#
# Invoked as:  sudo -u atlas-egress /usr/local/lib/atlas/bin/egress-launcher.sh
set -euo pipefail
OS="$(uname -s)"
if [ "$OS" = "Darwin" ]; then BIN=/usr/local/lib/atlas/bin/atlas-egress; SOCK=/usr/local/var/run/atlas/egress.sock; KEYS=/usr/local/etc/atlas/keys/atlas-egress;
else BIN=/opt/atlas/bin/atlas-egress; SOCK=/var/run/atlas/egress.sock; KEYS=/etc/atlas/keys/atlas-egress; fi
export ATLAS_EGRESS_SOCKET="$SOCK"
export ATLAS_EGRESS_KEYS_DIR="$KEYS"
export ATLAS_GEMINI_KEY_FILE="$KEYS/atlas.gemini.key"
exec "$BIN" "$@"

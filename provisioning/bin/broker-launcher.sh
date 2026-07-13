#!/usr/bin/env bash
# Fixed-path, root-owned launcher for the broker daemon (Task 1.0 / #16, D16).
# Installed to the root-owned, non-agent-writable install dir. Exec's the
# hash-verified installed binary as atlas-broker — a compromised agent cannot swap
# what runs here (fixed exec path + args; the binary is NOT the repo dist/).
#
# Invoked as:  sudo -u atlas-broker /usr/local/lib/atlas/bin/broker-launcher.sh
set -euo pipefail
OS="$(uname -s)"
if [ "$OS" = "Darwin" ]; then BIN=/usr/local/lib/atlas/bin/atlas-broker; SOCK=/usr/local/var/run/atlas/broker.sock; KEYS=/usr/local/etc/atlas/keys/atlas-broker;
else BIN=/opt/atlas/bin/atlas-broker; SOCK=/var/run/atlas/broker.sock; KEYS=/etc/atlas/keys/atlas-broker; fi
export ATLAS_BROKER_SOCKET="$SOCK"
export ATLAS_BROKER_KEYS_DIR="$KEYS"
# ATLAS_TEST_MODE is intentionally NOT set here (D20): the production launcher never
# enables the test signer. Test runs set it explicitly in the CI fixture environment.
exec "$BIN" "$@"

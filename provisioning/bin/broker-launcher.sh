#!/usr/bin/env bash
# Fixed-path, root-owned launcher for the broker daemon (Task 1.0 / #16, D16).
# Installed to the root-owned, non-agent-writable install dir. Exec's the
# hash-verified installed binary as atlas-broker — a compromised agent cannot swap
# what runs here (fixed exec path + args; the binary is NOT the repo dist/).
#
# Invoked as:  sudo -u atlas-broker /usr/local/lib/atlas/bin/broker-launcher.sh
set -euo pipefail
OS="$(uname -s)"
if [ "$OS" = "Darwin" ]; then BIN=/usr/local/lib/atlas/bin/atlas-broker; SOCK=/usr/local/var/run/atlas/broker.sock; KEYS=/usr/local/etc/atlas/keys/atlas-broker; ANCHOR=/usr/local/var/atlas/audit-anchor;
else BIN=/opt/atlas/bin/atlas-broker; SOCK=/var/run/atlas/broker.sock; KEYS=/etc/atlas/keys/atlas-broker; ANCHOR=/var/lib/atlas/audit-anchor; fi
export ATLAS_BROKER_SOCKET="$SOCK"
export ATLAS_BROKER_KEYS_DIR="$KEYS"
# WORM anchor path (D8) — the broker also defaults to this per-OS if unset.
export ATLAS_AUDIT_ANCHOR_PATH="${ATLAS_AUDIT_ANCHOR_PATH:-$ANCHOR}"
# The vault git repo the broker mutates (deployment-specific; overridable). The
# broker is the sole protected-ref writer over this repo.
export ATLAS_VAULT_REPO_DIR="${ATLAS_VAULT_REPO_DIR:-/var/lib/atlas/vault}"
# The canonical protected ref (60-A live-vault adoption). Pass through the deployment
# override so an adopted vault's broker mutates `refs/atlas/main`, not `refs/heads/main`.
# Unset ⇒ the broker's own default (`refs/heads/main`) for a plain (non-adopted) vault.
[ -n "${ATLAS_CANONICAL_REF:-}" ] && export ATLAS_CANONICAL_REF
# ATLAS_TEST_MODE is intentionally NOT set here (D20): the production launcher never
# enables the test signer. Test runs set it explicitly in the CI fixture environment.
exec "$BIN" "$@"

#!/usr/bin/env bash
# Fixed-path, root-owned launcher for the egress broker daemon (Task 1.0 / #16, D16).
# Exec's the hash-verified installed binary as atlas-egress — the sole outbound-network
# process and sole provider-credential holder (D18: no vault access).
#
# Invoked as:  sudo -u atlas-egress /usr/local/lib/atlas/bin/egress-launcher.sh
#
# CROSS-IDENTITY ARTIFACTS (Task 2.8 / #34). The daemon `requireEnv`s these; without them it
# exits 4 at startup (the launcher previously exported none of them, so the daemon could not
# start in production at all). They cannot live in the egress-only 0700 keys dir, because the
# CLI identity must also reach them — it MINTS capabilities and DRAINS the quarantine spool.
# They follow the ownership pattern the egress socket already uses: owner atlas-egress, group
# atlas-git, group-accessible mode — egress reaches them as OWNER, the CLI as GROUP member.
# atlas-egress itself stays OUT of atlas-git, so D18 (no vault/object read) is preserved.
set -euo pipefail
OS="$(uname -s)"
if [ "$OS" = "Darwin" ]; then
  BIN=/usr/local/lib/atlas/bin/atlas-egress
  SOCK=/usr/local/var/run/atlas/egress.sock
  KEYS=/usr/local/etc/atlas/keys/atlas-egress
  SHARED=/usr/local/etc/atlas/keys/shared
  STATE=/usr/local/var/atlas/egress
else
  BIN=/opt/atlas/bin/atlas-egress
  SOCK=/var/run/atlas/egress.sock
  KEYS=/etc/atlas/keys/atlas-egress
  SHARED=/etc/atlas/keys/shared
  STATE=/var/lib/atlas/egress
fi
export ATLAS_EGRESS_SOCKET="$SOCK"
export ATLAS_EGRESS_KEYS_DIR="$KEYS"
export ATLAS_GEMINI_KEY_FILE="$KEYS/atlas.gemini.key"

# Capability MAC secret — CLI mints (group-read), egress verifies (owner-read). 0640.
export ATLAS_EGRESS_CAPABILITY_KEY="$SHARED/egress-capability.key"
# The CLI's PUBLIC key; egress seals quarantined payloads to it (public ⇒ 0644).
export ATLAS_EGRESS_QUARANTINE_PUBKEY="$SHARED/quarantine-recipient.pub"
# Sealed-quarantine spool — egress WRITES (owner), the CLI DRAINS (group). 2770 setgid.
export ATLAS_EGRESS_QUARANTINE_SPOOL="$STATE/quarantine-spool"
# Per-run budget state (D19), survives restart. Egress-owned AND egress-writable — the old
# default sat under the root-owned keys parent, where the daemon could not write it.
export ATLAS_EGRESS_BUDGET_STATE="$STATE/budget-state.json"

exec "$BIN" "$@"

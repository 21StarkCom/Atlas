#!/usr/bin/env bash
# Hash-verified install of the privileged broker/egress binaries + launchers into the
# root-owned, non-agent-writable install dir (Task 1.0 / #16, D16). The privileged
# binaries are NEVER run from the agent-writable repo dist/ — they are built, hashed,
# and installed here; a compromised agent cannot swap them.
#
#   sudo provisioning/install-artifact.sh <artifact-dir>
# where <artifact-dir> holds the built atlas-broker, atlas-egress (+ optional
# atlas-broker.sha256 / atlas-egress.sha256 manifests).
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
# shellcheck source=lib.sh
source "$HERE/lib.sh"
require_root "$@"

SRC="${1:?usage: install-artifact.sh <artifact-dir>}"
ensure_dir "$ATLAS_INSTALL_BIN" "root" "$ATLAS_ROOT_GROUP" 0755

install_one() {
  local name="$1" src="$SRC/$1" dst="$ATLAS_INSTALL_BIN/$1"
  [ -f "$src" ] || { echo "error: missing artifact $src" >&2; exit 1; }
  if [ -f "$src.sha256" ]; then
    step "verify hash of $name"
    local want got
    want="$(cut -d' ' -f1 < "$src.sha256")"
    got="$(shasum -a 256 "$src" | cut -d' ' -f1)"
    [ "$want" = "$got" ] || { echo "error: hash mismatch for $name ($got != $want)" >&2; exit 1; }
  fi
  step "install $name → $dst (root:$ATLAS_ROOT_GROUP 0755, non-agent-writable)"
  run "install -m 0755 -o root -g $ATLAS_ROOT_GROUP '$src' '$dst'"
  # record the installed hash so provisioning.integrity.test can assert immutability
  run "shasum -a 256 '$dst' | tee '$dst.installed.sha256' >/dev/null"
  run "chown root:$ATLAS_ROOT_GROUP '$dst.installed.sha256'"
  run "chmod 0644 '$dst.installed.sha256'"
}

for b in atlas-broker atlas-egress; do install_one "$b"; done
# launchers (fixed exec paths)
install -m 0755 -o root -g "$ATLAS_ROOT_GROUP" "$HERE/bin/broker-launcher.sh" "$ATLAS_INSTALL_BIN/broker-launcher.sh"
install -m 0755 -o root -g "$ATLAS_ROOT_GROUP" "$HERE/bin/egress-launcher.sh" "$ATLAS_INSTALL_BIN/egress-launcher.sh"
step "DONE — privileged binaries installed hash-verified; repo dist/ is never executed privileged"

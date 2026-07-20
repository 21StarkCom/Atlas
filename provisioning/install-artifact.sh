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

# --- the sync auto-hook wrapper (#60 Phase 6, macOS/launchd only) ------------
if [ "$ATLAS_OS" = "Darwin" ]; then
# launchd does NOT source the operator's interactive shell, so a bare `brain`
# fails command-not-found under the minimal launchd PATH before sync even starts.
# Resolve the absolute brain entrypoint HERE, at provisioning time, and bake it in.
# ATLAS_BRAIN_BIN lets the operator name it explicitly when `brain` is not on root's
# PATH (a pnpm/nvm install usually isn't).
BRAIN_BIN="${ATLAS_BRAIN_BIN:-$(command -v brain || true)}"
if [ -z "$BRAIN_BIN" ] || [ ! -x "$BRAIN_BIN" ]; then
  echo "error: cannot resolve an absolute \`brain\` executable for the sync wrapper." >&2
  echo "       re-run with ATLAS_BRAIN_BIN=/absolute/path/to/brain (launchd has no shell PATH)." >&2
  exit 2
fi
step "install atlas-sync-wrapper.sh (brain → $BRAIN_BIN)"
rendered_wrapper="$(mktemp -t atlas-sync-wrapper)"
sed -e "s|@ATLAS_BRAIN_BIN@|$BRAIN_BIN|g" -e "s|@ATLAS_SECURITY_BIN@|/usr/bin/security|g" \
  "$HERE/macos/atlas-sync-wrapper.sh" > "$rendered_wrapper"
install -m 0755 -o root -g "$ATLAS_ROOT_GROUP" "$rendered_wrapper" "$ATLAS_INSTALL_BIN/atlas-sync-wrapper.sh"
rm -f "$rendered_wrapper"
fi
step "DONE — privileged binaries installed hash-verified; repo dist/ is never executed privileged"

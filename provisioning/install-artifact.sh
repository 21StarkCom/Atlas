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
#
# OPTIONAL. The wrapper is only useful on a host that has adopted a vault for
# continuous sync (docs/install.md §5.4 → §5.6), and it needs two deployment facts
# launchd cannot supply: an absolute `brain` and the config directory. When either
# is missing this SKIPS with a warning rather than failing the whole privileged
# install — every other host (including a plain graduated vault, and CI) installs
# the daemons exactly as before. `services.sh sync-gate` is what reports the skip.
if [ "$ATLAS_OS" = "Darwin" ]; then
# launchd does NOT source the operator's interactive shell, so a bare `brain` fails
# command-not-found under the minimal launchd PATH before sync even starts. Atlas
# also ships no installed binary (the repo docs use a shell alias), so in practice
# ATLAS_BRAIN_BIN is how this gets named.
BRAIN_BIN="${ATLAS_BRAIN_BIN:-$(command -v brain || true)}"
CONFIG_DIR="${ATLAS_CONFIG_DIR:-}"
KEYCHAIN_FILE="${ATLAS_SYNC_KEYCHAIN:-/Library/Keychains/System.keychain}"
skip_wrapper=""
if [ -z "$BRAIN_BIN" ] || [ ! -x "$BRAIN_BIN" ]; then
  skip_wrapper="no executable \`brain\` — set ATLAS_BRAIN_BIN=/absolute/path/to/brain"
# Identity probe: `brain` is a generic name on \$PATH. Bake in only a real Atlas CLI,
# never whatever else answered to that name under root's PATH.
elif ! "$BRAIN_BIN" --help 2>&1 | grep -q "Atlas CLI"; then
  skip_wrapper="\`$BRAIN_BIN\` does not identify as the Atlas CLI (\`--help\` lacks the 'Atlas CLI' banner)"
elif [ -z "$CONFIG_DIR" ] || [ ! -f "$CONFIG_DIR/brain.config.yaml" ]; then
  skip_wrapper="no brain.config.yaml — set ATLAS_CONFIG_DIR to the dir holding it (launchd runs with cwd /)"
fi
if [ -n "$skip_wrapper" ]; then
  log "SKIP atlas-sync-wrapper.sh: $skip_wrapper"
  log "     (continuous sync stays unavailable; the daemons are unaffected)"
else
  step "install atlas-sync-wrapper.sh (brain → $BRAIN_BIN, config → $CONFIG_DIR, keychain → $KEYCHAIN_FILE)"
  rendered_wrapper="$(mktemp -t atlas-sync-wrapper)"
  # `|` is the sed delimiter, so a path containing one would corrupt the render.
  for v in "$BRAIN_BIN" "$CONFIG_DIR" "$KEYCHAIN_FILE"; do
    case "$v" in *'|'* | *'&'* | *'\'*) echo "error: unsupported character in path '$v'" >&2; exit 2 ;; esac
  done
  sed -e "s|@ATLAS_BRAIN_BIN@|$BRAIN_BIN|g" \
      -e "s|@ATLAS_CONFIG_DIR@|$CONFIG_DIR|g" \
      -e "s|@ATLAS_KEYCHAIN@|$KEYCHAIN_FILE|g" \
      -e "s|@ATLAS_SECURITY_BIN@|/usr/bin/security|g" \
      "$HERE/macos/atlas-sync-wrapper.sh" > "$rendered_wrapper"
  install -m 0755 -o root -g "$ATLAS_ROOT_GROUP" "$rendered_wrapper" "$ATLAS_INSTALL_BIN/atlas-sync-wrapper.sh"
  rm -f "$rendered_wrapper"
fi
fi
step "DONE — privileged binaries installed hash-verified; repo dist/ is never executed privileged"

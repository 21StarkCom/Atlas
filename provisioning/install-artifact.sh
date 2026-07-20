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
BRAIN_SHIM="$ATLAS_INSTALL_BIN/brain-shim.sh"
skip_wrapper=""
# `atlas` ships no installed binary: `apps/cli/dist/bin.js` is plain `tsc` output, mode
# 0644, and the repo docs use a shell alias. So the entrypoint is accepted either as an
# executable OR as a readable `.js` (invoked through `node`) — requiring the exec bit
# would make the documented runbook silently skip the wrapper every time.
brain_invoke=""
if [ -z "$BRAIN_BIN" ]; then
  skip_wrapper="no \`brain\` — set ATLAS_BRAIN_BIN=/absolute/path/to/brain (or dist/bin.js)"
elif [ -x "$BRAIN_BIN" ]; then
  brain_invoke="$BRAIN_BIN"
elif [ -r "$BRAIN_BIN" ] && case "$BRAIN_BIN" in *.js | *.mjs | *.cjs) true ;; *) false ;; esac; then
  brain_invoke="/usr/bin/env node $BRAIN_BIN"
else
  skip_wrapper="\`$BRAIN_BIN\` is neither executable nor a readable JS entrypoint"
fi
# Identity probe: `brain` is a generic name on $PATH. Bake in only a real Atlas CLI,
# never whatever else answered to that name under root's PATH.
if [ -z "$skip_wrapper" ] && ! $brain_invoke --help 2>&1 | grep -q "Atlas CLI"; then
  skip_wrapper="\`$BRAIN_BIN\` does not identify as the Atlas CLI (\`--help\` lacks the 'Atlas CLI' banner)"
fi
if [ -z "$skip_wrapper" ] && { [ -z "$CONFIG_DIR" ] || [ ! -f "$CONFIG_DIR/brain.config.yaml" ]; }; then
  skip_wrapper="no brain.config.yaml — set ATLAS_CONFIG_DIR to the dir holding it (launchd runs with cwd /)"
fi
if [ -n "$skip_wrapper" ]; then
  log "SKIP atlas-sync-wrapper.sh: $skip_wrapper"
  log "     (continuous sync stays unavailable; the daemons are unaffected)"
  # A wrapper left over from an earlier install would keep running with STALE
  # substitutions — remove it so `sync_gate` reports "missing" rather than green.
  rm -f "$ATLAS_INSTALL_BIN/atlas-sync-wrapper.sh" "$BRAIN_SHIM"
else
  step "install atlas-sync-wrapper.sh (brain → $brain_invoke, config → $CONFIG_DIR, keychain → $KEYCHAIN_FILE)"
  # `|` is the sed delimiter, so a path containing one would corrupt the render.
  for v in "$BRAIN_BIN" "$CONFIG_DIR" "$KEYCHAIN_FILE"; do
    case "$v" in *'|'* | *'&'* | *'\'*) echo "error: unsupported character in path '$v'" >&2; exit 2 ;; esac
  done
  # The wrapper's contract is ONE absolute executable (it `-x`-checks it, and the gate
  # re-checks it). When the entrypoint is a non-executable .js, that executable is a
  # root-owned shim in the same non-agent-writable install dir (D16) — never a `node …`
  # string spliced into the wrapper, which would break quoting and the `-x` invariant.
  if [ "$brain_invoke" = "$BRAIN_BIN" ]; then
    brain_target="$BRAIN_BIN"
  else
    printf '#!/bin/sh\nexec /usr/bin/env node %s "$@"\n' "$BRAIN_BIN" > "$BRAIN_SHIM.tmp"
    install -m 0755 -o root -g "$ATLAS_ROOT_GROUP" "$BRAIN_SHIM.tmp" "$BRAIN_SHIM"
    rm -f "$BRAIN_SHIM.tmp"
    brain_target="$BRAIN_SHIM"
    log "brain entrypoint is not executable — installed shim $BRAIN_SHIM → node $BRAIN_BIN"
  fi
  rendered_wrapper="$(mktemp -t atlas-sync-wrapper)"
  sed -e "s|@ATLAS_BRAIN_BIN@|$brain_target|g" \
      -e "s|@ATLAS_CONFIG_DIR@|$CONFIG_DIR|g" \
      -e "s|@ATLAS_KEYCHAIN@|$KEYCHAIN_FILE|g" \
      -e "s|@ATLAS_SECURITY_BIN@|/usr/bin/security|g" \
      "$HERE/macos/atlas-sync-wrapper.sh" > "$rendered_wrapper"
  install -m 0755 -o root -g "$ATLAS_ROOT_GROUP" "$rendered_wrapper" "$ATLAS_INSTALL_BIN/atlas-sync-wrapper.sh"
  rm -f "$rendered_wrapper"
fi
fi
step "DONE — privileged binaries installed hash-verified; repo dist/ is never executed privileged"

#!/usr/bin/env bash
# console/signer/install.sh — the operator-space half of the fresh-Mac signer
# story (SP-3 spec §7). Builds atlas-signer from source, links it into ~/bin,
# mints the Secure-Enclave key (Touch ID prompt proves the gate), exports its
# public key, and PRINTS the exact sudo enrollment line to run next.
#
# TWO commands total for the operator: this (unprivileged), then the printed
# `sudo provisioning/enroll-signer.sh …`. The enrollment MUST stay a separate,
# human-typed, sudo-gated step — it crosses from operator-space into broker
# custody; folding it in here would let anything running as the operator enroll
# a signer silently.
#
# No Xcode, no .app bundle, no entitlements — `swift build` under Command Line
# Tools + the linker's ad-hoc signature suffice (the blob-file custody avoids the
# data-protection keychain entirely).
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BIN_DIR="${ATLAS_SIGNER_BIN_DIR:-$HOME/bin}"
PEM_OUT="${1:-approver.pem}"

log() { printf '  %s\n' "$*" >&2; }
step() { printf '\n== %s\n' "$*" >&2; }

step "build atlas-signer (release)"
( cd "$HERE" && swift build -c release )
BUILT="$HERE/.build/release/atlas-signer"
[ -x "$BUILT" ] || { echo "error: build did not produce $BUILT" >&2; exit 1; }

step "link into $BIN_DIR"
mkdir -p "$BIN_DIR"
ln -sf "$BUILT" "$BIN_DIR/atlas-signer"
log "linked $BIN_DIR/atlas-signer -> $BUILT"
log "(ensure $BIN_DIR is on your PATH)"

step "mint the Secure-Enclave key (Touch ID prompt proves the gate)"
# keygen prints the SPKI PEM on stdout (also persisted in config.json) + the
# signerId/runbook on stderr. Discard stdout; capture stderr to read the signerId.
KEYGEN_ERR="$(mktemp)"
trap 'rm -f "$KEYGEN_ERR"' EXIT
"$BUILT" keygen >/dev/null 2>"$KEYGEN_ERR"
cat "$KEYGEN_ERR" >&2
SIGNER_ID="$(grep -m1 '^signerId: ' "$KEYGEN_ERR" | sed 's/^signerId: //')"

step "export the public key"
"$BUILT" pubkey --out "$PEM_OUT" --force
log "wrote $PEM_OUT"

step "NEXT (separate, sudo-gated, human-typed step):"
if [ -n "${SIGNER_ID:-}" ]; then
  printf '  sudo provisioning/enroll-signer.sh --pubkey %s --signer-id %s --alg p256 --presence\n' "$PEM_OUT" "$SIGNER_ID" >&2
else
  printf '  sudo provisioning/enroll-signer.sh --pubkey %s --signer-id <the signerId printed above> --alg p256 --presence\n' "$PEM_OUT" >&2
fi
log "that step restarts the broker so it loads the new signer (§7)."

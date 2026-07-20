#!/usr/bin/env bash
# provisioning/enroll-signer.sh — per-device signer enrollment / revocation (SP-3
# §7). Installs an exported public key as a `signers.json` registry entry in the
# broker's key custody, or revokes one by flipping `status`. `sudo`-gated because
# it writes broker-owned key material — the ONE human-led step that crosses from
# operator-space into broker custody (consistent with the provisioning charter).
#
#   sudo provisioning/enroll-signer.sh --pubkey approver.pem --signer-id approver-se-<host>-v1 --alg p256 --presence
#   sudo provisioning/enroll-signer.sh --revoke --signer-id approver-se-<host>-v1
#
# The JSON merge (materialize-if-derived, DER-SPKI-fingerprint identity, aliasing
# refusal, idempotency) lives in enroll-signer-merge.mjs — it imports @atlas/broker
# so the enrolled file is exactly what `loadSignerRegistry` reads. This wrapper
# owns arg-parse + validation + root gate + ownership/mode + the broker restart.
#
# Test/dev escapes (never set by production callers):
#   ATLAS_DRY_RUN=1            preview only, mutate nothing
#   ATLAS_ENROLL_TEST_MODE=1   skip the root gate + chown + broker restart (the
#                              behavioral test runs non-root against a temp keysDir)
#   ATLAS_ENROLL_SKIP_RESTART=1  enroll but leave the restart to the operator
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=/dev/null
. "$HERE/lib.sh"

TEST_MODE="${ATLAS_ENROLL_TEST_MODE:-0}"
MERGE="$HERE/enroll-signer-merge.mjs"

ACTION="enroll"
PUBKEY=""
SIGNER_ID=""
ALG=""
PRESENCE=0
KEYS_DIR_OVERRIDE=""

usage() {
  cat >&2 <<'USAGE'
usage:
  enroll-signer.sh --pubkey <pem> --signer-id <id> --alg <ed25519|p256> [--presence] [--keys-dir <dir>]
  enroll-signer.sh --revoke --signer-id <id> [--keys-dir <dir>]
USAGE
  exit 5
}

while [ $# -gt 0 ]; do
  case "$1" in
    --revoke) ACTION="revoke" ;;
    --pubkey) PUBKEY="${2:-}"; shift ;;
    --signer-id) SIGNER_ID="${2:-}"; shift ;;
    --alg) ALG="${2:-}"; shift ;;
    --presence) PRESENCE=1 ;;
    --keys-dir) KEYS_DIR_OVERRIDE="${2:-}"; shift ;;
    -h|--help) usage ;;
    *) echo "error: unknown arg \"$1\"" >&2; usage ;;
  esac
  shift
done

# --- validation (fail-closed, exit 5 on usage errors) ---
[ -n "$SIGNER_ID" ] || { echo "error: --signer-id is required" >&2; usage; }
if [ "$ACTION" = "enroll" ]; then
  [ -n "$PUBKEY" ] || { echo "error: --pubkey is required for enrollment" >&2; usage; }
  [ -n "$ALG" ] || { echo "error: --alg is required for enrollment" >&2; usage; }
  case "$ALG" in ed25519|p256) ;; *) echo "error: --alg must be ed25519 or p256" >&2; usage ;; esac
  if [ "$PRESENCE" = 1 ] && [ "$ALG" != "p256" ]; then
    echo "error: --presence requires --alg p256 (a file key proves custody, not presence)" >&2
    exit 5
  fi
  [ -f "$PUBKEY" ] || { echo "error: pubkey file not found: $PUBKEY" >&2; exit 2; }
fi

# --- root gate (production only) ---
[ "$TEST_MODE" = 1 ] || require_root "$@"

KEYS_DIR="${KEYS_DIR_OVERRIDE:-$ATLAS_KEYS_DIR/atlas-broker}"
SIGNERS="$KEYS_DIR/signers.json"
[ -d "$KEYS_DIR" ] || { echo "error: broker keys dir not found: $KEYS_DIR" >&2; exit 2; }

# --- dry-run: preview, mutate nothing ---
if [ "$DRY_RUN" = "1" ]; then
  if [ "$ACTION" = "enroll" ]; then
    log "[dry-run] would enroll signerId=$SIGNER_ID alg=$ALG presence=$PRESENCE into $SIGNERS"
  else
    log "[dry-run] would revoke signerId=$SIGNER_ID in $SIGNERS"
  fi
  exit 0
fi

# --- run the merge ---
step "$ACTION signer $SIGNER_ID"
if [ "$ACTION" = "enroll" ]; then
  args=("$KEYS_DIR" enroll --signer-id "$SIGNER_ID" --alg "$ALG" --pubkey "$PUBKEY")
  [ "$PRESENCE" = 1 ] && args+=(--presence)
  node "$MERGE" "${args[@]}"
else
  node "$MERGE" "$KEYS_DIR" revoke --signer-id "$SIGNER_ID"
fi

# --- ownership + mode (broker-owned 0600) ---
if [ "$TEST_MODE" != 1 ]; then
  chown atlas-broker:atlas-broker "$SIGNERS"
fi
chmod 0600 "$SIGNERS"

# --- restart the broker so it loads the registry (enrollment is NOT live-reloaded) ---
if [ "$TEST_MODE" = 1 ] || [ "${ATLAS_ENROLL_SKIP_RESTART:-0}" = 1 ]; then
  log "skipping broker restart (test/skip mode) — the entry stays inert until the broker reloads"
else
  step "restart the broker daemon (loads the new registry)"
  if [ "$ATLAS_OS" = "Darwin" ]; then
    if ! launchctl kickstart -k system/com.atlas.broker; then
      echo "error: could not restart com.atlas.broker — the enrolled entry stays INERT until the broker reloads. Restart it manually and re-verify." >&2
      exit 2
    fi
  else
    echo "error: no systemd unit for the broker on Linux yet — restart the broker manually so it reloads $SIGNERS" >&2
    exit 2
  fi
fi

step "enrolled signer registry summary"
node -e '
const fs=require("fs");
const p=process.argv[1];
const e=JSON.parse(fs.readFileSync(p,"utf8"));
for(const s of e){console.error(`  ${s.signerId}  alg=${s.alg??"ed25519"}  presence=${!!s.presence}  status=${s.status}  ops=${(s.permittedOps||[]).length}`);}
' "$SIGNERS"

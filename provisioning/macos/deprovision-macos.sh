#!/usr/bin/env bash
# provisioning/macos/deprovision-macos.sh — Atlas v2 host deprovision (Phase-5 task 5-2, #344).
#
# Deletes EVERY retired v1 host resource enumerated in provisioning/deprovision-allowlist.txt
# (the machine-readable SSOT) idempotently, and PRESERVES atlas-gemini-api-key (the credential
# the v2 `brain` reads directly). Irreversible — its only undo is re-provisioning from the
# `v1-fortress` tag (accepted, plan §Risks).
#
# Modes (exactly one required):
#   --plan      Parse the allowlist and print the ordered action plan (category|action|id|method|extra),
#               one line per resource. NO sudo, NO mutation — CI-safe. This is what
#               tools/deprovision-allowlist.test.ts drives to prove the script agrees with the SSOT.
#   --confirm   Execute the deletions. Requires: sudo (EUID 0), a non-root $SUDO_USER, and a NON-CI
#               host. Every deletion is idempotent (presence-check first; a confirmed not-found is
#               success; a permission/unexpected error stays FATAL), so a partial/interrupted run
#               reruns cleanly to completion. Ends with a postcondition pass over every resource.
#
# NEVER run under --confirm in CI (it mutates real host state). The allowlist gate
# (tools/deprovision-allowlist.test.ts) + a one-time manual pass recorded in the Phase-5 retro
# are this script's verification (plan task 5-2 / task 5-4).
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ALLOWLIST="$SCRIPT_DIR/../deprovision-allowlist.txt"
SYSTEM_KEYCHAIN="/Library/Keychains/System.keychain"

die() { echo "deprovision: $*" >&2; exit 1; }
info() { echo "deprovision: $*"; }

[[ -f "$ALLOWLIST" ]] || die "allowlist not found: $ALLOWLIST"

MODE=""
for arg in "$@"; do
  case "$arg" in
    --plan) MODE="plan" ;;
    --confirm) MODE="confirm" ;;
    *) echo "usage: $0 (--plan | --confirm)" >&2; exit 2 ;;
  esac
done
[[ -n "$MODE" ]] || { echo "usage: $0 (--plan | --confirm)" >&2; exit 2; }

# Read the allowlist into parallel arrays (skip blank + #-comment lines).
CATS=(); ACTS=(); IDS=(); METHODS=(); EXTRAS=()
while IFS='|' read -r category action id method extra || [[ -n "$category" ]]; do
  [[ -z "$category" || "$category" == \#* ]] && continue
  # Fail closed on a malformed record: an empty id/method would let a home-relative `rm -rf`
  # collapse to a catastrophic target (e.g. `rm -rf "$OP_HOME/"`). Never trust a blank field.
  [[ -n "$id" ]] || die "allowlist record has an empty id: '$category|$action|$id|$method|$extra'"
  [[ -n "$method" ]] || die "allowlist record has an empty method: '$category|$action|$id|$method|$extra'"
  CATS+=("$category"); ACTS+=("$action"); IDS+=("$id"); METHODS+=("$method"); EXTRAS+=("${extra:-}")
done < "$ALLOWLIST"
N=${#CATS[@]}
[[ "$N" -gt 0 ]] || die "allowlist parsed to zero resources"

# --- --plan: echo the parsed plan, no privilege, no mutation --------------------------------
if [[ "$MODE" == "plan" ]]; then
  for ((i = 0; i < N; i++)); do
    echo "${CATS[$i]}|${ACTS[$i]}|${IDS[$i]}|${METHODS[$i]}|${EXTRAS[$i]}"
  done
  exit 0
fi

# --- --confirm: preflight -------------------------------------------------------------------
[[ -z "${CI:-}" ]] || die "refusing to run under --confirm in CI (mutates real host state)"
[[ "${EUID:-$(id -u)}" -eq 0 ]] || die "must run under sudo (EUID 0)"
OP_USER="${SUDO_USER:-}"
[[ -n "$OP_USER" && "$OP_USER" != "root" ]] || die "requires a non-root \$SUDO_USER (run via sudo as the operator, not as root)"
# Resolve the invoking operator's home via the directory service (~ is root's home under sudo).
OP_HOME="$(dscl . -read "/Users/$OP_USER" NFSHomeDirectory 2>/dev/null | sed -n 's/^NFSHomeDirectory: //p')"
[[ -n "$OP_HOME" ]] || die "could not resolve NFSHomeDirectory for \$SUDO_USER=$OP_USER"
info "operator=$OP_USER home=$OP_HOME"

# --- idempotent per-resource helpers (present→act; not-found=success; unexpected=FATAL) -----
del_launchd() { # $1 label  $2 plist
  if launchctl print "system/$1" >/dev/null 2>&1; then
    info "bootout system/$1"; launchctl bootout "system/$1" || die "bootout system/$1 failed"
  else
    info "launchd $1 already booted-out"
  fi
  rm -f "$2"
}
del_user() { # $1 username
  # Use `dscl . -delete` (v1 teardown's approach): it removes ONLY the directory-service
  # record and NEVER touches the home directory — so the SHARED, root-owned /var/empty that
  # every service account uses (lib.sh:93, sshd's privilege-separation dir) is untouched, with
  # nothing per-account to reclaim. `sysadminctl -deleteUser` deletes the home by default, and
  # its `-keepHome` guard is NOT available on every macOS version (fails "not available on this
  # system") — so dscl is both safer and portable.
  if dscl . -read "/Users/$1" >/dev/null 2>&1; then
    info "delete user $1 (dscl -delete — home untouched)"; dscl . -delete "/Users/$1" || die "dscl -delete /Users/$1 failed"
  else
    info "user $1 already absent"
  fi
}
del_group() { # $1 group
  if dscl . -read "/Groups/$1" >/dev/null 2>&1; then
    info "delete group $1"; dscl . -delete "/Groups/$1" || die "dscl -delete /Groups/$1 failed"
  else
    info "group $1 already absent"
  fi
}
del_rm_f() { info "rm -f $1"; rm -f "$1"; } # $1 path (rm -f is intrinsically idempotent)
del_rm_rf() { info "rm -rf $1"; rm -rf "$1"; } # $1 path
del_rmdir() { # $1 path — rmdir NOT rm -rf: any unexpected content halts for inspection
  if [[ -d "$1" ]]; then
    info "rmdir $1"; rmdir "$1" || die "rmdir $1 failed (unexpected content? inspect it — NOT swept)"
  else
    info "parent $1 already absent"
  fi
}
del_signer_store() { # $1 rel-path under the operator home; removed AS the operator
  [[ -n "$1" ]] || die "signer-store id empty — refusing rm -rf of the operator home root"
  local target="$OP_HOME/$1"
  info "rm -rf (as $OP_USER) $target"
  sudo -u "$OP_USER" rm -rf "$target" || die "signer-store removal for $OP_USER failed"
}
del_keychain() { # $1 service  $2 account(optional)
  local -a sel=(-s "$1"); [[ -n "${2:-}" ]] && sel+=(-a "$2")
  if security find-generic-password "${sel[@]}" "$SYSTEM_KEYCHAIN" >/dev/null 2>&1; then
    info "delete keychain item $1"; security delete-generic-password "${sel[@]}" "$SYSTEM_KEYCHAIN" >/dev/null || die "keychain delete $1 failed"
  else
    info "keychain item $1 already absent"
  fi
}

# --- execute the plan -----------------------------------------------------------------------
for ((i = 0; i < N; i++)); do
  cat="${CATS[$i]}"; act="${ACTS[$i]}"; id="${IDS[$i]}"; method="${METHODS[$i]}"; extra="${EXTRAS[$i]}"
  if [[ "$act" == "preserve" ]]; then info "PRESERVE $cat $id (never deleted)"; continue; fi
  case "$method" in
    bootout-rm) del_launchd "$id" "$extra" ;;
    deleteUser) del_user "$id" ;;
    dscl-delete) del_group "$id" ;;
    rm-f) del_rm_f "$id" ;;
    rm-rf) del_rm_rf "$id" ;;
    rmdir) del_rmdir "$id" ;;
    sudo-user-rm-rf) del_signer_store "$id" ;;
    security-delete) del_keychain "$id" "$extra" ;;
    *) die "unknown method '$method' for $cat $id" ;;
  esac
done

# --- postcondition pass: every deleted resource is GONE; preserved items untouched ----------
# `set -e`-safe: every present-probe runs INSIDE an `if`, so a still-present resource is
# reported + accumulated (fail=1) rather than aborting the pass early via errexit.
fail=0
present() { info "STILL PRESENT: $1" >&2; fail=1; } # log + mark (called when a probe finds a survivor)
for ((i = 0; i < N; i++)); do
  cat="${CATS[$i]}"; act="${ACTS[$i]}"; id="${IDS[$i]}"; method="${METHODS[$i]}"; extra="${EXTRAS[$i]}"
  case "$act:$cat" in
    preserve:keychain)
      if security find-generic-password -s "$id" "$SYSTEM_KEYCHAIN" >/dev/null 2>&1; then
        info "OK preserved: keychain $id"
      else
        info "note: preserved keychain $id not present (nothing to preserve)"
      fi
      ;;
    delete:launchd)
      if launchctl print "system/$id" >/dev/null 2>&1 || [[ -e "$extra" ]]; then present "launchd $id (+plist)"; else info "OK absent: launchd $id (+plist)"; fi
      ;;
    delete:user)
      if dscl . -read "/Users/$id" >/dev/null 2>&1; then present "user $id"; else info "OK absent: user $id"; fi ;;
    delete:group)
      if dscl . -read "/Groups/$id" >/dev/null 2>&1; then present "group $id"; else info "OK absent: group $id"; fi ;;
    delete:socket|delete:dir)
      if [[ -e "$id" ]]; then present "$cat $id"; else info "OK absent: $cat $id"; fi ;;
    delete:signer-store)
      if sudo -u "$OP_USER" test -e "$OP_HOME/$id"; then present "signer-store $OP_HOME/$id"; else info "OK absent: signer-store $OP_HOME/$id"; fi ;;
    delete:keychain)
      if security find-generic-password -s "$id" "$SYSTEM_KEYCHAIN" >/dev/null 2>&1; then present "keychain $id"; else info "OK absent: keychain $id"; fi ;;
  esac
done
[[ "$fail" -eq 0 ]] || die "postcondition FAILED — one or more resources still present (see above)"
info "complete — all enumerated resources removed; atlas-gemini-api-key preserved."

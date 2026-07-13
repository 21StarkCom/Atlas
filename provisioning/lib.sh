#!/usr/bin/env bash
# Shared helpers for Atlas provisioning (Task 1.0 / #16). Sourced by dev/ci scripts.
# No side effects on source; all mutation happens in the caller's functions.
set -euo pipefail

ATLAS_OS="$(uname -s)" # Darwin | Linux

# --- resolved paths (mirror provisioning/keys.acl.json) ---
if [ "$ATLAS_OS" = "Darwin" ]; then
  ATLAS_KEYS_DIR="/usr/local/etc/atlas/keys"
  ATLAS_ANCHOR="/usr/local/var/atlas/audit-anchor"
  ATLAS_RUN_DIR="/usr/local/var/run/atlas"
  ATLAS_INSTALL_BIN="/usr/local/lib/atlas/bin"
  ATLAS_ROOT_GROUP="wheel"
else
  ATLAS_KEYS_DIR="/etc/atlas/keys"
  ATLAS_ANCHOR="/var/lib/atlas/audit-anchor"
  ATLAS_RUN_DIR="/var/run/atlas"
  ATLAS_INSTALL_BIN="/opt/atlas/bin"
  ATLAS_ROOT_GROUP="root"
fi
ATLAS_BROKER_SOCK="$ATLAS_RUN_DIR/broker.sock"
ATLAS_EGRESS_SOCK="$ATLAS_RUN_DIR/egress.sock"

ATLAS_GROUP="atlas-git"
ATLAS_USERS=(atlas-broker atlas-egress)   # service accounts
ATLAS_AGENT_USER="atlas-agent"            # dedicated non-login agent UID (D17)

# Base UID/GID range for the service accounts. We claim the first FREE id at or above
# this base on both OSes (macOS service accounts conventionally sit below 500, but a
# high block avoids collisions with existing users; only free ids are taken).
ATLAS_UID_BASE="${ATLAS_UID_BASE:-8420}"

DRY_RUN="${ATLAS_DRY_RUN:-0}"

log()  { printf '  %s\n' "$*" >&2; }
step() { printf '\n== %s\n' "$*" >&2; }
run()  { if [ "$DRY_RUN" = "1" ]; then printf '  [dry-run] %s\n' "$*" >&2; else eval "$@"; fi; }

require_root() {
  if [ "$(id -u)" != "0" ]; then
    echo "error: provisioning must run as root — re-run with: sudo $0 $*" >&2
    exit 2
  fi
}

# --- portable user/group existence + creation ---
group_exists() { if [ "$ATLAS_OS" = "Darwin" ]; then dscl . -read "/Groups/$1" >/dev/null 2>&1; else getent group "$1" >/dev/null 2>&1; fi; }
user_exists()  { if [ "$ATLAS_OS" = "Darwin" ]; then dscl . -read "/Users/$1"  >/dev/null 2>&1; else getent passwd "$1" >/dev/null 2>&1; fi; }

# Find a free id at or above base (checks both users and groups on macOS to keep them aligned).
free_id_at_or_above() {
  local base="$1" id="$1"
  while true; do
    if [ "$ATLAS_OS" = "Darwin" ]; then
      if ! dscl . -search /Users UniqueID "$id" 2>/dev/null | grep -q . \
         && ! dscl . -search /Groups PrimaryGroupID "$id" 2>/dev/null | grep -q .; then echo "$id"; return; fi
    else
      if ! getent passwd "$id" >/dev/null 2>&1 && ! getent group "$id" >/dev/null 2>&1; then echo "$id"; return; fi
    fi
    id=$((id + 1))
  done
}

create_group() {
  local name="$1"
  if group_exists "$name"; then log "group $name exists"; return; fi
  local gid; gid="$(free_id_at_or_above "$ATLAS_UID_BASE")"
  step "create group $name (gid $gid)"
  if [ "$ATLAS_OS" = "Darwin" ]; then
    run "dscl . -create /Groups/$name"
    run "dscl . -create /Groups/$name PrimaryGroupID $gid"
    run "dscl . -create /Groups/$name RealName 'Atlas $name'"
  else
    run "groupadd -r -g $gid $name"
  fi
}

# Create a non-login service/agent user with an empty home and no shell.
create_service_user() {
  local name="$1"
  if user_exists "$name"; then log "user $name exists"; return; fi
  local uid; uid="$(free_id_at_or_above "$((ATLAS_UID_BASE + 1))")"
  step "create service user $name (uid $uid, no login)"
  if [ "$ATLAS_OS" = "Darwin" ]; then
    run "dscl . -create /Users/$name"
    run "dscl . -create /Users/$name UniqueID $uid"
    run "dscl . -create /Users/$name PrimaryGroupID $uid"
    run "dscl . -create /Users/$name UserShell /usr/bin/false"
    run "dscl . -create /Users/$name RealName 'Atlas $name'"
    run "dscl . -create /Users/$name NFSHomeDirectory /var/empty"
    run "dscl . -create /Users/$name IsHidden 1"
    # own primary group of the same id
    if ! group_exists "$name"; then run "dscl . -create /Groups/$name PrimaryGroupID $uid"; run "dscl . -create /Groups/$name RealName 'Atlas $name'"; fi
  else
    run "useradd -r -M -s /usr/sbin/nologin -d /var/empty -c 'Atlas $name' $name"
  fi
}

add_to_group() {
  local user="$1" group="$2"
  step "add $user to group $group"
  if [ "$ATLAS_OS" = "Darwin" ]; then
    run "dseditgroup -o edit -a $user -t user $group"
  else
    run "usermod -aG $group $user"
  fi
}

# Ensure a directory with owner:group + mode (setgid via mode like 2770).
ensure_dir() {
  local path="$1" owner="$2" group="$3" mode="$4"
  run "mkdir -p '$path'"
  run "chown $owner:$group '$path'"
  run "chmod $mode '$path'"
}

# Generate an ed25519 keypair (private .key + public .pub) if absent.
gen_ed25519() {
  local base="$1" owner="$2" group="$3"
  if [ -f "$base.key" ]; then log "ed25519 $base exists"; return; fi
  step "generate ed25519 keypair $base"
  run "openssl genpkey -algorithm ed25519 -out '$base.key'"
  run "openssl pkey -in '$base.key' -pubout -out '$base.pub'"
  run "chown $owner:$group '$base.key' '$base.pub'"
}

# Generate a 256-bit symmetric AEAD key if absent.
gen_aead() {
  local file="$1" owner="$2" group="$3"
  if [ -f "$file" ]; then log "aead $file exists"; return; fi
  step "generate AEAD key $file"
  run "openssl rand -out '$file' 32"
  run "chown $owner:$group '$file'"
}

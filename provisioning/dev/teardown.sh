#!/usr/bin/env bash
# Reverse provisioning/dev/setup.sh (Task 1.0 / #16). Removes the Atlas identities,
# group, keys, anchor, sockets, and install dir. Idempotent.
#
#   sudo provisioning/dev/teardown.sh
#   sudo ATLAS_DRY_RUN=1 provisioning/dev/teardown.sh   # preview
#
# provisioning.separation.test asserts a clean host afterwards (no atlas artifacts).
set -euo pipefail
HERE="$(cd "$(dirname "$0")/.." && pwd)"
# shellcheck source=../lib.sh
source "$HERE/lib.sh"
require_root "$@"

step "Atlas teardown on $ATLAS_OS (dry-run=$DRY_RUN)"

del_user() {
  local name="$1"
  user_exists "$name" || { log "user $name absent"; return; }
  step "delete user $name"
  if [ "$ATLAS_OS" = "Darwin" ]; then
    run "dscl . -delete /Users/$name" || true
    group_exists "$name" && run "dscl . -delete /Groups/$name" || true
  else
    run "userdel -r $name 2>/dev/null || userdel $name" || true
  fi
}
del_group() {
  local name="$1"
  group_exists "$name" || { log "group $name absent"; return; }
  step "delete group $name"
  if [ "$ATLAS_OS" = "Darwin" ]; then run "dscl . -delete /Groups/$name" || true; else run "groupdel $name" || true; fi
}

for u in "${ATLAS_USERS[@]}" "$ATLAS_AGENT_USER"; do del_user "$u"; done
del_group "$ATLAS_GROUP"

step "remove keys, anchor, sockets, install dir"
run "rm -rf '$ATLAS_KEYS_DIR'"
run "rm -f '$ATLAS_ANCHOR'"
run "rm -rf '$ATLAS_RUN_DIR'"
run "rm -rf '$ATLAS_INSTALL_BIN'"

step "DONE — host clean"

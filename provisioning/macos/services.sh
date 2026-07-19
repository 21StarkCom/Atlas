#!/usr/bin/env bash
# Install/uninstall the atlas daemons as launchd system services (macOS only).
#
#   sudo provisioning/macos/services.sh install     # copy plists, bootstrap, start
#   sudo provisioning/macos/services.sh uninstall   # bootout + remove plists
#   provisioning/macos/services.sh status           # per-daemon state (no root needed)
#
# Prerequisites: provisioning/dev/setup.sh has run (identities + dirs) and
# install-artifact.sh has installed the binaries + launchers (D16).
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
# shellcheck source=../lib.sh
source "$HERE/../lib.sh"

[ "$ATLAS_OS" = "Darwin" ] || { echo "error: launchd services are macOS-only" >&2; exit 1; }

LAUNCHD_DIR="/Library/LaunchDaemons"
LOG_DIR="/usr/local/var/log/atlas"
SERVICES=(com.atlas.broker com.atlas.egress)

status() {
  for s in "${SERVICES[@]}"; do
    if launchctl print "system/$s" >/dev/null 2>&1; then
      pid="$(launchctl print "system/$s" 2>/dev/null | awk '/^\tpid = /{print $3}')"
      echo "$s: loaded${pid:+ (pid $pid)}"
    else
      echo "$s: not loaded"
    fi
  done
}

case "${1:-}" in
  install)
    require_root "$@"
    for s in "${SERVICES[@]}"; do
      [ -x "$ATLAS_INSTALL_BIN/${s#com.atlas.}-launcher.sh" ] \
        || { echo "error: $ATLAS_INSTALL_BIN/${s#com.atlas.}-launcher.sh missing — run install-artifact.sh first" >&2; exit 1; }
    done
    ensure_dir "$LOG_DIR" "root" "$ATLAS_ROOT_GROUP" 0755
    # launchd opens Standard{Out,Error}Path after dropping to UserName — pre-create
    # each log file owned by its daemon identity or the daemon gets no logs.
    for s in "${SERVICES[@]}"; do
      u="atlas-${s#com.atlas.}"; f="$LOG_DIR/${s#com.atlas.}.log"
      touch "$f"; chown "$u:$ATLAS_ROOT_GROUP" "$f"; chmod 0644 "$f"
    done
    for s in "${SERVICES[@]}"; do
      step "install $s"
      rendered="$(mktemp -t atlas-plist)"
      trap 'rm -f "$rendered"' EXIT
      sed "s|@ATLAS_INSTALL_BIN@|$ATLAS_INSTALL_BIN|g" "$HERE/$s.plist" > "$rendered"
      install -m 0644 -o root -g "$ATLAS_ROOT_GROUP" "$rendered" "$LAUNCHD_DIR/$s.plist"
      rm -f "$rendered"
      trap - EXIT
      launchctl bootout "system/$s" 2>/dev/null || true
      # bootout returns before teardown completes — wait until the job is gone
      # (bounded) so the immediate bootstrap doesn't race a dying instance.
      for _ in $(seq 1 50); do
        launchctl print "system/$s" >/dev/null 2>&1 || break
        sleep 0.1
      done
      launchctl bootstrap system "$LAUNCHD_DIR/$s.plist"
    done
    status
    ;;
  uninstall)
    require_root "$@"
    for s in "${SERVICES[@]}"; do
      step "remove $s"
      if launchctl print "system/$s" >/dev/null 2>&1; then
        launchctl bootout "system/$s"
      else
        log "$s is already not loaded"
      fi
      rm -f "$LAUNCHD_DIR/$s.plist"
    done
    ;;
  status)
    status
    ;;
  *)
    echo "usage: services.sh install|uninstall|status" >&2
    exit 5
    ;;
esac

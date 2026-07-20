#!/usr/bin/env bash
# Install/uninstall the atlas daemons as launchd system services (macOS only).
#
#   sudo provisioning/macos/services.sh install     # copy plists, bootstrap, start
#   sudo provisioning/macos/services.sh uninstall   # bootout + remove plists
#   provisioning/macos/services.sh status           # per-daemon state (no root needed)
#
#   provisioning/macos/services.sh sync-gate  <vault-path>   # run the gates, mutate nothing
#   sudo provisioning/macos/services.sh enable-sync  <vault-path>  # gate, then start the timer
#   sudo provisioning/macos/services.sh disable-sync         # stop the timer (rollback)
#
# `com.atlas.sync` (#60 Phase 6) is installed by `install` but deliberately NOT
# bootstrapped there: a 300 s timer enabled before its prerequisites hold fail-closes
# every cycle, silently ignores remote pushes, or dies at command resolution — each of
# which looks like a healthy running service. `enable-sync` is the only way in, and it
# refuses unless every gate passes.
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
# Installed alongside the daemons, bootstrapped only by `enable-sync` (see header).
GATED_SERVICES=(com.atlas.sync)
SYNC_LABEL="com.atlas.sync"
SYNC_WRAPPER="$ATLAS_INSTALL_BIN/atlas-sync-wrapper.sh"
KEYCHAIN_SERVICE="atlas-egress-capability"
# `atlas-agent` is a home-less service UID with no login keychain, so the custody
# point must be a keychain in every identity's search list.
SYNC_KEYCHAIN_DEFAULT="${ATLAS_SYNC_KEYCHAIN:-/Library/Keychains/System.keychain}"
# HOME for the timer. launchd supplies none, and atlas-agent's real home is the
# root-owned /var/empty — the CLI's default quarantine state dir hangs off HOME, so
# it must be a directory atlas-agent can actually write. Kept in sync with the
# `HOME` value in com.atlas.sync.plist (asserted by tools/sync-plist.test.ts).
SYNC_AGENT_HOME="/usr/local/var/atlas/agent"

status() {
  for s in "${SERVICES[@]}" "${GATED_SERVICES[@]}"; do
    if launchctl print "system/$s" >/dev/null 2>&1; then
      pid="$(launchctl print "system/$s" 2>/dev/null | awk '/^\tpid = /{print $3}')"
      echo "$s: loaded${pid:+ (pid $pid)}"
    else
      echo "$s: not loaded"
    fi
  done
}

# ---------------------------------------------------------------------------
# The sync-timer gate (#60 Phase 6, Task 6.3)
#
# SEVEN prerequisites, ALL required. Each one, if unmet, produces a timer that looks
# healthy in `launchctl` while doing nothing useful — which is why the timer is never
# enabled without them:
#
#   1. wrapper installed and executable
#   2. the wrapper's baked-in `brain` path resolves and is executable (launchd has no
#      shell PATH — a bare `brain` dies at command resolution every cycle)
#   2b. its baked-in CONFIG DIR is absolute and atlas-agent can read brain.config.yaml
#      there — launchd's cwd is `/` and the CLI resolves the config as
#      `<cwd>/brain.config.yaml` with no upward walk and no env fallback
#   2c. atlas-agent can WRITE the timer's HOME. launchd supplies no HOME and the
#      account's real one is the root-owned /var/empty, while the CLI's default
#      quarantine state dir hangs off HOME — so the first dirty scan would wedge
#   3. `atlas-agent` can OPEN the vault repo read-only. The wrapper runs as
#      atlas-agent, not the vault's owning user, so git's dubious-ownership guard
#      rejects the repo and the very first readRef fails — even with every other gate
#      green. Provisioned as a REPOSITORY-SPECIFIC safe.directory entry, never `*`.
#   4. the Keychain item is reachable AS atlas-agent (the OQ#1 keychain-unlock
#      prerequisite) — otherwise every drain fail-closes on a missing credential
#   5. the upstream puller is provisioned. `brain sync` reads the LOCAL
#      refs/heads/main and atlas-agent is network-denied (D17), so something else must
#      advance it from GitHub — the existing brain-hub puller. Without it the timer
#      runs forever and never observes a single remote push. Name its launchd label
#      via ATLAS_UPSTREAM_PULLER_LABEL.
#
# Read-only: `sync-gate` mutates nothing except the safe.directory entry it must add
# to perform probe 3 honestly.
# ---------------------------------------------------------------------------
# Read one `NAME="value"` line the installer baked into the wrapper. Never fails the
# caller: a missing/unreadable wrapper yields the empty string, so every probe still
# runs and the gate reaches its own verdict instead of dying under `set -e`.
wrapper_field() {
  [ -r "$SYNC_WRAPPER" ] || return 0
  sed -n "s|^$1=\"\\(.*\\)\"\$|\\1|p" "$SYNC_WRAPPER" 2>/dev/null | head -1
}

sync_gate() {
  local vault="${1:-}"
  local failed=0
  gate_ok()   { printf '  [ok]   %s\n' "$*" >&2; }
  gate_fail() { printf '  [FAIL] %s\n' "$*" >&2; failed=1; }

  [ -n "$vault" ] || { echo "error: usage: services.sh sync-gate|enable-sync <vault-path>" >&2; exit 5; }

  step "sync gate — $SYNC_LABEL prerequisites"

  # 1 + 2 — the wrapper, the absolute brain path, and the config dir it baked in.
  if [ -x "$SYNC_WRAPPER" ]; then
    gate_ok "wrapper installed: $SYNC_WRAPPER"
    local brain_bin config_dir
    brain_bin="$(wrapper_field BRAIN || true)"
    case "$brain_bin" in
      "" | *@ATLAS_BRAIN_BIN@*)
        gate_fail "the wrapper's brain path was never substituted — re-run install-artifact.sh (ATLAS_BRAIN_BIN=...)" ;;
      /*)
        if [ -x "$brain_bin" ]; then gate_ok "absolute brain resolves: $brain_bin"
        else gate_fail "the wrapper's brain path is not executable: $brain_bin"; fi ;;
      *)
        gate_fail "the wrapper's brain path is not absolute: $brain_bin (launchd has no shell PATH)" ;;
    esac
    # launchd runs the job with cwd `/`, and brain resolves its config strictly as
    # <cwd>/brain.config.yaml — an unsubstituted or wrong dir fail-closes EVERY cycle.
    config_dir="$(wrapper_field CONFIG_DIR || true)"
    case "$config_dir" in
      "" | *@ATLAS_CONFIG_DIR@*)
        gate_fail "the wrapper's config dir was never substituted — re-run install-artifact.sh (ATLAS_CONFIG_DIR=...)" ;;
      /*)
        if sudo -n -u "$ATLAS_AGENT_USER" test -r "$config_dir/brain.config.yaml"; then
          gate_ok "$ATLAS_AGENT_USER can read $config_dir/brain.config.yaml"
        else
          gate_fail "$ATLAS_AGENT_USER cannot read $config_dir/brain.config.yaml — every cycle would exit 2 at config load"
        fi ;;
      *)
        gate_fail "the wrapper's config dir is not absolute: $config_dir" ;;
    esac
  else
    gate_fail "wrapper missing or not executable: $SYNC_WRAPPER — run install-artifact.sh first (it SKIPS when ATLAS_BRAIN_BIN/ATLAS_CONFIG_DIR are unset)"
  fi

  # 2c — a WRITABLE HOME for the timer. launchd supplies none; the CLI's default
  # quarantine state dir is `<HOME>/Library/Application Support/atlas/quarantine`, so
  # an unwritable HOME wedges the first cycle that quarantines anything.
  if sudo -n -u "$ATLAS_AGENT_USER" test -w "$SYNC_AGENT_HOME"; then
    gate_ok "$ATLAS_AGENT_USER can write its timer HOME: $SYNC_AGENT_HOME"
  else
    gate_fail "$ATLAS_AGENT_USER cannot write $SYNC_AGENT_HOME (the plist's HOME) — re-run \`services.sh install\`; without it the default quarantine dir lands under the root-owned /var/empty"
  fi

  # 3 — the atlas-agent repo-open probe (the failure that survives every other gate).
  if [ -d "$vault/.git" ] || [ -f "$vault/HEAD" ]; then
    # REPOSITORY-SPECIFIC entry, never `*` — a wildcard would hand atlas-agent every
    # repo on the host. Written to the SYSTEM config (/etc/gitconfig), NOT the target
    # user's --global: atlas-agent is a home-less service UID (NFSHomeDirectory
    # /var/empty, root-owned 0555), so a --global write has nowhere to land and would
    # abort the whole gate under `set -e`. Idempotent; failure is a gate failure, not
    # a crash.
    if [ "$(id -u)" = "0" ] && [ "$DRY_RUN" != "1" ]; then
      if ! git config --system --get-all safe.directory 2>/dev/null | grep -qxF "$vault"; then
        git config --system --add safe.directory "$vault" \
          || gate_fail "could not add a system-wide git safe.directory entry for $vault"
      fi
    fi
    if sudo -n -u "$ATLAS_AGENT_USER" git -C "$vault" rev-parse --verify refs/heads/main >/dev/null 2>&1; then
      gate_ok "$ATLAS_AGENT_USER can open $vault and read refs/heads/main"
    else
      gate_fail "$ATLAS_AGENT_USER cannot read refs/heads/main in $vault — check FS access + the repo-specific git safe.directory entry"
    fi
  else
    gate_fail "not a git repository: $vault"
  fi

  # 4 — Keychain reachability AS atlas-agent. This must be the EXACT operation the
  # wrapper performs: `-w` (retrieve + DECRYPT the password) against the SAME explicit
  # keychain file. An attribute-only lookup succeeds without decrypting, so it would
  # pass on a locked keychain the wrapper then fails to read.
  # `|| true`: with `set -euo pipefail`, sed on a MISSING wrapper exits 1 and pipefail
  # carries it into this bare assignment, killing the gate before probes 4-6 ever run —
  # and "wrapper not installed" is the NORMAL state on a host that never adopted a
  # vault. The gate must always reach its own summary and exit 2, never die at 1.
  local keychain
  keychain="$(wrapper_field KEYCHAIN || true)"
  case "$keychain" in "" | *@ATLAS_KEYCHAIN@*) keychain="$SYNC_KEYCHAIN_DEFAULT" ;; esac
  if sudo -n -u "$ATLAS_AGENT_USER" /usr/bin/security find-generic-password -w \
       -s "$KEYCHAIN_SERVICE" -a "$ATLAS_AGENT_USER" "$keychain" >/dev/null 2>&1; then
    gate_ok "capability secret READS as $ATLAS_AGENT_USER from $keychain"
  else
    gate_fail "capability secret does NOT read as $ATLAS_AGENT_USER from $keychain (service=$KEYCHAIN_SERVICE) — provision it there and unlock the keychain; the interactive-session posture is the only supported one (OQ#1(b))"
  fi

  # 5 — the upstream puller (atlas-agent is network-denied and cannot fetch).
  local puller="${ATLAS_UPSTREAM_PULLER_LABEL:-}"
  if [ -z "$puller" ]; then
    gate_fail "ATLAS_UPSTREAM_PULLER_LABEL is unset — name the brain-hub puller's launchd label; without it refs/heads/main never advances and the timer never observes a remote push"
  # A per-user LaunchAgent lives in the INVOKING operator's gui domain — under
  # `sudo enable-sync` `id -u` is 0, so probe SUDO_UID first or the agent is invisible.
  elif launchctl print "system/$puller" >/dev/null 2>&1 \
    || launchctl print "gui/${SUDO_UID:-$(id -u)}/$puller" >/dev/null 2>&1 \
    || launchctl print "gui/$(id -u)/$puller" >/dev/null 2>&1; then
    gate_ok "upstream puller loaded: $puller"
  else
    gate_fail "upstream puller '$puller' is not loaded"
  fi

  if [ "$failed" != "0" ]; then
    echo "error: sync gate FAILED — $SYNC_LABEL stays disabled (a timer enabled here would fail closed every cycle)" >&2
    exit 2
  fi
  log "sync gate PASSED"
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
    # The sync timer runs as atlas-agent (not `atlas-sync`), so its log needs that owner.
    touch "$LOG_DIR/sync.log"; chown "$ATLAS_AGENT_USER:$ATLAS_ROOT_GROUP" "$LOG_DIR/sync.log"; chmod 0644 "$LOG_DIR/sync.log"
    # …and a writable HOME, since launchd supplies none and /var/empty is root-owned.
    ensure_dir "$SYNC_AGENT_HOME" "$ATLAS_AGENT_USER" "$ATLAS_ROOT_GROUP" 0700
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
    # Gated services: the plist is INSTALLED but never bootstrapped here. `enable-sync`
    # is the only path that starts the timer, and only after every gate passes.
    for s in "${GATED_SERVICES[@]}"; do
      step "install $s (DISABLED — run \`services.sh enable-sync <vault-path>\` to start it)"
      rendered="$(mktemp -t atlas-plist)"
      trap 'rm -f "$rendered"' EXIT
      sed "s|@ATLAS_INSTALL_BIN@|$ATLAS_INSTALL_BIN|g" "$HERE/$s.plist" > "$rendered"
      install -m 0644 -o root -g "$ATLAS_ROOT_GROUP" "$rendered" "$LAUNCHD_DIR/$s.plist"
      rm -f "$rendered"
      trap - EXIT
    done
    status
    ;;
  uninstall)
    require_root "$@"
    for s in "${SERVICES[@]}" "${GATED_SERVICES[@]}"; do
      step "remove $s"
      if launchctl print "system/$s" >/dev/null 2>&1; then
        launchctl bootout "system/$s"
      else
        log "$s is already not loaded"
      fi
      rm -f "$LAUNCHD_DIR/$s.plist"
    done
    ;;
  sync-gate)
    sync_gate "${2:-}"
    ;;
  enable-sync)
    require_root "$@"
    sync_gate "${2:-}"
    [ -f "$LAUNCHD_DIR/$SYNC_LABEL.plist" ] \
      || { echo "error: $LAUNCHD_DIR/$SYNC_LABEL.plist missing — run \`services.sh install\` first" >&2; exit 1; }
    step "enable $SYNC_LABEL (every gate passed)"
    launchctl bootout "system/$SYNC_LABEL" 2>/dev/null || true
    for _ in $(seq 1 50); do
      launchctl print "system/$SYNC_LABEL" >/dev/null 2>&1 || break
      sleep 0.1
    done
    launchctl bootstrap system "$LAUNCHD_DIR/$SYNC_LABEL.plist"
    status
    ;;
  disable-sync)
    # The Phase-6 rollback: sync reverts to manual (`brain sync` on demand). No data change.
    require_root "$@"
    step "disable $SYNC_LABEL"
    if launchctl print "system/$SYNC_LABEL" >/dev/null 2>&1; then
      launchctl bootout "system/$SYNC_LABEL"
    else
      log "$SYNC_LABEL is already not loaded"
    fi
    ;;
  status)
    status
    ;;
  *)
    echo "usage: services.sh install|uninstall|status|sync-gate <vault-path>|enable-sync <vault-path>|disable-sync" >&2
    exit 5
    ;;
esac

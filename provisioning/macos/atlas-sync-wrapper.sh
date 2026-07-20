#!/usr/bin/env bash
# The two-step sync auto-hook (#60 Phase 6, Task 6.1) — run by `com.atlas.sync.plist`
# on a 300 s timer as the unprivileged `atlas-agent` identity.
#
#   step 1  brain sync --json         absorb upstream refs/heads/main → refs/atlas/main
#   step 2  brain jobs run --all --json   drain the index:reconcile job step 1 enqueued
#
# This closes the ingest→index gap: without step 2 the cursor advances and the
# enqueued reconcile job never runs, so a synced note is never retrievable.
#
# ## Credential scoping (the reason this is a script and not two plist entries)
#
# `brain sync` scans and integrates UNTRUSTED upstream content and mints nothing —
# it must never inherit the standing egress capability secret. So step 1 runs with
# BOTH custody vars scrubbed from its environment, and the secret is fetched from
# the Keychain only after step 1 succeeds, then handed to the drain **on file
# descriptor 3** (`ATLAS_EGRESS_CAPABILITY_KEY_FD=3`) — never written to disk,
# never placed in any environment, never logged. The fd dies with the drain.
#
# The fd is fed by a process substitution deliberately: bash here-strings
# (`3<<<"$key"`) are implemented with a TEMP FILE on macOS, which would put the
# secret on disk — exactly what the custody contract forbids. `printf` is a bash
# builtin, so the value never appears in any process's argv either.
#
# ## Exit codes
#
# 0/6 from step 1 are the success envelopes that advanced the cursor and enqueued
# the reconcile job (6 = ≥1 attributable path quarantined) — both drain. Every
# other status (2 config/vault/lock/divergence-halt, 3 secret-scan, 4 internal, 5
# usage) is a true abort: exit with it, do NOT drain. The wrapper's own custody
# failures exit 2 (a provisioning/config fault), never a silent no-op.
#
# `@ATLAS_*@` placeholders are substituted at provisioning time. Two of them are
# load-bearing because launchd gives a job NO shell environment and NO useful cwd:
#
#   @ATLAS_BRAIN_BIN@   — a bare `brain` fails command-not-found under the minimal
#                         launchd PATH before sync even starts.
#   @ATLAS_CONFIG_DIR@  — `brain` resolves its config strictly as
#                         `<cwd>/brain.config.yaml` (no upward walk, no env
#                         fallback), and every relative config path (`sqlite.path`,
#                         `lancedb.dir`, `logs.dir`, the lock dir) resolves against
#                         the same cwd. launchd starts the job with cwd `/`, so
#                         without this `cd` EVERY cycle would die at config load
#                         with exit 2 — a timer that looks alive and does nothing.
set -euo pipefail

BRAIN="@ATLAS_BRAIN_BIN@"
CONFIG_DIR="@ATLAS_CONFIG_DIR@"
SECURITY_BIN="@ATLAS_SECURITY_BIN@"
KEYCHAIN="@ATLAS_KEYCHAIN@"
KEYCHAIN_SERVICE="atlas-egress-capability"
KEYCHAIN_ACCOUNT="atlas-agent"

die() {
  echo "atlas-sync-wrapper: $1" >&2
  exit "${2:-2}"
}

[ -x "$BRAIN" ] || die "brain executable not found at '$BRAIN' (provisioning must substitute an absolute path)"
[ -f "$CONFIG_DIR/brain.config.yaml" ] \
  || die "no brain.config.yaml in '$CONFIG_DIR' (provisioning must substitute the deployment's config dir)"
cd "$CONFIG_DIR" || die "cannot enter the config dir '$CONFIG_DIR'"

# ---------------------------------------------------------------------------
# Step 1 — absorb. No egress credential in this environment, by construction.
# `set +e` around it so a non-zero status is a decision input, not an abort.
# ---------------------------------------------------------------------------
set +e
env -u ATLAS_EGRESS_CAPABILITY_KEY -u ATLAS_EGRESS_CAPABILITY_KEY_FD "$BRAIN" sync --json
sync_rc=$?
set -e

case "$sync_rc" in
  0 | 6) ;;
  *) exit "$sync_rc" ;;
esac

# ---------------------------------------------------------------------------
# Step 2 — drain, with the secret scoped to this one command.
# ---------------------------------------------------------------------------
# The keychain FILE is named explicitly. `-a atlas-agent` is only an attribute, not
# an identity selector: without a keychain argument `security` reads the invoking
# user's DEFAULT keychain, and `atlas-agent` is a home-less service UID
# (NFSHomeDirectory /var/empty) that has no login keychain at all.
key="$("$SECURITY_BIN" find-generic-password -w -s "$KEYCHAIN_SERVICE" -a "$KEYCHAIN_ACCOUNT" "$KEYCHAIN" 2>/dev/null)" || key=""
[ -n "$key" ] || die "capability secret unavailable from $KEYCHAIN (service=$KEYCHAIN_SERVICE account=$KEYCHAIN_ACCOUNT) — is it provisioned and the keychain unlocked? refusing to drain without a credential"

exec 3< <(printf '%s' "$key")
key=""
unset key

set +e
ATLAS_EGRESS_CAPABILITY_KEY_FD=3 "$BRAIN" jobs run --all --json
drain_rc=$?
set -e
exec 3<&-

exit "$drain_rc"

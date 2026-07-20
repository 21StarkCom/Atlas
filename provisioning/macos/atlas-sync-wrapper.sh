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
# `@ATLAS_*@` placeholders are substituted at provisioning time — launchd does not
# source the operator's shell, so a bare `brain` would fail command-not-found under
# the minimal launchd PATH before sync even starts.
set -euo pipefail

BRAIN="@ATLAS_BRAIN_BIN@"
SECURITY_BIN="@ATLAS_SECURITY_BIN@"
KEYCHAIN_SERVICE="atlas-egress-capability"
KEYCHAIN_ACCOUNT="atlas-agent"

die() {
  echo "atlas-sync-wrapper: $1" >&2
  exit "${2:-2}"
}

[ -x "$BRAIN" ] || die "brain executable not found at '$BRAIN' (provisioning must substitute an absolute path)"

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
key="$($SECURITY_BIN find-generic-password -w -s "$KEYCHAIN_SERVICE" -a "$KEYCHAIN_ACCOUNT" 2>/dev/null)" || key=""
[ -n "$key" ] || die "capability secret unavailable from the Keychain (service=$KEYCHAIN_SERVICE account=$KEYCHAIN_ACCOUNT) — is the keychain unlocked? refusing to drain without a credential"

exec 3< <(printf '%s' "$key")
key=""
unset key

set +e
ATLAS_EGRESS_CAPABILITY_KEY_FD=3 "$BRAIN" jobs run --all --json
drain_rc=$?
set -e
exec 3<&-

exit "$drain_rc"

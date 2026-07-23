#!/usr/bin/env bash
# The two-step sync auto-hook — run by `com.atlas.sync.plist` on a 300 s timer.
#
#   step 1  brain sync --json            reconcile the working tree → projection + index
#   step 2  brain jobs run --all --json  drain any enqueued jobs (e.g. reverify)
#
# v2 (#334, ADR-0003): the egress-capability custody machinery is RETIRED — the
# in-process provider resolves its own credential lazily (env/Keychain) on real
# provider calls, so this wrapper fetches nothing, scopes nothing, and hands no
# secret to anyone. What remains load-bearing:
#
#   @ATLAS_BRAIN_BIN@   — a bare `brain` fails command-not-found under the minimal
#                         launchd PATH before sync even starts.
#   @ATLAS_CONFIG_DIR@  — `brain` resolves its config strictly as
#                         `<cwd>/brain.config.yaml`; launchd starts jobs with cwd
#                         `/`, so without this `cd` every cycle dies at config load.
#
# Exit codes: a non-zero step-1 status is a true abort (exit with it, do NOT
# drain); step 2's status is the wrapper's.
set -euo pipefail

BRAIN="@ATLAS_BRAIN_BIN@"
CONFIG_DIR="@ATLAS_CONFIG_DIR@"

die() {
  echo "atlas-sync-wrapper: $1" >&2
  exit "${2:-2}"
}

[ -x "$BRAIN" ] || die "brain executable not found at '$BRAIN' (provisioning must substitute an absolute path)"
[ -f "$CONFIG_DIR/brain.config.yaml" ] \
  || die "no brain.config.yaml in '$CONFIG_DIR' (provisioning must substitute the deployment's config dir)"
cd "$CONFIG_DIR" || die "cannot enter the config dir '$CONFIG_DIR'"

# Step 1 — reconcile. `set +e` so a non-zero status is a decision input.
set +e
"$BRAIN" sync --json
sync_rc=$?
set -e

[ "$sync_rc" -eq 0 ] || exit "$sync_rc"

# Step 2 — drain.
exec "$BRAIN" jobs run --all --json

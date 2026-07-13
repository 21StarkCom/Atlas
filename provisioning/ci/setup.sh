#!/usr/bin/env bash
# CI host provisioning (Task 1.0 / #16, D1). Runs the dev provisioning, then installs
# a sudoers drop-in allowing the (passwordless-sudo) runner user to `sudo -u
# atlas-broker` / `sudo -u atlas-egress` ONLY the two installed launchers. CI always
# provisions, so the ATLAS_PROVISIONED-gated suites never skip on CI.
#
#   sudo provisioning/ci/setup.sh
set -euo pipefail
HERE="$(cd "$(dirname "$0")/.." && pwd)"
# shellcheck source=../lib.sh
source "$HERE/lib.sh"
require_root "$@"

"$HERE/dev/setup.sh"

RUNNER="${SUDO_USER:-${CI_RUNNER_USER:-runner}}"
DROPIN="/etc/sudoers.d/atlas-ci"
step "install sudoers drop-in $DROPIN (runner=$RUNNER)"
if [ "$DRY_RUN" != "1" ]; then
  cat > "$DROPIN" <<EOF
# Atlas CI: allow the runner to launch ONLY the two privileged launchers as their
# service identities — nothing else. (D1)
$RUNNER ALL=(atlas-broker) NOPASSWD: $ATLAS_INSTALL_BIN/broker-launcher.sh
$RUNNER ALL=(atlas-egress) NOPASSWD: $ATLAS_INSTALL_BIN/egress-launcher.sh
EOF
  chmod 0440 "$DROPIN"
  visudo -cf "$DROPIN" >/dev/null
fi

step "DONE — CI provisioned. Export ATLAS_PROVISIONED=1 in the job env."

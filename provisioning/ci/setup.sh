#!/usr/bin/env bash
# CI host provisioning — RETIRED (phase-2-in-process-cutover, #312).
#
# The in-process cutover means CI no longer provisions the two-UID / daemon /
# key-custody host layout: `.github/workflows/ci.yml` runs `pnpm -r test`
# daemon-free with ATLAS_PROVISIONED unset, so the provisioning-gated suites
# cleanly subset (run their in-process subset) instead of exercising the real
# OS identities. This script is intentionally kept as a no-op stub for one more
# phase — the provisioned suites and the dev provisioning it wrapped are DELETED
# (not skipped) in Phase 3, at which point this file goes with them.
#
# Local/manual host provisioning still lives at provisioning/dev/setup.sh; run
# that directly if you need the real two-UID layout for a live drive.
set -euo pipefail

echo "provisioning/ci/setup.sh: no-op — CI is zero-provisioning (#312). See dev/setup.sh for a real host provision."

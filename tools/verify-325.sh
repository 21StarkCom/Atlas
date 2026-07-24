#!/usr/bin/env bash
# verify-325.sh — acceptance harness for #325 (mutation order + dirty-vault
# doctrine + canonical-ref removal). Run from anywhere; operates on the repo it
# lives in. Gates that depend on files you haven't written yet report SKIP, so
# you can run this continuously while building. Exit 0 = every present gate green.
#
#   ./tools/verify-325.sh          # full run (build + greps + tests + contract)
#   ./tools/verify-325.sh --fast   # skip the full serial suite (targeted tests only)
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"
FAST=0; [ "${1:-}" = "--fast" ] && FAST=1

PASS=0; FAIL=0; SKIP=0
declare -a FAILURES=()
ok()   { PASS=$((PASS+1)); printf '  \033[32mPASS\033[0m  %s\n' "$1"; }
bad()  { FAIL=$((FAIL+1)); FAILURES+=("$1"); printf '  \033[31mFAIL\033[0m  %s\n' "$1"; }
skip() { SKIP=$((SKIP+1)); printf '  \033[33mSKIP\033[0m  %s\n' "$1"; }
hdr()  { printf '\n\033[1m== %s ==\033[0m\n' "$1"; }

# ---------------------------------------------------------------- 1. build
hdr "1. build (tsc, all packages)"
if pnpm -r build > /tmp/verify-325-build.log 2>&1; then
  ok "pnpm -r build"
else
  bad "pnpm -r build — tail of log:"; tail -15 /tmp/verify-325-build.log
fi

# ------------------------------------------------- 2. canonical-ref fold-out
hdr "2. grep: canonical-ref indirection fully folded out"
# Only the gate-exempt one-shot cutover artifact may reference these.
# Comment-only lines (// or doc-block *) are excluded — they die with their
# files and are noise in the worklist; the gate is about live code.
HITS=$(grep -rn 'git\.canonical_ref\|refs/atlas/main\|ATLAS_CANONICAL_REF\|config/canonical-ref' \
  apps/cli/src packages/*/src tools --include='*.ts' 2>/dev/null \
  | grep -v 'tools/cutover-canonical-ref.ts' \
  | grep -vE ':[0-9]+:\s*(//|\*|/\*)' || true)
if [ -z "$HITS" ]; then
  ok "no canonical-ref references outside the cutover artifact"
else
  bad "canonical-ref references survive:"; printf '%s\n' "$HITS" | head -15
fi

# --------------------------------------------- 3. Phase-2 factories retired
hdr "3. grep: Phase-2 integration factories gone from entry points"
HITS=$(grep -rn 'makeBrokerIntegrator\|brokerSignedIntegration\|makeInProcessBrokerClient' \
  apps/cli/src --include='*.ts' 2>/dev/null \
  | grep -vE ':[0-9]+:\s*(//|\*|/\*)' || true)
if [ -z "$HITS" ]; then
  ok "no mutation entry point uses the Phase-2 factories"
else
  bad "Phase-2 factory call sites survive:"; printf '%s\n' "$HITS" | head -15
fi

# -------------------------------------------------- 4. the three test files
hdr "4. #325 test files (targeted)"
run_test_file() { # $1 = package filter, $2 = path relative to package, $3 = label
  if [ -f "$2" ]; then
    if pnpm --filter "$1" exec vitest run "${2#apps/cli/}" > /tmp/verify-325-t.log 2>&1; then
      ok "$3"
    else
      bad "$3 — tail:"; tail -12 /tmp/verify-325-t.log
    fi
  else
    skip "$3 (file not written yet: $2)"
  fi
}
run_test_file @atlas/cli apps/cli/test/dirty-vault.test.ts \
  "dirty-vault.test.ts (rows a / b / b2 / b3)"
run_test_file @atlas/cli apps/cli/test/mutation-order.restoration.test.ts \
  "mutation-order.restoration.test.ts (revert+sync restore, HEAD guard, failpoints)"
# routing conformance may live under either name — try both
ROUTING=""
for f in apps/cli/test/mutation-order.routing.test.ts apps/cli/test/routing-conformance.test.ts; do
  [ -f "$f" ] && ROUTING="$f" && break
done
if [ -n "$ROUTING" ]; then
  run_test_file @atlas/cli "$ROUTING" "routing conformance ($ROUTING)"
else
  skip "routing conformance test (not written yet)"
fi

# ------------------------------------------------ 5. cutover artifact no-op
hdr "5. cutover-canonical-ref.ts — no-op on a fresh fixture vault born on main"
if [ -f tools/cutover-canonical-ref.ts ]; then
  TMP=$(mktemp -d /tmp/verify-325-vault.XXXXXX)
  (
    cd "$TMP"
    git init -q -b main
    git config user.name "Fixture"; git config user.email "fixture@atlas.local"
    git config commit.gpgsign false
    printf '# fixture note\n' > note.md
    git add -A; git commit -q -m "fixture: initial"
  )
  if node --experimental-strip-types tools/cutover-canonical-ref.ts "$TMP" > /tmp/verify-325-cutover.log 2>&1; then
    # no-op = exit 0 AND main's tip unmoved AND HEAD==main
    TIP_OK=$(cd "$TMP" && [ "$(git rev-parse HEAD)" = "$(git rev-parse main)" ] && echo yes || echo no)
    if [ "$TIP_OK" = "yes" ]; then
      ok "cutover artifact is a no-op on a fresh main-born vault (exit 0, HEAD==main)"
    else
      bad "cutover ran but HEAD != main afterwards"
    fi
  else
    bad "cutover artifact non-zero on a fresh fixture vault — tail:"; tail -10 /tmp/verify-325-cutover.log
  fi
  rm -rf "$TMP"
else
  skip "tools/cutover-canonical-ref.ts (not written yet)"
fi

# ------------------------------------------------------- 6. full suite + gate
if [ "$FAST" -eq 1 ]; then
  hdr "6. full suite"; skip "full serial suite (--fast)"
else
  hdr "6. full serial test suite (memory-kind on this box)"
  if pnpm -r --workspace-concurrency=1 test > /tmp/verify-325-tests.log 2>&1; then
    ok "pnpm -r --workspace-concurrency=1 test"
  else
    bad "full suite — failures:"; grep -E 'FAIL|failed' /tmp/verify-325-tests.log | head -12
  fi
fi

hdr "7. CLI-contract determinism gate"
if node tools/gen-cli-contract.ts --check > /tmp/verify-325-contract.log 2>&1; then
  ok "contract check clean"
else
  bad "contract gate — tail:"; tail -8 /tmp/verify-325-contract.log
fi

# ------------------------------------------------------------------ summary
printf '\n\033[1m== #325 verification: %d pass, %d fail, %d skip ==\033[0m\n' "$PASS" "$FAIL" "$SKIP"
if [ "$FAIL" -gt 0 ]; then
  printf '\033[31mFailing gates:\033[0m\n'; printf '  - %s\n' "${FAILURES[@]}"
  exit 1
fi
[ "$SKIP" -gt 0 ] && printf '\033[33mNote: %d gate(s) skipped — not yet written. Green here ≠ done.\033[0m\n' "$SKIP"
exit 0

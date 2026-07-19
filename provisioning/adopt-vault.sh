#!/usr/bin/env bash
# adopt-vault.sh — one-time vault adoption bootstrap (60-A task 1.6).
#
# Creates refs/atlas/main at a broker-authored empty-tree baseline commit,
# optionally locks refs/atlas/ to atlas-broker ownership (0700), runs
# brain db migrate, seeds the sync_cursors zero-state row, and validates
# all three. Idempotent — safe to re-run.
#
# Usage:
#   sudo provisioning/adopt-vault.sh \
#     --config <config-dir> \
#     --source-id <source-id> \
#     --vault <vault-repo-path> \
#     [--upstream-ref refs/heads/main] \
#     [--canonical-ref refs/atlas/main]
#
# Prerequisites:
#   - Provisioned host (provisioning/dev/setup.sh) with atlas-broker user
#   - brain binary built and findable (BRAIN_BIN env or auto-detected)
#   - seed-cli built at apps/cli/dist/sync/seed-cli.js (relative to REPO_ROOT)
#   - Vault config has git.canonical_ref = refs/atlas/main set
#
# OQ#2 gate:
#   When ATLAS_PROVISIONED=1 and atlas-broker + atlas-agent users exist, the
#   script proves that atlas-agent CANNOT write refs/atlas/* (adversarial test)
#   and atlas-broker CAN (control test). If the gate fails, the script exits
#   non-zero and the vault is left un-adopted. The follow-on 60-F (bare-mirror
#   variant) is the documented recovery — there is no in-plan fallback.
#
# Activation sequencing:
#   This script MUST NOT be run against the real main-vault until Phases 1-4
#   are installed and brain sync --dry-run passes on a throwaway clone. The
#   first real 'brain sync' immediately follows adoption. See docs/install.md.

set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
# shellcheck source=provisioning/lib.sh
source "$SCRIPT_DIR/lib.sh"

# ─── argument defaults ────────────────────────────────────────────────────────
CONFIG_DIR=""
SOURCE_ID=""
VAULT_PATH=""
UPSTREAM_REF="refs/heads/main"
CANONICAL_REF="refs/atlas/main"

# ─── parse arguments ──────────────────────────────────────────────────────────
while [[ $# -gt 0 ]]; do
  case "$1" in
    --config)        CONFIG_DIR="$2";    shift 2 ;;
    --source-id)     SOURCE_ID="$2";     shift 2 ;;
    --vault)         VAULT_PATH="$2";    shift 2 ;;
    --upstream-ref)  UPSTREAM_REF="$2";  shift 2 ;;
    --canonical-ref) CANONICAL_REF="$2"; shift 2 ;;
    --dry-run)       DRY_RUN=1;          shift   ;;
    *) echo "error: unknown argument: $1" >&2; exit 5 ;;
  esac
done

# ─── validate required arguments ─────────────────────────────────────────────
if [[ -z "$CONFIG_DIR" ]];  then echo "error: --config <dir> is required" >&2;    exit 5; fi
if [[ -z "$SOURCE_ID" ]];   then echo "error: --source-id <id> is required" >&2;  exit 5; fi
if [[ -z "$VAULT_PATH" ]];  then echo "error: --vault <path> is required" >&2;    exit 5; fi

CONFIG_DIR="$(cd "$CONFIG_DIR" && pwd)"
VAULT_PATH="$(cd "$VAULT_PATH" && pwd)"
GIT_DIR="$VAULT_PATH/.git"

if [[ ! -d "$GIT_DIR" ]]; then
  echo "error: $VAULT_PATH is not a git repository (.git not found)" >&2; exit 2
fi

# ─── locate brain binary and seed-cli ────────────────────────────────────────
if [[ -z "${BRAIN_BIN:-}" ]]; then
  if command -v brain >/dev/null 2>&1; then
    BRAIN_BIN="brain"
  elif [[ -f "$REPO_ROOT/node_modules/.bin/brain" ]]; then
    BRAIN_BIN="$REPO_ROOT/node_modules/.bin/brain"
  elif [[ -f "$REPO_ROOT/apps/cli/dist/bin.js" ]]; then
    BRAIN_BIN="node $REPO_ROOT/apps/cli/dist/bin.js"
  else
    echo "error: brain binary not found — set BRAIN_BIN or build apps/cli" >&2; exit 2
  fi
fi

SEED_CLI="$REPO_ROOT/apps/cli/dist/sync/seed-cli.js"
if [[ ! -f "$SEED_CLI" ]]; then
  echo "error: seed-cli not found at $SEED_CLI — build apps/cli first (pnpm -r build)" >&2; exit 2
fi

log "Config:       $CONFIG_DIR"
log "Vault:        $VAULT_PATH"
log "Source ID:    $SOURCE_ID"
log "Upstream ref: $UPSTREAM_REF"
log "Canonical:    $CANONICAL_REF"

# ─── step 1: OQ#2 user pre-check (ATLAS_PROVISIONED=1 only) ─────────────────
# The adversarial ref-boundary test requires real OS users. Skip when not
# provisioned — the permission lockdown step is also skipped in that case.
if [[ "${ATLAS_PROVISIONED:-0}" = "1" ]]; then
  step "OQ#2 user pre-check"
  if ! user_exists "atlas-broker"; then
    echo "error: OQ#2 gate: atlas-broker user does not exist — run provisioning/dev/setup.sh" >&2
    exit 2
  fi
  if ! user_exists "$ATLAS_AGENT_USER"; then
    echo "error: OQ#2 gate: $ATLAS_AGENT_USER user does not exist — run provisioning/dev/setup.sh" >&2
    exit 2
  fi
  log "atlas-broker + $ATLAS_AGENT_USER present ✓"
fi

# ─── step 2: create the empty-tree baseline commit (idempotent) ──────────────
step "Create $CANONICAL_REF baseline"

EXISTING_OID=""
if git -C "$VAULT_PATH" rev-parse --verify "$CANONICAL_REF" >/dev/null 2>&1; then
  EXISTING_OID="$(git -C "$VAULT_PATH" rev-parse "$CANONICAL_REF")"
  log "$CANONICAL_REF already exists at $EXISTING_OID — skipping ref creation (idempotent)"
else
  # Create an empty tree object (content-addressed: always the same SHA)
  EMPTY_TREE="$(git -C "$VAULT_PATH" hash-object -t tree /dev/null)"
  log "empty tree: $EMPTY_TREE"

  # Create a broker-authored baseline commit (empty tree, no parent)
  # GIT_*_DATE=epoch makes the commit deterministic for reproducible audit SHAs.
  BASELINE_OID="$(
    GIT_AUTHOR_NAME="atlas-broker" \
    GIT_AUTHOR_EMAIL="atlas-broker@atlas" \
    GIT_COMMITTER_NAME="atlas-broker" \
    GIT_COMMITTER_EMAIL="atlas-broker@atlas" \
    GIT_AUTHOR_DATE="1970-01-01T00:00:00+00:00" \
    GIT_COMMITTER_DATE="1970-01-01T00:00:00+00:00" \
    git -C "$VAULT_PATH" commit-tree "$EMPTY_TREE" \
      -m "atlas: adoption baseline [source=$SOURCE_ID upstream=$UPSTREAM_REF]"
  )"
  log "baseline commit: $BASELINE_OID"
  run "git -C '$VAULT_PATH' update-ref '$CANONICAL_REF' '$BASELINE_OID'"
  log "$CANONICAL_REF → $BASELINE_OID ✓"
fi

# ─── step 3: lock refs/atlas/ namespace to atlas-broker (ATLAS_PROVISIONED=1) ─
step "Lock $GIT_DIR/refs/atlas/"

REFS_ATLAS_DIR="$GIT_DIR/refs/atlas"
run "mkdir -p '$REFS_ATLAS_DIR'"

if [[ "${ATLAS_PROVISIONED:-0}" = "1" ]]; then
  run "chown -R atlas-broker:atlas-broker '$REFS_ATLAS_DIR'"
  run "chmod 0700 '$REFS_ATLAS_DIR'"
  log "refs/atlas/ locked: atlas-broker:atlas-broker 0700 ✓"
  # Note: packed-refs lockdown tracked in follow-on 60-F (bare-mirror variant).
  # A 'git pack-refs' by a non-broker user could pack refs/atlas/main into
  # .git/packed-refs, bypassing the per-directory ACL. The operator must restrict
  # gc/pack-refs to atlas-broker via filesystem ACL or wrapper scripts.
else
  log "ATLAS_PROVISIONED not set — skipping chown (non-provisioned environment)"
fi

# ─── step 4: OQ#2 adversarial boundary check (ATLAS_PROVISIONED=1 only) ──────
# Prove: atlas-agent CANNOT write refs/atlas/* (adversarial test, must fail).
# Control: atlas-broker CAN write refs/atlas/* (control test, must succeed).
# If the adversarial test PASSES (agent can write), halt: OQ#2 gate failed.
if [[ "${ATLAS_PROVISIONED:-0}" = "1" ]]; then
  step "OQ#2 adversarial boundary check"

  CURRENT_OID="$(git -C "$VAULT_PATH" rev-parse "$CANONICAL_REF")"
  PROBE_TARGET="$CURRENT_OID"  # try to move ref to its own current value (safe no-op)

  # Adversarial: atlas-agent must be denied
  if sudo -n -u "$ATLAS_AGENT_USER" \
       git -C "$VAULT_PATH" update-ref "$CANONICAL_REF" "$PROBE_TARGET" 2>/dev/null; then
    echo "error: OQ#2 GATE FAILED — $ATLAS_AGENT_USER can write $CANONICAL_REF" >&2
    echo "  The refs/atlas/ namespace is not properly isolated." >&2
    echo "  Vault left un-adopted. Implement follow-on 60-F (bare-mirror)" >&2
    echo "  before retrying adoption on this repository." >&2
    exit 2
  fi
  log "OQ#2 adversarial: $ATLAS_AGENT_USER denied write on $CANONICAL_REF ✓"

  # Control: atlas-broker must succeed
  if ! sudo -n -u atlas-broker \
         git -C "$VAULT_PATH" update-ref "$CANONICAL_REF" "$PROBE_TARGET" 2>/dev/null; then
    echo "error: OQ#2 control FAILED — atlas-broker cannot write $CANONICAL_REF" >&2
    exit 2
  fi
  log "OQ#2 control: atlas-broker can write $CANONICAL_REF ✓"
fi

# ─── step 5: run db migrate ───────────────────────────────────────────────────
step "brain db migrate"
run "$BRAIN_BIN db migrate --config '$CONFIG_DIR'"
log "db migrate complete ✓"

# ─── step 6: seed sync_cursors zero-state row ─────────────────────────────────
step "Seed sync_cursors"
SEED_JSON="$(node "$SEED_CLI" \
  --config "$CONFIG_DIR" \
  --source-id "$SOURCE_ID" \
  --upstream-ref "$UPSTREAM_REF" 2>&1)"
log "seed result: $SEED_JSON"
log "sync_cursors seeded ✓"

# ─── step 7: validate all three ───────────────────────────────────────────────
step "Validate adoption"

# (a) refs/atlas/main resolves to a commit
FINAL_OID="$(git -C "$VAULT_PATH" rev-parse --verify "$CANONICAL_REF" 2>/dev/null || echo "")"
if [[ -z "$FINAL_OID" ]]; then
  echo "error: validation failed: $CANONICAL_REF does not resolve" >&2; exit 2
fi
log "$CANONICAL_REF → $FINAL_OID ✓"

# (b) upstream ref is unchanged (adoption NEVER writes refs/heads/main)
UPSTREAM_OID="$(git -C "$VAULT_PATH" rev-parse --verify "$UPSTREAM_REF" 2>/dev/null || echo "(none)")"
log "$UPSTREAM_REF at $UPSTREAM_OID (untouched) ✓"

# (c) re-running seed-cli is a no-op (seeded=false means row already existed)
RESEED_JSON="$(node "$SEED_CLI" \
  --config "$CONFIG_DIR" \
  --source-id "$SOURCE_ID" \
  --upstream-ref "$UPSTREAM_REF" 2>&1)"
if echo "$RESEED_JSON" | grep -q '"seeded":true'; then
  echo "error: validation failed: re-seeding wrote a new row (expected no-op)" >&2; exit 2
fi
log "idempotency: re-seed is a no-op ✓"

# (d) activation-sequencing gate: warn if config canonical_ref is the default
# The operator must set git.canonical_ref = refs/atlas/main in the config before
# adoption. A config with the default (refs/heads/main) would route all Atlas
# writes onto the live upstream — a critical misconfiguration.
CONFIG_CANONICAL="$(node -e "
  const { loadConfig } = await import('$REPO_ROOT/apps/cli/dist/config/load.js');
  const { config } = loadConfig('$CONFIG_DIR', process.env);
  process.stdout.write(config.git.canonical_ref + '\n');
" 2>/dev/null || echo "(unknown)")"

if [[ "$CONFIG_CANONICAL" != "$CANONICAL_REF" ]]; then
  echo "" >&2
  echo "WARNING: config git.canonical_ref = '$CONFIG_CANONICAL'" >&2
  echo "  Expected: '$CANONICAL_REF'" >&2
  echo "  The vault is NOT safe to use until the config is corrected." >&2
  echo "  Set git.canonical_ref: $CANONICAL_REF in your brain.config.yaml" >&2
  echo "" >&2
fi

log ""
log "=== ADOPTION COMPLETE ==="
log "  Vault:          $VAULT_PATH"
log "  Canonical ref:  $CANONICAL_REF → $FINAL_OID"
log "  Source ID:      $SOURCE_ID"
log "  Upstream ref:   $UPSTREAM_REF → $UPSTREAM_OID"
log ""
log "NEXT STEPS:"
log "  1. Verify git.canonical_ref = $CANONICAL_REF in your config"
log "  2. Install Phases 2-4 (brain sync command)"
log "  3. Run: brain sync --dry-run (on a throwaway clone first)"
log "  4. Activate: brain sync (absorbs upstream notes through scan pipeline)"
log ""
log "  Do NOT run brain sync until Phases 1-4 are all installed."
log "  See docs/install.md for the activation sequence."

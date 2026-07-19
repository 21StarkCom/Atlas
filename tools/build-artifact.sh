#!/usr/bin/env bash
# Build the privileged daemon artifact for provisioning/install-artifact.sh (D16).
#
# Bundles packages/broker's two bins (atlas-broker, atlas-egress) into self-contained
# single-file CJS executables + sha256 manifests. install-artifact.sh verifies the
# hashes and installs root-owned copies into the fixed install dir — the daemons are
# never run privileged from the agent-writable repo dist/.
#
#   tools/build-artifact.sh [out-dir]     # default: <repo>/dist-artifact
#   sudo provisioning/install-artifact.sh <out-dir>
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
OUT="${1:-$ROOT/dist-artifact}"
mkdir -p "$OUT"

# Build the broker package and everything it depends on.
pnpm -C "$ROOT" --filter @atlas/broker... run build

# CJS on purpose: the artifacts are extension-less executables, and node resolves an
# extension-less file's module type from the NEAREST package.json — none exists in the
# install dir, so it defaults to CJS. (Running them from inside this repo mis-parses
# them as ESM because the root package.json is `"type": "module"` — that's expected;
# run the installed copy, or from any dir without a package.json.)
for b in atlas-broker atlas-egress; do
  pnpm -C "$ROOT" --filter @atlas/broker exec esbuild \
    "$ROOT/packages/broker/dist/bin/$b.js" \
    --bundle --platform=node --format=cjs \
    --outfile="$OUT/$b"
  # The artifact is extension-less (a unix executable): ensure the node shebang leads.
  if [ "$(head -c 2 "$OUT/$b")" != "#!" ]; then
    printf '#!/usr/bin/env node\n%s' "$(cat "$OUT/$b")" > "$OUT/$b.tmp"
    mv "$OUT/$b.tmp" "$OUT/$b"
  fi
  chmod 0755 "$OUT/$b"
  (cd "$OUT" && shasum -a 256 "$b" > "$b.sha256")
done

echo "artifact ready: $OUT"
echo "next: sudo provisioning/install-artifact.sh $OUT"

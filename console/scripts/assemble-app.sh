#!/usr/bin/env bash
# Assemble the Atlas Console .app bundle. A SwiftPM executable has no application target/scheme that
# emits a launchable bundle, so this script builds the binary and lays out the bundle by hand.
# Runs correctly from ANY caller cwd (repo root or console/) because it first cd's to its own package root.
set -euo pipefail

cd "$(dirname "$0")/.."
pkg_root="$(pwd)"

# Optional: relocate the SwiftPM build dir (used by tests to avoid lock contention with an outer
# `swift test`). The assembled .app always lands at <pkg_root>/.build/AtlasConsole.app regardless.
scratch_args=()
if [[ -n "${ATLAS_CONSOLE_SCRATCH:-}" ]]; then
	scratch_args=(--scratch-path "${ATLAS_CONSOLE_SCRATCH}")
fi

swift build -c release ${scratch_args[@]+"${scratch_args[@]}"}
bin_dir="$(swift build -c release ${scratch_args[@]+"${scratch_args[@]}"} --show-bin-path)"

app="${pkg_root}/.build/AtlasConsole.app"
rm -rf "${app}"
mkdir -p "${app}/Contents/MacOS" "${app}/Contents/Resources"

cp "${bin_dir}/AtlasConsole" "${app}/Contents/MacOS/AtlasConsole"
chmod +x "${app}/Contents/MacOS/AtlasConsole"

cp "${pkg_root}/Resources/Info.plist" "${app}/Contents/Info.plist"
printf 'APPL????' > "${app}/Contents/PkgInfo"

# Ad-hoc codesign, matching the build-from-source posture.
codesign --force --sign - "${app}"

echo "Assembled ${app}"

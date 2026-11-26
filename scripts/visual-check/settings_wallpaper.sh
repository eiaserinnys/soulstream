#!/usr/bin/env bash
set -euo pipefail
if [ "$#" -ne 1 ]; then echo "usage: $0 <output-dir>" >&2; exit 2; fi
root=$(dirname "$(dirname "$(dirname "$(realpath "${BASH_SOURCE[0]}")")")")
baseline_dir=$(mktemp -d)
trap 'rm -rf "$baseline_dir"' EXIT
baseline=$(git -C "$root" merge-base HEAD origin/main)
git -C "$root" archive "$baseline" | tar -x -C "$baseline_dir"
corepack pnpm@10.32.1 -C "$baseline_dir" install --frozen-lockfile
GIT_DIR="$(git -C "$root" rev-parse --absolute-git-dir)" corepack pnpm -C "$baseline_dir/unified-dashboard" run build
corepack pnpm -C "$root/unified-dashboard" run build
python3 -P "$root/scripts/visual-check/settings_wallpaper.py" --output "$1" --baseline-dist "$baseline_dir/unified-dashboard/dist"

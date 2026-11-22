#!/usr/bin/env bash
set -euo pipefail
if [ "$#" -ne 1 ]; then echo "usage: $0 <output-dir>" >&2; exit 2; fi
root=$(dirname "$(dirname "$(dirname "$(realpath "${BASH_SOURCE[0]}")")")")
corepack pnpm -C "$root/unified-dashboard" run build
python3 -P "$root/scripts/visual-check/session_files_panel.py" --output "$1"

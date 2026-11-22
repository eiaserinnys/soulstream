#!/usr/bin/env bash
set -euo pipefail
output_dir="${1:?출력 폴더가 필요합니다}"
node soul-app/scripts/export-components.mjs
python3 -P soul-app/scripts/capture-session-files.py --out "$output_dir"

#!/usr/bin/env bash
# CI 게이트 — schema 정본을 다시 생성하여 generated/ 과의 diff가 0인지 확인.
set -euo pipefail

HERE="$(cd "$(dirname "$0")/.." && pwd)"

bash "$HERE/scripts/generate.sh"

# git diff --exit-code: 차이가 있으면 1 (CI 실패), 없으면 0.
if ! git -C "$HERE" diff --exit-code -- generated/; then
  echo "" >&2
  echo "ERROR: generated/ 산출물이 src/upstream.schema.json 과 동기화되지 않았습니다." >&2
  echo "" >&2
  echo "  로컬에서 다음을 실행한 뒤 결과를 커밋하세요:" >&2
  echo "    bash packages/wire-schema/scripts/generate.sh" >&2
  exit 1
fi

echo "[wire-schema] verify OK — schema ↔ generated 정합."

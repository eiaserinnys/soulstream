#!/usr/bin/env bash
# 설정 노드 구역 시각 검수를 한 번에 돌린다. vite 개발 서버는 이 스크립트 안에서 띄우고 trap으로 거둔다.
#
#   unified-dashboard/scripts/visual-check/settings_nodes_run.sh <출력 폴더> [운영 briefs JSON]
#
# 두 번째 인자를 주면 운영 /cogito/briefs 응답(노드 4개)까지 settings_nodes_real.py로 잰다.
set -u

HERE="$(cd "$(dirname "$0")" && pwd)"
REPO="$(cd "$HERE/../../.." && pwd)"
OUT="${1:?출력 폴더를 주세요}"
REAL="${2:-}"
PORT="${PORT:-5183}"
LOG="$OUT/vite.log"

mkdir -p "$OUT"
cd "$REPO" || exit 1

VITE_API_BASE=http://127.0.0.1:9 pnpm --dir unified-dashboard exec vite \
  --host 127.0.0.1 --port "$PORT" --strictPort > "$LOG" 2>&1 &
VPID=$!
cleanup() {
  pkill -P "$VPID" 2>/dev/null
  kill "$VPID" 2>/dev/null
  wait "$VPID" 2>/dev/null
}
trap cleanup EXIT

for _ in $(seq 1 90); do
  if curl -s -o /dev/null "http://127.0.0.1:$PORT/"; then
    break
  fi
  sleep 1
done
curl -s -o /dev/null -w "vite %{http_code}\n" "http://127.0.0.1:$PORT/"

status=0
python3 -P "$HERE/settings_nodes.py" "http://127.0.0.1:$PORT" "$OUT" || status=1
if [ -n "$REAL" ]; then
  python3 -P "$HERE/settings_nodes_real.py" "http://127.0.0.1:$PORT" "$OUT/real" "$REAL" || status=1
fi
exit "$status"

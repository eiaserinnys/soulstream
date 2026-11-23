#!/bin/sh
# 카드 #1808 스트리밍 마크다운 시각·성능 검수 묶음.
#
#   sh unified-dashboard/scripts/visual-check/run_stream_markdown_checks.sh <출력 폴더>
#
# 127.0.0.1:5288에 대시보드 vite 개발 서버를 띄우고, 좁은 폭·넓은 폭 시각 검수
# (markdown_narrow.py --mode after)와 2만 자 스트리밍 성능 측정
# (stream_markdown_perf.py)을 차례로 돌린 뒤 서버를 거둔다. 둘 중 하나라도 실패하면
# 0이 아닌 코드로 끝난다.
set -u

HERE=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
REPO=$(CDPATH= cd -- "$HERE/../../.." && pwd)
OUT="${1:?출력 폴더를 주세요}"
PORT=5288
LOG="$OUT/vite.log"

mkdir -p "$OUT"

# 이 포트에 이미 리스너가 있으면, 남의 서버를 상대로 재지 않도록 vite를 띄우기 전에 끝낸다.
if ! python3 -I - "$PORT" <<'PY'
import socket
import sys

port = int(sys.argv[1])
sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
sock.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
try:
    sock.bind(("127.0.0.1", port))
except OSError as error:
    print(f"port {port} is already in use: {error}", file=sys.stderr)
    sys.exit(1)
finally:
    sock.close()
PY
then
  echo "refusing to start vite: 127.0.0.1:$PORT is already taken" >&2
  exit 1
fi

VITE_API_BASE=http://127.0.0.1:9 corepack pnpm --dir "$REPO/unified-dashboard" exec vite \
  --host 127.0.0.1 --port "$PORT" --strictPort > "$LOG" 2>&1 &
VPID=$!
cleanup() {
  pkill -P "$VPID" 2>/dev/null
  kill "$VPID" 2>/dev/null
  wait "$VPID" 2>/dev/null
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

ready=0
i=0
while [ "$i" -lt 90 ]; do
  if ! kill -0 "$VPID" 2>/dev/null; then
    echo "vite exited before listening on 127.0.0.1:$PORT" >&2
    tail -20 "$LOG" >&2
    exit 1
  fi
  if curl -fsS -o /dev/null "http://127.0.0.1:$PORT/scripts/visual-check/markdown-narrow-fixture.html"; then
    ready=1
    break
  fi
  i=$((i + 1))
  sleep 1
done
if [ "$ready" -ne 1 ]; then
  echo "vite did not listen on 127.0.0.1:$PORT within 90s" >&2
  tail -20 "$LOG" >&2
  exit 1
fi

status=0
python3 -P "$HERE/markdown_narrow.py" "http://127.0.0.1:$PORT" "$OUT/after" --mode after || status=1
python3 -P "$HERE/stream_markdown_perf.py" "http://127.0.0.1:$PORT" "$OUT/perf" || status=1
exit "$status"

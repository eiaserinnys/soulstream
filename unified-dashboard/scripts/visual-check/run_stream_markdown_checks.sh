#!/bin/sh
# 카드 #1808 스트리밍 마크다운 시각·성능 검수 묶음.
#
#   sh unified-dashboard/scripts/visual-check/run_stream_markdown_checks.sh <출력 폴더>
#
# 1) 127.0.0.1:5288에 대시보드 vite 개발 서버를 띄워 좁은 폭·넓은 폭 시각 검수
#    (markdown_narrow.py --mode after)를 돌린다.
# 2) 성능 표본은 운영과 같은 vite build 묶음(vite.perf.config.ts, 단위 폴더 work/ 아래)으로
#    만들어 127.0.0.1:5289의 vite preview로 띄우고, stream_markdown_perf.py로 p95와
#    .wasm 요청 수를 잰다.
# 어느 단계든 실패하면 0이 아닌 코드로 끝난다.
set -u

HERE=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
REPO=$(CDPATH= cd -- "$HERE/../../.." && pwd)
OUT="${1:?출력 폴더를 주세요}"
UNIT_DIR=$(dirname "$OUT")
BUNDLE=${STREAM_MARKDOWN_PERF_BUNDLE_DIR:-"$UNIT_DIR/work/stream-markdown-perf-bundle"}
PORT=5288
PREVIEW_PORT=5289
DEV_LOG="$OUT/vite.log"
BUILD_LOG="$OUT/vite-build.log"
PREVIEW_LOG="$OUT/vite-preview.log"

mkdir -p "$OUT"

# 이 포트에 이미 리스너가 있으면, 남의 서버를 상대로 재지 않도록 서버를 띄우기 전에 끝낸다.
port_free() {
  python3 -I - "$1" <<'PY'
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
}

for port in "$PORT" "$PREVIEW_PORT"; do
  if ! port_free "$port"; then
    echo "refusing to start: 127.0.0.1:$port is already taken" >&2
    exit 1
  fi
done

DEV_PID=
PREVIEW_PID=

stop_dev() {
  if [ -n "$DEV_PID" ]; then
    pkill -P "$DEV_PID" 2>/dev/null
    kill "$DEV_PID" 2>/dev/null
    wait "$DEV_PID" 2>/dev/null
    DEV_PID=
  fi
}

stop_preview() {
  if [ -n "$PREVIEW_PID" ]; then
    pkill -P "$PREVIEW_PID" 2>/dev/null
    kill "$PREVIEW_PID" 2>/dev/null
    wait "$PREVIEW_PID" 2>/dev/null
    PREVIEW_PID=
  fi
}

cleanup() {
  stop_preview
  stop_dev
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

wait_for_http() { # url pid log label
  i=0
  while [ "$i" -lt 90 ]; do
    if ! kill -0 "$2" 2>/dev/null; then
      echo "$4: 서버가 뜨기 전에 끝났습니다" >&2
      tail -20 "$3" >&2
      return 1
    fi
    if curl -fsS -o /dev/null "$1"; then
      return 0
    fi
    i=$((i + 1))
    sleep 1
  done
  echo "$4: 90초 안에 응답하지 않습니다" >&2
  tail -20 "$3" >&2
  return 1
}

status=0

# 1) 개발 서버 위 시각 검수.
VITE_API_BASE=http://127.0.0.1:9 corepack pnpm --dir "$REPO/unified-dashboard" exec vite \
  --host 127.0.0.1 --port "$PORT" --strictPort > "$DEV_LOG" 2>&1 &
DEV_PID=$!
if wait_for_http "http://127.0.0.1:$PORT/scripts/visual-check/markdown-narrow-fixture.html" \
  "$DEV_PID" "$DEV_LOG" "vite 개발 서버"; then
  python3 -P "$HERE/markdown_narrow.py" "http://127.0.0.1:$PORT" "$OUT/after" --mode after || status=1
else
  status=1
fi
stop_dev

# 2) 운영과 같은 vite build 묶음을 만들어 vite preview 위에서 성능을 잰다.
rm -rf "$BUNDLE"
mkdir -p "$BUNDLE"
echo "perf: 운영과 같은 vite build 묶음을 만듭니다 — $BUNDLE"
if STREAM_MARKDOWN_PERF_OUT="$BUNDLE" VITE_API_BASE=http://127.0.0.1:9 \
  corepack pnpm --dir "$REPO/unified-dashboard" exec vite build \
    --config scripts/visual-check/vite.perf.config.ts \
    --outDir "$BUNDLE" --emptyOutDir > "$BUILD_LOG" 2>&1
then
  SAMPLE="$BUNDLE/scripts/visual-check/stream-markdown-perf.html"
  if [ ! -f "$SAMPLE" ]; then
    echo "perf: 표본 묶음에 stream-markdown-perf.html이 없습니다: $SAMPLE" >&2
    tail -40 "$BUILD_LOG" >&2
    status=1
  else
    STREAM_MARKDOWN_PERF_OUT="$BUNDLE" VITE_API_BASE=http://127.0.0.1:9 \
      corepack pnpm --dir "$REPO/unified-dashboard" exec vite preview \
        --config scripts/visual-check/vite.perf.config.ts \
        --outDir "$BUNDLE" \
        --host 127.0.0.1 --port "$PREVIEW_PORT" --strictPort > "$PREVIEW_LOG" 2>&1 &
    PREVIEW_PID=$!
    if wait_for_http "http://127.0.0.1:$PREVIEW_PORT/scripts/visual-check/stream-markdown-perf.html" \
      "$PREVIEW_PID" "$PREVIEW_LOG" "vite preview"; then
      python3 -P "$HERE/stream_markdown_perf.py" "http://127.0.0.1:$PREVIEW_PORT" "$OUT/perf" || status=1
    else
      status=1
    fi
    stop_preview
  fi
else
  echo "perf: 표본 묶음 빌드가 실패했습니다" >&2
  tail -40 "$BUILD_LOG" >&2
  status=1
fi

exit "$status"

#!/usr/bin/env bash
# 설정 노드 구역 시각 검수를 한 번에 돌린다. vite 개발 서버는 이 스크립트 안에서 띄우고 trap으로 거둔다.
#
#   unified-dashboard/scripts/visual-check/settings_nodes_run.sh <출력 폴더> [운영 briefs JSON]
#
# 두 번째 인자를 주면 운영 /cogito/briefs 응답(노드 4개)까지 settings_nodes_real.py로 잰다.
# 포트는 PORT로 바꾼다. 기본 5183은 운영 서비스가 쓰지 않는 값이다.
set -u

HERE="$(cd "$(dirname "$0")" && pwd)"
REPO="$(cd "$HERE/../../.." && pwd)"
OUT="${1:?출력 폴더를 주세요}"
REAL="${2:-}"
PORT="${PORT:-5183}"
LOG="$OUT/vite.log"

cd "$REPO" || exit 1

# 이 포트에 이미 리스너가 있으면, 남의 서버를 상대로 재지 않도록 vite를 띄우기 전에 끝낸다.
# vite(node)처럼 TIME_WAIT은 허용하되, 실제 리스너가 있으면 bind가 실패한다.
port_is_free() {
  python3 -I - "$PORT" <<'PY'
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

if ! port_is_free; then
  echo "refusing to start vite: 127.0.0.1:$PORT is already taken" >&2
  exit 1
fi

mkdir -p "$OUT"

VITE_API_BASE=http://127.0.0.1:9 pnpm --dir unified-dashboard exec vite \
  --host 127.0.0.1 --port "$PORT" --strictPort > "$LOG" 2>&1 &
VPID=$!
cleanup() {
  pkill -P "$VPID" 2>/dev/null
  kill "$VPID" 2>/dev/null
  wait "$VPID" 2>/dev/null
}
trap cleanup EXIT

ready=0
for _ in $(seq 1 90); do
  if ! kill -0 "$VPID" 2>/dev/null; then
    echo "vite exited before listening on 127.0.0.1:$PORT" >&2
    tail -20 "$LOG" >&2
    exit 1
  fi
  if curl -s -o /dev/null "http://127.0.0.1:$PORT/"; then
    ready=1
    break
  fi
  sleep 1
done
if [ "$ready" -ne 1 ]; then
  echo "vite did not listen on 127.0.0.1:$PORT within 90s" >&2
  tail -20 "$LOG" >&2
  exit 1
fi

# 응답하는 서버가 이 스크립트가 띄운 vite인지 확인한다.
if ! python3 -I - "$PORT" "$VPID" <<'PY'
import re
import subprocess
import sys

port = int(sys.argv[1])
vpid = int(sys.argv[2])
result = subprocess.run(["ss", "-ltnpH", f"sport = :{port}"], capture_output=True, text=True)
lines = [line for line in result.stdout.splitlines() if line.strip()]
pids = {int(match.group(1)) for line in lines for match in re.finditer(r"pid=(\d+)", line)}
if not pids:
    print(f"cannot identify the listener on 127.0.0.1:{port}", file=sys.stderr)
    for line in lines:
        print(line, file=sys.stderr)
    sys.exit(1)


def ancestors(pid: int) -> list[int]:
    chain: list[int] = []
    while pid > 1:
        chain.append(pid)
        try:
            with open(f"/proc/{pid}/stat", encoding="utf-8") as stat:
                fields = stat.read().rsplit(")", 1)[1].split()
        except (OSError, IndexError):
            break
        pid = int(fields[1])
    return chain


ours = sorted(pid for pid in pids if vpid in ancestors(pid))
if not ours:
    print(f"listener pids {sorted(pids)} do not descend from vite pid {vpid}", file=sys.stderr)
    for line in lines:
        print(line, file=sys.stderr)
    sys.exit(1)
print(f"vite pid {ours[0]} listening on 127.0.0.1:{port} (script pid {vpid})")
PY
then
  exit 1
fi

status=0
python3 -P "$HERE/settings_nodes.py" "http://127.0.0.1:$PORT" "$OUT" || status=1
if [ -n "$REAL" ]; then
  python3 -P "$HERE/settings_nodes_real.py" "http://127.0.0.1:$PORT" "$OUT/real" "$REAL" || status=1
fi
exit "$status"

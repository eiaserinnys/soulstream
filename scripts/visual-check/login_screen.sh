#!/usr/bin/env bash
# 설치 비밀번호 로그인 화면 시각 검수 (카드 #1787 U1).
# 대시보드를 내보내고, 이 스크립트의 API 대역과 함께 서빙해 Playwright로 재고 캡처한다.
# 단언이 하나라도 실패하면 0이 아닌 코드로 끝난다.
#
# 사용: bash scripts/visual-check/login_screen.sh <password|google> <출력 폴더>
set -euo pipefail

if [ "$#" -lt 2 ]; then
  echo "usage: $0 <password|google> <output-dir>" >&2
  exit 2
fi

mode=$1
out_dir=$2
root=$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)

echo "[login-screen] 대시보드 내보내기"
corepack pnpm -C "$root/unified-dashboard" run build

echo "[login-screen] 측정과 캡처 ($mode)"
python3 -P "$root/scripts/visual-check/login_screen.py" --mode "$mode" --output "$out_dir"

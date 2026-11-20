#!/usr/bin/env bash
# 세션 통계 제어 줄 시각 검수 (카드 #1752).
# 검수 번들을 내보내고, 빈 포트로 서빙해 Playwright로 재고 캡처한 뒤 서버를 닫는다.
# 단언이 하나라도 실패하면 0이 아닌 코드로 끝난다.
#
# 사용: bash scripts/visual-check/usage_stats_controls.sh <출력 폴더> [before|after]
set -euo pipefail

if [ "$#" -lt 1 ]; then
  echo "usage: $0 <output-dir> [before|after]" >&2
  exit 2
fi

out_dir=$1
phase=${2:-after}
root=$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)

echo "[usage-stats] 검수 번들 내보내기"
# 격리 실행 상자는 홈 디렉토리가 읽기 전용이라 Expo 텔레메트리 상태 파일 쓰기를 끈다.
EXPO_NO_TELEMETRY=1 npm --prefix "$root/soul-app" run export:components

echo "[usage-stats] 측정과 캡처 ($phase)"
python3 -P "$root/scripts/visual-check/usage_stats_controls.py" --output "$out_dir/$phase"

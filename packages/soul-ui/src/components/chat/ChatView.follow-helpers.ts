/**
 * ChatView auto-follow 결정 헬퍼 (순수 함수)
 *
 * Virtuoso의 atBottomStateChange가 reportedAtBottom=false를 보내더라도,
 * 세션 전환 후 안정화 시점까지는 follow 상태를 유지해야 한다.
 *
 * 배경:
 * - Phase 1·2로 SSE가 더 이상 풀히스토리를 흘리지 않으므로 대부분의
 *   "auto-follow가 풀리는" 증상은 사라진다.
 * - 다만 long-running 라이브 세션에서 user_message → assistant_message 도착
 *   사이의 Virtuoso measure 단계에서 일시적으로 atBottom=false가 보고될 수
 *   있고, 이로 인해 setIsFollowing(false)이 잘못 적용되어 follow가 풀린다.
 * - 세션 전환 직후 첫 안정화 윈도(기본 300ms) 동안은 false 보고를 무시하여
 *   measure 깜빡임을 흡수한다.
 */

/**
 * Virtuoso atBottomStateChange 보고를 받아 다음 isFollowing 값을 결정한다.
 *
 * @param reportedAtBottom Virtuoso가 보고한 atBottom 값
 * @param sessionMs 세션 전환 후 경과 시간 (ms). 0 이상.
 * @param settleThresholdMs 안정화 판정 임계값. 기본 300ms.
 * @returns 다음 isFollowing 값. null이면 변경하지 않음 (false 보고를 무시).
 *
 * 동작:
 * - atBottom=true: 항상 true 반환 (follow 켬)
 * - atBottom=false + sessionMs >= settle: false 반환 (사용자가 위로 스크롤)
 * - atBottom=false + sessionMs < settle: null 반환 (measure 깜빡임으로 간주, 무시)
 */
export function decideFollowOnAtBottomChange(
  reportedAtBottom: boolean,
  sessionMs: number,
  settleThresholdMs: number = SESSION_SETTLE_THRESHOLD_MS,
): boolean | null {
  if (!reportedAtBottom && sessionMs < settleThresholdMs) {
    return null;
  }
  return reportedAtBottom;
}

/**
 * 세션 전환 후 Virtuoso가 안정화되었다고 판정하는 시간 임계값 (ms).
 *
 * 짧으면 깜빡임을 못 잡고, 길면 사용자가 빠르게 위로 스크롤해도 follow가
 * 잠시 유지되어 어색해진다. 300ms는 typical Virtuoso initial measure에
 * 충분하면서 사용자 인지 한계 아래에 있는 보수적 값.
 */
export const SESSION_SETTLE_THRESHOLD_MS = 300;

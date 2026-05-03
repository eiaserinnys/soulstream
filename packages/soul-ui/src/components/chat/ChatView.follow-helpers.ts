/**
 * ChatView auto-follow 결정 헬퍼 (순수 함수)
 *
 * Virtuoso의 atBottomStateChange는 두 가지 측정 깜빡임을 만들 수 있다:
 *
 * 1. 세션 전환 직후의 false 깜빡임 — initial measure 단계에서 일시적으로
 *    atBottom=false가 보고됨. 처음 SESSION_SETTLE_THRESHOLD_MS(300ms) 동안은
 *    false 보고를 무시한다.
 *
 * 2. prepend 직후의 true 깜빡임 — 사용자가 위로 스크롤하여 isFollowing=false인
 *    상태에서 startReached → 페이지 prepend가 일어나면 firstItemIndex 변경 +
 *    scrollHeight 재계산 도중 한 프레임 동안 atBottom=true가 잘못 보고될 수 있다.
 *    이 시점에 setIsFollowing(true)이 발화되면 followOutput="auto"로 켜져 다음
 *    라이브 SSE 도착 시 강제로 맨 아래 점프 — 사용자 체감 결함.
 *    chatLastPrependAtMs 기준으로 PREPEND_SETTLE_THRESHOLD_MS(500ms) 동안은
 *    true 보고를 무시한다.
 *
 * 두 가드는 모두 false-negative를 회피하는 보수적 windowing이다 (사용자가
 * 의도한 동작을 1회 놓치더라도 다음 콜백에서 회복).
 */

/**
 * 세션 전환 후 Virtuoso가 안정화되었다고 판정하는 시간 임계값 (ms).
 *
 * 짧으면 깜빡임을 못 잡고, 길면 사용자가 빠르게 위로 스크롤해도 follow가
 * 잠시 유지되어 어색해진다. 300ms는 typical Virtuoso initial measure에
 * 충분하면서 사용자 인지 한계 아래에 있는 보수적 값.
 */
export const SESSION_SETTLE_THRESHOLD_MS = 300;

/**
 * prepend 직후 Virtuoso firstItemIndex 재계산이 안정화되었다고 판정하는 시간 임계값 (ms).
 *
 * react-virtuoso는 firstItemIndex 변경 + scrollHeight 재계산 단계에서 한 프레임
 * 정도 atBottom 판정이 흔들릴 수 있다. 500ms는 페이지 prepend 후 측정 안정화에
 * 충분하면서 사용자가 의도적으로 끝까지 스크롤한 후 약간의 지연으로 follow가
 * 켜지는 어색함을 피할 수 있는 보수적 값.
 */
export const PREPEND_SETTLE_THRESHOLD_MS = 500;

/**
 * Virtuoso atBottomStateChange 보고를 받아 다음 isFollowing 값을 결정한다.
 *
 * @param reportedAtBottom Virtuoso가 보고한 atBottom 값
 * @param sessionMs 세션 전환 후 경과 시간 (ms). 0 이상.
 * @param prependAgeMs 마지막 prepend 시각으로부터 경과 시간 (ms).
 *   null이면 직전 prepend 없음 (또는 충분히 오래 전) — true 보고를 즉시 신뢰.
 * @param settleThresholdMs 세션 안정화 판정 임계값. 기본 300ms.
 * @param prependSettleMs prepend 안정화 판정 임계값. 기본 500ms.
 * @returns 다음 isFollowing 값. null이면 변경하지 않음 (false/true 보고를 무시).
 *
 * 동작:
 * - atBottom=false + sessionMs < settle: null (세션 measure 깜빡임 무시)
 * - atBottom=false + sessionMs >= settle: false (사용자 스크롤 인식)
 * - atBottom=true + prependAgeMs < prependSettle: null (prepend 직후 깜빡임 무시)
 * - atBottom=true + prependAgeMs null/>= prependSettle: true (follow 켬)
 *
 * Virtuoso atBottomStateChange는 useEffect에서 발화되므로 React 리렌더 커밋
 * 이후 호출이 보장된다 — store의 chatLastPrependAtMs가 업데이트된 뒤
 * ChatView 리렌더 → atBottomStateChange 콜백 순서로 흐르므로 가드는 의도대로
 * 동작한다.
 */
export function decideFollowOnAtBottomChange(
  reportedAtBottom: boolean,
  sessionMs: number,
  prependAgeMs: number | null = null,
  settleThresholdMs: number = SESSION_SETTLE_THRESHOLD_MS,
  prependSettleMs: number = PREPEND_SETTLE_THRESHOLD_MS,
): boolean | null {
  // false 보고: 세션 전환 직후 measure 깜빡임 가드 (기존 동작).
  if (!reportedAtBottom && sessionMs < settleThresholdMs) return null;
  // true 보고: prepend 직후 firstItemIndex 재계산 깜빡임 가드 (신규).
  if (reportedAtBottom && prependAgeMs !== null && prependAgeMs < prependSettleMs) return null;
  return reportedAtBottom;
}

/**
 * ChatView 스크롤 UX 관련 순수 헬퍼.
 *
 * 실효 로직을 React 외부에서 테스트 가능하게 분리한다.
 * - 초기 하단 이동 여부 결정
 * - prepend 후 scrollTop 보정량 계산
 *
 * 렌더·effect 래핑은 ChatView.tsx에 남기고, 이 파일은 결정 로직만 담는다.
 */

/**
 * 세션 전환 후 첫 히스토리 로드 완료 시점에 하단 이동을 실행해야 하는지 판정.
 *
 * 조건:
 *  1) 활성 세션이 존재
 *  2) grouped(렌더 대상)가 1개 이상
 *  3) 히스토리 fetch 중이 아님
 *  4) 해당 sessionKey에서 아직 초기 하단 이동을 수행하지 않음
 */
export function shouldRunInitialBottomScroll(params: {
  sessionKey: string | null | undefined;
  groupedLength: number;
  historyLoading: boolean;
  lastScrolledSessionKey: string | null;
}): boolean {
  if (!params.sessionKey) return false;
  if (params.groupedLength === 0) return false;
  if (params.historyLoading) return false;
  if (params.lastScrolledSessionKey === params.sessionKey) return false;
  return true;
}

/**
 * 과거 메시지 prepend 후 scrollTop 보정량(delta)을 계산한다.
 *
 * 입력:
 *  - snapshot: prepend 호출 직전에 찍은 `{scrollHeight, messagesLength}` 스냅샷
 *  - current:  prepend가 반영된 이후의 실제 값
 *
 * 반환:
 *  - 양수 delta: scrollTop을 `+delta` 만큼 밀어야 시각적 위치가 고정된다
 *  - null: 보정이 필요 없거나 불가능한 상태 (스냅샷 없음 / messages 증가 없음 / delta ≤ 0)
 *
 * 단일 책임: delta 계산만. scrollTop 변경은 호출부가 담당한다.
 */
export function computePrependAnchorDelta(params: {
  snapshot: { scrollHeight: number; messagesLength: number } | null;
  currentScrollHeight: number;
  currentMessagesLength: number;
}): number | null {
  const { snapshot, currentScrollHeight, currentMessagesLength } = params;
  if (!snapshot) return null;
  if (currentMessagesLength <= snapshot.messagesLength) return null;
  const delta = currentScrollHeight - snapshot.scrollHeight;
  if (delta <= 0) return null;
  return delta;
}

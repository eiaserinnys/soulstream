/**
 * ChatView.reverse-helpers — virtuoso alignToBottom 재설계 전용 순수 함수
 *
 * 설계 결정:
 * - `alignToBottom + followOutput="auto"`를 쓰려면 "오래된 메시지 prepend 시 기존
 *   항목 인덱스가 어긋나지 않도록" virtuoso 권장 패턴 `firstItemIndex`를 사용한다.
 * - 새 세션 진입 시 `START_INDEX(= 10_000)` 에서 출발하고, prepend마다 N만큼 차감한다.
 *   (grouped 배열 자체는 오름차순 유지)
 * - focusEventId 하이라이트는 itemsRendered 콜백에서 DOM 쿼리하여 적용하는데,
 *   그 타겟 인덱스를 구할 때 본 헬퍼를 공유한다.
 *
 * 순수 함수로 분리하여 단위 테스트를 먼저 고정한 뒤 ChatView 본체를 재작성한다.
 */

import type { MessageOrGroup } from "./grouping";

/** virtuoso 권장 패턴: 큰 시작 인덱스에서 prepend 때마다 차감 */
export const START_INDEX = 10_000;

/**
 * virtuoso `firstItemIndex`로 전달할 값.
 * prepend된 누적 개수만큼 `START_INDEX`에서 차감한다.
 */
export const computeFirstItemIndex = (prependedCount: number): number =>
  START_INDEX - prependedCount;

/**
 * `grouped[]`에서 `focusEventId`와 매칭되는 인덱스를 찾는다.
 * 매칭 실패 시 -1.
 *
 * 매칭 규칙:
 * - `single`: msg.eventId === focusEventId OR msg.treeNodeId.endsWith(`-${focusEventId}`)
 * - `tool-group`: messages 중 하나라도 위 조건 충족
 */
export const findFocusIndex = (
  grouped: MessageOrGroup[],
  focusEventId: number | null,
): number => {
  if (focusEventId == null) return -1;
  return grouped.findIndex((item) => {
    if (item.type === "tool-group") {
      return item.messages.some(
        (m) =>
          m.eventId === focusEventId ||
          (m.treeNodeId?.endsWith(`-${focusEventId}`) ?? false),
      );
    }
    return (
      item.msg.eventId === focusEventId ||
      (item.msg.treeNodeId?.endsWith(`-${focusEventId}`) ?? false)
    );
  });
};

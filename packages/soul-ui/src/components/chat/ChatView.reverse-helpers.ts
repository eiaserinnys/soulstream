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

import type { ChatTimelineItem } from "./ChatView.thinking-indicator";

/** virtuoso 권장 패턴: 큰 시작 인덱스에서 prepend 때마다 차감 */
export const START_INDEX = 10_000;

/**
 * virtuoso `firstItemIndex`로 전달할 값.
 * prepend된 누적 개수만큼 `START_INDEX`에서 차감한다.
 */
export const computeFirstItemIndex = (prependedCount: number): number =>
  START_INDEX - prependedCount;

/** Virtuoso와 viewport 보정이 공유하는 안정 키. */
export function messageOrGroupKey(item: ChatTimelineItem): string {
  if (item.type === "thinking-indicator") return "chat-thinking-indicator";
  if (item.type === "summary-group") return messageOrGroupKey(item.anchor);
  return item.type === "tool-group"
    ? `tg-${item.messages[item.messages.length - 1].treeNodeId}`
    : item.msg.treeNodeId;
}

/**
 * 같은 논리 행이라도 표시 내용이 바뀌면 follow 수명주기는 다시 실행해야 한다.
 * stable key나 행 수만 비교하면 text_delta처럼 key를 유지한 채 높이가 늘어나는
 * 갱신을 숨겨 버린다. flattenTree가 보존하는 ChatMessage reference를 표시 계약으로
 * 사용해, 숨겨진 summary/duplicate와 실제 렌더 갱신을 구분한다.
 */
export function areMessageGroupsRenderEqual(
  previous: ChatTimelineItem[],
  next: ChatTimelineItem[],
): boolean {
  if (previous.length !== next.length) return false;
  return previous.every((item, index) => {
    const nextItem = next[index];
    if (item.type !== nextItem?.type) return false;
    if (item.type === "thinking-indicator" && nextItem.type === "thinking-indicator") {
      return true;
    }
    if (item.type === "single" && nextItem.type === "single") {
      return item.msg === nextItem.msg;
    }
    if (item.type === "tool-group" && nextItem.type === "tool-group") {
      return (
        item.messages.length === nextItem.messages.length &&
        item.messages.every(
          (message, messageIndex) =>
            message === nextItem.messages[messageIndex],
        )
      );
    }
    if (item.type === "summary-group" && nextItem.type === "summary-group") {
      return (
        areMessageGroupsRenderEqual([item.anchor], [nextItem.anchor]) &&
        item.summaries.length === nextItem.summaries.length &&
        item.summaries.every(
          (summary, summaryIndex) => summary === nextItem.summaries[summaryIndex],
        )
      );
    }
    return false;
  });
}

/**
 * 같은 first-visible key가 새 배열에서 뒤로 이동한 양을 반환한다.
 * 음수(앞 행 제거), key 부재, 또는 first-visible 뒤 삽입은 좌표를 바꾸지 않는다.
 */
export function countInsertedRowsBeforeKey(
  previousKeys: string[],
  nextKeys: string[],
  firstVisibleKey: string | null,
): number {
  if (firstVisibleKey === null) return 0;
  const previousIndex = previousKeys.indexOf(firstVisibleKey);
  const nextIndex = nextKeys.indexOf(firstVisibleKey);
  if (previousIndex < 0 || nextIndex < 0) return 0;
  return Math.max(0, nextIndex - previousIndex);
}

export function getInitialTopMostItemIndex(
  itemCount: number,
): { index: number; align: "end" } | 0 {
  return itemCount > 0 ? { index: itemCount - 1, align: "end" } : 0;
}

export type BottomScrollLocation = { index: "LAST"; align: "end" };

export function getBottomScrollLocation(
  itemCount: number,
): BottomScrollLocation | null {
  if (itemCount <= 0) return null;
  return { index: "LAST", align: "end" };
}

/**
 * `grouped[]`에서 `focusEventId`와 매칭되는 인덱스를 찾는다.
 * 매칭 실패 시 -1.
 *
 * 매칭 규칙:
 * - `single`: msg.eventId === focusEventId OR msg.treeNodeId.endsWith(`-${focusEventId}`)
 * - `tool-group`: messages 중 하나라도 위 조건 충족
 */
export const findFocusIndex = (
  grouped: ChatTimelineItem[],
  focusEventId: number | null,
): number => {
  if (focusEventId == null) return -1;
  return grouped.findIndex((item) => {
    if (item.type === "thinking-indicator") return false;
    if (item.type === "summary-group") {
      return findFocusIndex(
        [item.anchor, ...item.summaries.map((msg) => ({ type: "single" as const, msg }))],
        focusEventId,
      ) >= 0;
    }
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

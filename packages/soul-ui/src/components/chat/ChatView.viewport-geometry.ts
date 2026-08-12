export const CHAT_ITEM_KEY_SELECTOR = "[data-chat-item-key]";

export interface ChatViewportAnchor {
  key: string;
  offset: number;
  scrollHeight: number;
  scrollTop: number;
}

/**
 * 과거 히스토리가 현재 화면과 작은 reverse-scroll 여유까지 채웠는지 판정한다.
 * null은 scroller가 아직 layout되지 않아 측정할 수 없다는 뜻이다.
 */
export function hasFilledHistoryViewport(
  scroller: HTMLElement,
  marginPx: number,
): boolean | null {
  if (scroller.clientHeight <= 0) return null;
  return scroller.scrollHeight > scroller.clientHeight + marginPx;
}

function markerBounds(marker: HTMLElement): { top: number; bottom: number } | null {
  const rows = Array.from(marker.children).filter(
    (row): row is HTMLElement => row instanceof HTMLElement,
  );
  if (rows.length === 0) return null;
  const rects = rows.map((row) => row.getBoundingClientRect());
  return {
    top: Math.min(...rects.map((row) => row.top)),
    bottom: Math.max(...rects.map((row) => row.bottom)),
  };
}

/**
 * Virtuoso의 렌더 범위가 아니라 실제 scroller viewport와 교차하는 첫 행을 찾는다.
 * data marker는 display:contents이므로 레이아웃을 바꾸지 않고, 바로 아래 제품 행의
 * 공개 DOM geometry만 읽는다.
 */
export function measureFirstVisuallyIntersectingItem(
  scroller: HTMLElement,
): ChatViewportAnchor | null {
  const viewport = scroller.getBoundingClientRect();
  let first: { key: string; top: number } | null = null;

  for (const marker of Array.from(
    scroller.querySelectorAll<HTMLElement>(CHAT_ITEM_KEY_SELECTOR),
  )) {
    const key = marker.dataset.chatItemKey;
    const rect = markerBounds(marker);
    if (!key || rect === null) continue;
    if (rect.bottom <= viewport.top || rect.top >= viewport.bottom) continue;
    if (first === null || rect.top < first.top) {
      first = { key, top: rect.top };
    }
  }

  return first === null
    ? null
    : {
        key: first.key,
        offset: first.top - viewport.top,
        scrollHeight: scroller.scrollHeight,
        scrollTop: scroller.scrollTop,
      };
}

export function findFirstVisuallyIntersectingItemKey(
  scroller: HTMLElement,
): string | null {
  return measureFirstVisuallyIntersectingItem(scroller)?.key ?? null;
}

export function measureChatItemOffset(
  scroller: HTMLElement,
  key: string,
): number | null {
  const viewport = scroller.getBoundingClientRect();
  for (const marker of Array.from(
    scroller.querySelectorAll<HTMLElement>(CHAT_ITEM_KEY_SELECTOR),
  )) {
    if (marker.dataset.chatItemKey !== key) continue;
    const rect = markerBounds(marker);
    return rect === null ? null : rect.top - viewport.top;
  }
  return null;
}

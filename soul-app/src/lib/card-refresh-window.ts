export const CARD_REFRESH_WINDOW_MS = 500;
export const CARD_REFRESH_MAX_WAIT_MS = 1000;

export interface CardRefreshWindow {
  timer: ReturnType<typeof setTimeout> | null;
  startedAt: number | null;
}

export function createCardRefreshWindow(): CardRefreshWindow {
  return { timer: null, startedAt: null };
}

/** 마지막 사건 뒤 한 창을 기다리되, 창을 연 뒤 최대 대기 상한을 넘기지 않는다. */
export function scheduleCardRefresh(
  window: CardRefreshWindow,
  refresh: () => void,
  now = Date.now(),
): void {
  if (window.startedAt === null) window.startedAt = now;
  if (window.timer !== null) clearTimeout(window.timer);
  const due = Math.min(now + CARD_REFRESH_WINDOW_MS, window.startedAt + CARD_REFRESH_MAX_WAIT_MS);
  window.timer = setTimeout(() => {
    window.timer = null;
    window.startedAt = null;
    refresh();
  }, Math.max(0, due - now));
}

export function cancelCardRefresh(window: CardRefreshWindow): void {
  if (window.timer !== null) clearTimeout(window.timer);
  window.timer = null;
  window.startedAt = null;
}

export const PANE_LEFT_MIN_WIDTH = 180;
export const PANE_MIDDLE_MIN_WIDTH = 280;
// 피드 300pt에서 얼굴·배지·여백 218pt를 빼면 제목에 82pt가 남는다.
export const PANE_FEED_MIN_WIDTH = 300;

export function resolveThreePaneWidths({
  rowWidth,
  panelGap,
  paneLeftWidth,
  paneMiddleWidth,
}: {
  rowWidth: number;
  panelGap: number;
  paneLeftWidth: number;
  paneMiddleWidth: number;
}): { left: number; middle: number } {
  const availableWidth = rowWidth - 2 * panelGap;
  const left = clamp(
    paneLeftWidth,
    PANE_LEFT_MIN_WIDTH,
    availableWidth - PANE_MIDDLE_MIN_WIDTH - PANE_FEED_MIN_WIDTH,
  );
  const middle = clamp(
    paneMiddleWidth,
    PANE_MIDDLE_MIN_WIDTH,
    availableWidth - left - PANE_FEED_MIN_WIDTH,
  );

  return { left, middle };
}

export function clampThreePaneLeftDrag(
  requestedWidth: number,
  { rowWidth, panelGap, middle }: { rowWidth: number; panelGap: number; middle: number },
): number {
  const availableWidth = rowWidth - 2 * panelGap;
  return clamp(
    requestedWidth,
    PANE_LEFT_MIN_WIDTH,
    availableWidth - middle - PANE_FEED_MIN_WIDTH,
  );
}

export function clampThreePaneMiddleDrag(
  requestedWidth: number,
  { rowWidth, panelGap, left }: { rowWidth: number; panelGap: number; left: number },
): number {
  const availableWidth = rowWidth - 2 * panelGap;
  return clamp(
    requestedWidth,
    PANE_MIDDLE_MIN_WIDTH,
    availableWidth - left - PANE_FEED_MIN_WIDTH,
  );
}

export function resolveTwoPaneMiddleWidth({
  rowWidth,
  panelGap,
  windowWidth,
  paneMiddleWidth,
  paneMiddleWidthTwoPane,
}: {
  rowWidth: number;
  panelGap: number;
  windowWidth: number;
  paneMiddleWidth: number;
  paneMiddleWidthTwoPane: number | null;
}): number {
  const availableWidth = rowWidth - panelGap;
  const preferredWidth = paneMiddleWidthTwoPane
    ?? Math.min(paneMiddleWidth, Math.floor(windowWidth * 0.5));

  return clamp(
    preferredWidth,
    PANE_MIDDLE_MIN_WIDTH,
    availableWidth - PANE_FEED_MIN_WIDTH,
  );
}

export function clampTwoPaneMiddleDrag(
  requestedWidth: number,
  { rowWidth, panelGap }: { rowWidth: number; panelGap: number },
): number {
  const availableWidth = rowWidth - panelGap;
  return clamp(
    requestedWidth,
    PANE_MIDDLE_MIN_WIDTH,
    availableWidth - PANE_FEED_MIN_WIDTH,
  );
}

function clamp(value: number, minimum: number, maximum: number): number {
  const upperBound = Math.max(minimum, maximum);
  return Math.min(Math.max(value, minimum), upperBound);
}

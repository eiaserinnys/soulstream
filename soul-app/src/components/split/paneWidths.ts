/**
 * 2·3단 split의 기준 폭. 화면 폭과 무관한 설계 값의 정본이다.
 *  - card: 가운데 카드 pane (min 280은 피드 300과 공존하는 하한)
 *  - folder: 3단 왼쪽 폴더 pane
 *  - feed: 오른쪽 세션 피드. 400 이상이면 카드 한 줄이 넓은 배치를 쓴다.
 */
export const PANE_SPECS = {
  folder: { default: 240 },
  card: { min: 280, default: 480 },
  feed: { min: 300, default: 300, max: 400 },
} as const;

export const PANE_LEFT_MIN_WIDTH = 180;
export const PANE_MIDDLE_MIN_WIDTH = PANE_SPECS.card.min;
// 피드 300pt에서 얼굴·배지·여백 218pt를 빼면 제목에 82pt가 남는다.
export const PANE_FEED_MIN_WIDTH = PANE_SPECS.feed.min;

/** 2단 최소: 카드 + 간격 + 피드 + 좌우 여백. */
export const TWO_PANE_MIN_SAFE_WIDTH =
  PANE_SPECS.card.min + PANE_SPECS.feed.min + 12 + 24;
/** 3단 최소: 폴더 + 카드 + 피드 + 두 간격. */
export const THREE_PANE_MIN_SAFE_WIDTH =
  PANE_SPECS.folder.default + PANE_SPECS.card.default + PANE_SPECS.feed.min + 24 + 24;

export type SplitLayoutMode = 'compact' | 'two-pane' | 'three-pane';

/** 안전 영역을 뺀 폭만으로 split 모드를 정한다. 방향은 쓰지 않는다. */
export function resolveSplitLayoutMode(safeWidth: number): SplitLayoutMode {
  if (safeWidth < TWO_PANE_MIN_SAFE_WIDTH) return 'compact';
  if (safeWidth >= THREE_PANE_MIN_SAFE_WIDTH) return 'three-pane';
  return 'two-pane';
}

/** 2단에서 가운데 카드 pane과 오른쪽 피드 pane의 폭. */
export function calculateTwoPaneWidths(
  totalRowWidth: number,
  gap = 12,
): { middle: number; right: number } {
  const available = Math.max(0, totalRowWidth - gap);
  const feedTarget = available > 700
    ? Math.min(
      PANE_SPECS.feed.max,
      Math.max(PANE_SPECS.feed.default, Math.round(available * 0.4284)),
    )
    : PANE_SPECS.feed.default;
  const middle = Math.max(PANE_SPECS.card.min, available - feedTarget);
  const right = Math.max(PANE_SPECS.feed.min, available - middle);
  return { middle, right };
}


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

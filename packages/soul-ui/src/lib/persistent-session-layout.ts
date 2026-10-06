const BASE_CHARACTER_WIDTH = 152; // --char-base in dist/session.css
const MAX_GROWN_CHARACTER_WIDTH = 240; // --char-grow-max in the pointer:fine rule
const FINE_POINTER_GROW_RATIO = 0.4; // --char-grow in the pointer:fine rule
const LEFT_GUTTER_WIDTH_RATIO = 0.6; // width ceiling in characterGeometry
const CHARACTER_HEIGHT_RATIO = 1.5; // stage aspect ratio in characterGeometry
const MIN_CHARACTER_WIDTH = 96; // hidden threshold in characterGeometry
const MIN_VIEWPORT_WIDTH = 768; // hidden threshold in characterGeometry
const TOGGLE_SIZE = 40;
const TOGGLE_GROUP_GAP = 8;
const LEFT_GUTTER_EDGE = 8;
const HEADER_SAFE_GAP = 16; // safeTop offset in characterGeometry
const BASELINE_EDGE = 1; // the body overlaps the baseline row by one pixel
const EVEN_WIDTH_STEP = 2; // characterGeometry rounds the width down to an even pixel

export interface PersistentSessionRect {
  left: number;
  top: number;
  width: number;
  height: number;
}

export interface PersistentSessionLayoutInput {
  /** All rectangles use the same viewport coordinate system. */
  app: PersistentSessionRect;
  header: PersistentSessionRect;
  main: PersistentSessionRect;
  /** Viewport Y at the bottom edge of the composer's baseline border. */
  baselineBottom: number;
  /** Height of the single-line input row, excluding any multiline growth. */
  inputRowHeight: number;
  /** Gap between the bottom of the input row and the composer's baseline. */
  rowBottomGap: number;
  pointerFine: boolean;
  showCharacter: boolean;
  phoneConfigured: boolean;
}

export interface PersistentSessionLayout {
  /** Baseline row's Y coordinate in app-local coordinates. */
  lineY: number;
  /** Body and toggle rectangles are app-local; null means not rendered. */
  body: PersistentSessionRect | null;
  toggle: PersistentSessionRect | null;
  /** Horizontal distance the baseline extends left from main to the body. */
  lineLeftReach: number;
}

/** Shared, platform-free geometry for the persistent-session body, baseline, and toggle. */
export function calculatePersistentSessionLayout(
  input: PersistentSessionLayoutInput,
): PersistentSessionLayout {
  const { app, header, main, baselineBottom, inputRowHeight, rowBottomGap, pointerFine, showCharacter, phoneConfigured } = input;
  const lineY = Math.round(baselineBottom - app.top) - 1;
  const leftWidth = main.left - app.left;
  const bodyBottom = lineY + BASELINE_EDGE;
  const safeTop = header.top + header.height - app.top + HEADER_SAFE_GAP;
  const growthRatio = pointerFine ? FINE_POINTER_GROW_RATIO : 0;
  const growthMaximum = pointerFine ? MAX_GROWN_CHARACTER_WIDTH : BASE_CHARACTER_WIDTH;
  const cap = Math.max(BASE_CHARACTER_WIDTH, Math.min(growthMaximum, leftWidth * growthRatio));
  const bodyWidth = Math.floor(
    Math.min(
      cap,
      leftWidth * LEFT_GUTTER_WIDTH_RATIO,
      leftWidth - TOGGLE_SIZE - TOGGLE_GROUP_GAP - 2 * LEFT_GUTTER_EDGE,
      (bodyBottom - safeTop) / CHARACTER_HEIGHT_RATIO,
    )
      / EVEN_WIDTH_STEP,
  ) * EVEN_WIDTH_STEP;
  const bodyHeight = bodyWidth * CHARACTER_HEIGHT_RATIO;
  const groupLeft = Math.round((leftWidth - TOGGLE_SIZE - TOGGLE_GROUP_GAP - bodyWidth) / 2);
  const bodyLeft = groupLeft + TOGGLE_SIZE + TOGGLE_GROUP_GAP;
  const bodyTop = Math.round(bodyBottom - bodyHeight);
  const toggleCenterY = lineY - rowBottomGap - inputRowHeight / 2;
  const toggleTop = toggleCenterY - TOGGLE_SIZE / 2;
  const toggleLeft = groupLeft;
  const isConstrained = phoneConfigured
    || app.width < MIN_VIEWPORT_WIDTH
    || bodyWidth < MIN_CHARACTER_WIDTH;

  if (isConstrained) {
    return { lineY, body: null, toggle: null, lineLeftReach: 0 };
  }

  const body = showCharacter
    ? { left: bodyLeft, top: bodyTop, width: bodyWidth, height: bodyHeight }
    : null;
  const toggle = { left: toggleLeft, top: toggleTop, width: TOGGLE_SIZE, height: TOGGLE_SIZE };

  return {
    lineY,
    body,
    toggle,
    lineLeftReach: showCharacter ? Math.max(0, leftWidth - bodyLeft) : 0,
  };
}

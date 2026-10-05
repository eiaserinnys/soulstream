const BASE_CHARACTER_WIDTH = 152; // --char-base in dist/session.css
const MAX_GROWN_CHARACTER_WIDTH = 240; // --char-grow-max in the pointer:fine rule
const FINE_POINTER_GROW_RATIO = 0.4; // --char-grow in the pointer:fine rule
const LEFT_GUTTER_WIDTH_RATIO = 0.6; // width ceiling in characterGeometry
const CHARACTER_HEIGHT_RATIO = 1.5; // stage aspect ratio in characterGeometry
const MIN_CHARACTER_WIDTH = 96; // hidden threshold in characterGeometry
const MIN_VIEWPORT_WIDTH = 768; // hidden threshold in characterGeometry
const TOGGLE_SIZE = 40; // --toggle-size in dist/session.css
const COMPOSER_GAP = 12; // --composer-gap in dist/session.css
const HEADER_SAFE_GAP = 16; // safeTop offset in characterGeometry
const VIEWPORT_BOTTOM_GAP = 8; // seatBottom threshold in characterGeometry
const BASELINE_EDGE = 1; // portraitBottom = lineY + 1 when --portrait-gap is zero
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
  composer: PersistentSessionRect;
  /** Height of the single-line input row, excluding any multiline growth. */
  inputRowHeight: number;
  pointerFine: boolean;
  showCharacter: boolean;
  phoneConfigured: boolean;
}

export interface PersistentSessionLayout {
  /** Composer's top edge in app-local coordinates. */
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
  const { app, header, main, composer, inputRowHeight, pointerFine, showCharacter, phoneConfigured } = input;
  const lineY = Math.round(composer.top - app.top);
  const leftWidth = main.left - app.left;
  const bodyBottom = lineY + BASELINE_EDGE;
  const safeTop = header.top + header.height - app.top + HEADER_SAFE_GAP;
  const growthRatio = pointerFine ? FINE_POINTER_GROW_RATIO : 0;
  const growthMaximum = pointerFine ? MAX_GROWN_CHARACTER_WIDTH : BASE_CHARACTER_WIDTH;
  const cap = Math.max(BASE_CHARACTER_WIDTH, Math.min(growthMaximum, leftWidth * growthRatio));
  const bodyWidth = Math.floor(
    Math.min(cap, leftWidth * LEFT_GUTTER_WIDTH_RATIO, (bodyBottom - safeTop) / CHARACTER_HEIGHT_RATIO)
      / EVEN_WIDTH_STEP,
  ) * EVEN_WIDTH_STEP;
  const bodyHeight = bodyWidth * CHARACTER_HEIGHT_RATIO;
  const bodyLeft = Math.round(leftWidth / 2 - bodyWidth / 2);
  const bodyTop = Math.round(bodyBottom - bodyHeight);
  const toggleTop = lineY + COMPOSER_GAP + (inputRowHeight - TOGGLE_SIZE) / 2;
  const toggleLeft = Math.round(leftWidth / 2 - TOGGLE_SIZE / 2);
  const isConstrained = phoneConfigured
    || app.width < MIN_VIEWPORT_WIDTH
    || bodyWidth < MIN_CHARACTER_WIDTH
    || toggleTop + TOGGLE_SIZE > app.height - VIEWPORT_BOTTOM_GAP;

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

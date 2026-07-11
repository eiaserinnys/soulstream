import type { VisualLineMetrics } from "@soulstream/page-editor-core";

const MIRROR_STYLE_PROPERTIES = [
  "fontFamily",
  "fontSize",
  "fontStyle",
  "fontWeight",
  "fontVariant",
  "fontStretch",
  "lineHeight",
  "letterSpacing",
  "textAlign",
  "textIndent",
  "textTransform",
  "wordSpacing",
  "tabSize",
  "paddingTop",
  "paddingRight",
  "paddingBottom",
  "paddingLeft",
  "borderTopWidth",
  "borderRightWidth",
  "borderBottomWidth",
  "borderLeftWidth",
  "overflowWrap",
  "wordBreak",
] as const;

interface CaretLineRect {
  readonly top: number;
  readonly bottom: number;
  readonly height: number;
}

export function measureTextareaCaretLines(
  textarea: HTMLTextAreaElement,
  selectionOffset: number,
): VisualLineMetrics | null {
  const text = textarea.value;
  const offset = clamp(selectionOffset, text.length);
  const first = measureCaretLine(textarea, 0);
  const caret = measureCaretLine(textarea, offset);
  const last = measureCaretLine(textarea, text.length);
  if (!first || !caret || !last) return null;
  return {
    caretTop: caret.top,
    caretBottom: caret.bottom,
    firstLineTop: first.top,
    firstLineBottom: first.bottom,
    lastLineTop: last.top,
    lastLineBottom: last.bottom,
    tolerancePx: Math.max(1, Math.min(2, caret.height * 0.1)),
  };
}

function measureCaretLine(
  textarea: HTMLTextAreaElement,
  offset: number,
): CaretLineRect | null {
  const ownerDocument = textarea.ownerDocument;
  const mirror = ownerDocument.createElement("div");
  const marker = ownerDocument.createElement("span");
  const computed = ownerDocument.defaultView?.getComputedStyle(textarea);
  if (!computed) return null;
  mirror.dataset.pageEditorCaretMirror = "true";
  marker.dataset.pageEditorCaretMarker = "true";
  marker.dataset.caretOffset = String(offset);
  configureMirror(mirror, textarea, computed);
  mirror.append(ownerDocument.createTextNode(textarea.value.slice(0, offset)));
  marker.textContent = "\u200b";
  marker.style.display = "inline-block";
  marker.style.width = "0";
  marker.style.height = "1em";
  marker.style.verticalAlign = "text-bottom";
  mirror.append(marker, ownerDocument.createTextNode(textarea.value.slice(offset) || "\u200b"));
  ownerDocument.body.appendChild(mirror);
  try {
    const mirrorRect = mirror.getBoundingClientRect();
    const markerRect = marker.getBoundingClientRect();
    const fallbackHeight = parsedLineHeight(computed);
    const height = markerRect.height || fallbackHeight;
    const top = markerRect.top - mirrorRect.top;
    if (!Number.isFinite(top) || !Number.isFinite(height) || height <= 0) return null;
    return { top, bottom: top + height, height };
  } finally {
    mirror.remove();
  }
}

function configureMirror(
  mirror: HTMLDivElement,
  textarea: HTMLTextAreaElement,
  computed: CSSStyleDeclaration,
): void {
  const width = resolvedBorderBoxWidth(textarea, computed);
  mirror.style.position = "fixed";
  mirror.style.left = "-100000px";
  mirror.style.top = "0";
  mirror.style.visibility = "hidden";
  mirror.style.pointerEvents = "none";
  mirror.style.whiteSpace = "pre-wrap";
  mirror.style.overflow = "hidden";
  mirror.style.boxSizing = "border-box";
  mirror.style.width = `${width}px`;
  for (const property of MIRROR_STYLE_PROPERTIES) {
    mirror.style.setProperty(camelToKebab(property), computed[property]);
  }
}

function resolvedBorderBoxWidth(
  textarea: HTMLTextAreaElement,
  computed: CSSStyleDeclaration,
): number {
  const rectWidth = textarea.getBoundingClientRect().width;
  if (Number.isFinite(rectWidth) && rectWidth > 0) return rectWidth;
  const cssWidth = parseFloat(computed.width);
  if (Number.isFinite(cssWidth) && cssWidth > 0) {
    if (computed.boxSizing === "border-box") return cssWidth;
    return cssWidth + horizontalSpace(computed);
  }
  const clientWidth = textarea.clientWidth;
  const borders = number(computed.borderLeftWidth) + number(computed.borderRightWidth);
  return Math.max(1, clientWidth + borders);
}

function horizontalSpace(computed: CSSStyleDeclaration): number {
  return number(computed.paddingLeft) + number(computed.paddingRight)
    + number(computed.borderLeftWidth) + number(computed.borderRightWidth);
}

function number(value: string): number {
  const parsed = parseFloat(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function parsedLineHeight(computed: CSSStyleDeclaration): number {
  const lineHeight = parseFloat(computed.lineHeight);
  if (Number.isFinite(lineHeight) && lineHeight > 0) return lineHeight;
  const fontSize = parseFloat(computed.fontSize);
  return Number.isFinite(fontSize) && fontSize > 0 ? fontSize * 1.2 : 16;
}

function camelToKebab(value: string): string {
  return value.replace(/[A-Z]/g, (character) => `-${character.toLowerCase()}`);
}

function clamp(offset: number, length: number): number {
  return Math.max(0, Math.min(length, offset));
}

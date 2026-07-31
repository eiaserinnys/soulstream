export interface MarkdownViewportSnapshot {
  anchor: number;
  selectionOffset?: number;
}

export const DEFAULT_DOCUMENT_TITLE = "Untitled document";

export function isDefaultDocumentTitle(title: string): boolean {
  const trimmed = title.trim();
  return trimmed === "" || trimmed.toLowerCase() === DEFAULT_DOCUMENT_TITLE.toLowerCase();
}

interface ScrollMetrics {
  scrollTop: number;
  clientHeight: number;
  scrollHeight: number;
}

export function captureMarkdownViewport(
  metrics: ScrollMetrics,
  selectionOffset?: number,
): MarkdownViewportSnapshot {
  const height = Math.max(metrics.scrollHeight, 1);
  const anchor = clamp((metrics.scrollTop + metrics.clientHeight / 2) / height, 0, 1);
  return selectionOffset === undefined ? { anchor } : { anchor, selectionOffset };
}

export function captureMarkdownReadViewport(
  metrics: ScrollMetrics,
  previous: MarkdownViewportSnapshot | null,
): MarkdownViewportSnapshot {
  const captured = captureMarkdownViewport(metrics);
  const selectionOffset = previous && Math.abs(previous.anchor - captured.anchor) <= 0.05
    ? previous.selectionOffset
    : undefined;
  return selectionOffset === undefined ? captured : { ...captured, selectionOffset };
}

export function markdownScrollTopForAnchor(
  anchor: number,
  metrics: Pick<ScrollMetrics, "clientHeight" | "scrollHeight">,
): number {
  const maximum = Math.max(metrics.scrollHeight - metrics.clientHeight, 0);
  const target = clamp(anchor, 0, 1) * metrics.scrollHeight - metrics.clientHeight / 2;
  return clamp(target, 0, maximum);
}

export function restoreMarkdownViewport(
  element: HTMLElement,
  snapshot: MarkdownViewportSnapshot,
) {
  element.scrollTop = markdownScrollTopForAnchor(snapshot.anchor, element);
}

export function markdownSelectionOffset(
  documentLength: number,
  snapshot: MarkdownViewportSnapshot,
): number {
  const offset = snapshot.selectionOffset ?? Math.round(documentLength * snapshot.anchor);
  return clamp(offset, 0, documentLength);
}

export function isScrollbarMouseDown(
  target: Pick<HTMLElement, "clientWidth" | "clientHeight" | "scrollWidth" | "scrollHeight">,
  offsetX: number,
  offsetY: number,
): boolean {
  if (target.scrollHeight > target.clientHeight && offsetX > target.clientWidth) return true;
  if (target.scrollWidth > target.clientWidth && offsetY > target.clientHeight) return true;
  return false;
}

function clamp(value: number, minimum: number, maximum: number) {
  return Math.min(Math.max(value, minimum), maximum);
}

import type { CSSProperties } from "react";

export type PageEditorSelectionSegment = "single" | "start" | "middle" | "end";

export const PAGE_EDITOR_LAYOUT_SPACING = Object.freeze({
  rowMinHeightPx: 40,
  rowPaddingBlockPx: 4,
  rowPaddingInlinePx: 8,
  rowIndentStepPx: 24,
});

export const PAGE_EDITOR_ROW_TOKENS = Object.freeze({
  base: "flex items-center gap-2 transition-colors",
  idle: "rounded-lg hover:bg-glass-highlight/50",
  selected: "bg-muted/70",
  deleteArmed: "bg-destructive/20",
  selectionRadius: Object.freeze({
    single: "rounded-lg",
    start: "rounded-t-lg rounded-b-none",
    middle: "rounded-none",
    end: "rounded-t-none rounded-b-lg",
  } satisfies Readonly<Record<PageEditorSelectionSegment, string>>),
});

export function pageEditorRowStyle(depth: number): CSSProperties {
  return {
    minHeight: `${PAGE_EDITOR_LAYOUT_SPACING.rowMinHeightPx}px`,
    paddingTop: `${PAGE_EDITOR_LAYOUT_SPACING.rowPaddingBlockPx}px`,
    paddingBottom: `${PAGE_EDITOR_LAYOUT_SPACING.rowPaddingBlockPx}px`,
    paddingInlineEnd: `${PAGE_EDITOR_LAYOUT_SPACING.rowPaddingInlinePx}px`,
    paddingInlineStart: `${PAGE_EDITOR_LAYOUT_SPACING.rowPaddingInlinePx + depth * PAGE_EDITOR_LAYOUT_SPACING.rowIndentStepPx}px`,
  };
}

export function pageEditorSelectionSegment(
  currentId: string,
  previousId: string | undefined,
  nextId: string | undefined,
  selected: ReadonlySet<string>,
): PageEditorSelectionSegment | null {
  if (!selected.has(currentId)) return null;
  const previousSelected = previousId !== undefined && selected.has(previousId);
  const nextSelected = nextId !== undefined && selected.has(nextId);
  if (!previousSelected && !nextSelected) return "single";
  if (!previousSelected) return "start";
  if (!nextSelected) return "end";
  return "middle";
}

import { PAGE_EDITOR_LAYOUT_SPACING } from "@seosoyoung/soul-ui/page-editor";

export const V2_TOKENS = Object.freeze({
  navigation: "border border-glass-border glass-strong glass-chrome text-foreground",
  pageSurface: "border border-glass-border glass-strong text-foreground",
  row: "rounded-lg text-foreground hover:bg-muted/60",
  state: "rounded-xl border border-glass-border bg-muted/40 text-muted-foreground",
  control: "rounded-lg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
});

export const V2_LAYOUT_SPACING = Object.freeze({
  navigationSectionGapPx: 20,
  legacyRowGapPx: 8,
  legacyRowEstimatePx: 72,
  outlineRowMinHeightPx: PAGE_EDITOR_LAYOUT_SPACING.rowMinHeightPx,
  outlineRowPaddingBlockPx: PAGE_EDITOR_LAYOUT_SPACING.rowPaddingBlockPx,
  outlineRowPaddingInlinePx: PAGE_EDITOR_LAYOUT_SPACING.rowPaddingInlinePx,
  outlineRowIndentStepPx: PAGE_EDITOR_LAYOUT_SPACING.rowIndentStepPx,
});

export const V2_TOKEN_FIXTURE = Object.freeze([
  { surface: "navigation", tokens: V2_TOKENS.navigation },
  { surface: "page", tokens: V2_TOKENS.pageSurface },
  { surface: "outline-row", tokens: V2_TOKENS.row },
  { surface: "state", tokens: V2_TOKENS.state },
  { surface: "control", tokens: V2_TOKENS.control },
]);

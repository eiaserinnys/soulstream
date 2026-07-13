import { describe, expect, it } from "vitest";

import { V2_LAYOUT_SPACING, V2_TOKEN_FIXTURE, V2_TOKENS } from "./v2-token-fixture";

describe("v2 visual tokens", () => {
  it("uses the existing semantic token hierarchy without literal colors", () => {
    const serialized = JSON.stringify(V2_TOKEN_FIXTURE);
    expect(serialized).not.toMatch(/#[0-9a-f]{3,8}|rgb\(|hsl\(/i);
    expect(serialized).toContain("border-glass-border");
    expect(serialized).toContain("text-foreground");
    expect(serialized).toContain("focus-visible:ring-ring");
  });

  it("keeps navigation, page, and state accents in one fixture", () => {
    expect(Object.keys(V2_TOKENS)).toEqual([
      "navigation",
      "pageSurface",
      "row",
      "state",
      "control",
    ]);
    expect(V2_TOKEN_FIXTURE.map((entry) => entry.surface)).toEqual([
      "navigation",
      "page",
      "outline-row",
      "state",
      "control",
    ]);
  });

  it("keeps navigation and measured-row spacing in one numeric scale", () => {
    expect(V2_LAYOUT_SPACING).toEqual({
      navigationSectionGapPx: 20,
      legacyRowGapPx: 8,
      legacyRowEstimatePx: 72,
      outlineRowMinHeightPx: 40,
      outlineRowPaddingBlockPx: 4,
      outlineRowPaddingInlinePx: 8,
      outlineRowIndentStepPx: 24,
    });
    expect(V2_LAYOUT_SPACING.legacyRowEstimatePx % V2_LAYOUT_SPACING.legacyRowGapPx).toBe(0);
  });
});

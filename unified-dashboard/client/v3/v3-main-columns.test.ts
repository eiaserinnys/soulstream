import { describe, expect, it } from "vitest";

import {
  resolveV3MainColumns,
  dragV3Navigation,
  dragV3SessionPanel,
} from "./v3-main-columns";

describe("v3 main column widths", () => {
  it.each([
    [1440, 336, 500],
    [1920, 336, 500],
    [1200, 336, 404],
  ])("resolves the default widths at viewport %i", (viewportWidth, navigationWidth, sessionPanelWidth) => {
    expect(resolveV3MainColumns(viewportWidth, {
      navigationWidth: null,
      sessionPanelWidth: null,
    })).toEqual({ navigationWidth, sessionPanelWidth });
  });

  it("preserves existing saved widths when they fit", () => {
    expect(resolveV3MainColumns(1440, {
      navigationWidth: 420,
      sessionPanelWidth: 560,
    })).toEqual({ navigationWidth: 420, sessionPanelWidth: 560 });
  });

  it("keeps the navigation preference and shrinks the feed first when space is tight", () => {
    expect(resolveV3MainColumns(1440, {
      navigationWidth: 700,
      sessionPanelWidth: 700,
    })).toEqual({ navigationWidth: 700, sessionPanelWidth: 280 });
  });

  it("resizes either column against the fixed width of the other column", () => {
    expect(dragV3Navigation({ navigationWidth: 336, sessionPanelWidth: 500 }, 1440, 400))
      .toEqual({ navigationWidth: 480, sessionPanelWidth: 500 });
    expect(dragV3SessionPanel({ navigationWidth: 336, sessionPanelWidth: 500 }, 1440, -400))
      .toEqual({ navigationWidth: 336, sessionPanelWidth: 644 });
    expect(dragV3Navigation({ navigationWidth: 336, sessionPanelWidth: 500 }, 1920, 300))
      .toEqual({ navigationWidth: 636, sessionPanelWidth: 500 });
    expect(dragV3SessionPanel({ navigationWidth: 336, sessionPanelWidth: 500 }, 1920, -300))
      .toEqual({ navigationWidth: 336, sessionPanelWidth: 800 });
  });

  it("allows immediate movement from a previously saved boundary and respects the minimums", () => {
    expect(dragV3Navigation({ navigationWidth: 420, sessionPanelWidth: 560 }, 1440, -10))
      .toEqual({ navigationWidth: 410, sessionPanelWidth: 560 });
    expect(dragV3Navigation({ navigationWidth: 336, sessionPanelWidth: 500 }, 1440, -1000))
      .toEqual({ navigationWidth: 220, sessionPanelWidth: 500 });
    expect(dragV3SessionPanel({ navigationWidth: 336, sessionPanelWidth: 500 }, 1440, 1000))
      .toEqual({ navigationWidth: 336, sessionPanelWidth: 240 });
  });

  it("keeps a viewport-clamped column fixed when dragging the other column", () => {
    const widths = resolveV3MainColumns(1440, {
      navigationWidth: 400,
      sessionPanelWidth: 900,
    });
    expect(widths).toEqual({ navigationWidth: 400, sessionPanelWidth: 580 });
    const afterDrag = dragV3Navigation(widths, 1440, -100);
    expect(afterDrag).toEqual({ navigationWidth: 300, sessionPanelWidth: 580 });
    expect(resolveV3MainColumns(1440, afterDrag)).toEqual(afterDrag);
  });
});

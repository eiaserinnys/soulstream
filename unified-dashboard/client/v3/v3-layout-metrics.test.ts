import { describe, expect, it } from "vitest";

import {
  V3_CARD_GAP_PX,
  V3_CONTENT_MAX_WIDTH_PX,
  V3_NAVIGATION_DEFAULT_WIDTH_PX,
  V3_OUTER_INSET_PX,
  V3_PANEL_GAP_PX,
  V3_SESSION_PANEL_DEFAULT_WIDTH_PX,
  readV3NavigationWidth,
} from "./v3-layout-metrics";

describe("v3 layout metrics", () => {
  it("keeps the desktop grid and four-pixel card rhythm in one source", () => {
    expect(V3_NAVIGATION_DEFAULT_WIDTH_PX).toBe(336);
    expect(V3_CONTENT_MAX_WIDTH_PX).toBe(960);
    expect(V3_SESSION_PANEL_DEFAULT_WIDTH_PX).toBe(500);
    expect(V3_PANEL_GAP_PX).toBe(16);
    expect(V3_OUTER_INSET_PX).toBe(20);
    expect(V3_CARD_GAP_PX).toBe(4);
  });

  it("uses the v3 default only when the user has not persisted a width", () => {
    const values = new Map<string, string>();
    const storage = {
      getItem: (key: string) => values.get(key) ?? null,
    } as Storage;

    expect(readV3NavigationWidth(storage)).toBe(336);
    values.set("soul-ui.dashboard.leftSidebarWidth", "288");
    expect(readV3NavigationWidth(storage)).toBe(288);
  });
});

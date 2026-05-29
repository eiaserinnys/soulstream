import { describe, expect, it } from "vitest";

import { runtimePanelScrollClass } from "./runtime-panel-overflow";

describe("runtimePanelScrollClass", () => {
  it("caps expanded runtime detail regions and scrolls internally", () => {
    const className = runtimePanelScrollClass("space-y-2");

    expect(className).toContain("max-h-[240px]");
    expect(className).toContain("overflow-y-auto");
    expect(className).toContain("overscroll-contain");
    expect(className).toContain("space-y-2");
  });
});

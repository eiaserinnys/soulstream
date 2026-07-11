import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import { V2PageLensControls } from "./V2PageLensControls";

describe("V2PageLensControls", () => {
  it("exposes default, running, and completed as a single restored selection", () => {
    const html = renderToStaticMarkup(createElement(V2PageLensControls, {
      lens: "running",
      onChange: vi.fn(),
    }));
    expect(html).toContain("Default");
    expect(html).toContain("Running");
    expect(html).toContain("Completed");
    expect(html).toContain('aria-pressed="true"');
  });
});

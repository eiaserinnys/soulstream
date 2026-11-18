import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { AtomNodeSelector } from "./AtomNodeSelector";

describe("AtomNodeSelector presentation", () => {
  it("renders the open inline panel in the trigger's flow", () => {
    const html = renderToStaticMarkup(<AtomNodeSelector value="" onChange={vi.fn()} open presentation="inline" />);
    expect(html).toContain('data-slot="atom-node-selector-panel"');
    expect(html.indexOf("노드 선택")).toBeLessThan(html.indexOf('data-slot="atom-node-selector-panel"'));
    expect(html).toContain("루트");
  });
  it("keeps the popup presentation as default", () => {
    const html = renderToStaticMarkup(<AtomNodeSelector value="" onChange={vi.fn()} open />);
    expect(html).toContain('data-slot="popover-trigger"');
    expect(html).not.toContain('data-slot="atom-node-selector-panel"');
  });
});

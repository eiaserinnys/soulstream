import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { V2MobileWorkspace } from "./V2MobileWorkspace";

describe("V2MobileWorkspace", () => {
  it("uses a single-pane page surface instead of compressing the desktop columns", () => {
    const html = renderToStaticMarkup(createElement(V2MobileWorkspace, {
      pageId: "page-1",
      navigation: createElement("nav", null, "Pages"),
      pageSurface: createElement("main", null, "Page body"),
    }));
    expect(html).toContain('data-responsive-mode="single-pane"');
    expect(html).toContain('data-mobile-v2-pane="page"');
    expect(html).toContain("Page body");
    expect(html).not.toContain("<nav>Pages</nav>");
  });

  it("starts at navigation when no page has resolved", () => {
    const html = renderToStaticMarkup(createElement(V2MobileWorkspace, {
      pageId: null,
      navigation: createElement("nav", null, "Pages"),
      pageSurface: createElement("main", null, "Loading"),
    }));
    expect(html).toContain('data-mobile-v2-pane="navigation"');
    expect(html).toContain("Pages");
  });
});

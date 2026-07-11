import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import { V2LeftNavigation } from "./V2LeftNavigation";

describe("V2LeftNavigation", () => {
  it("renders the daily entry and starred page list with an active deep link", () => {
    const html = renderToStaticMarkup(createElement(V2LeftNavigation, {
      selectedPageId: "page-2",
      starredPages: [
        { id: "page-1", title: "첫 페이지", daily_date: null, version: 1, archived: false, metadata: { starred: true }, created_at: "", updated_at: "" },
        { id: "page-2", title: "둘째 페이지", daily_date: null, version: 2, archived: false, metadata: { starred: true }, created_at: "", updated_at: "" },
      ],
      loading: false,
      error: null,
      onOpenDaily: vi.fn(),
      onOpenPage: vi.fn(),
      onUnstarPage: vi.fn(),
    }));

    expect(html).toContain('data-testid="v2-daily-entry"');
    expect(html).toContain('aria-label="Starred pages"');
    expect(html).toContain('aria-current="page"');
    expect(html).toContain("첫 페이지");
    expect(html).toContain('aria-label="Remove 둘째 페이지 from starred pages"');
  });

  it("keeps starred-list failure isolated from the daily entry", () => {
    const html = renderToStaticMarkup(createElement(V2LeftNavigation, {
      selectedPageId: null,
      starredPages: [],
      loading: false,
      error: "Starred pages could not be loaded.",
      onOpenDaily: vi.fn(),
      onOpenPage: vi.fn(),
      onUnstarPage: vi.fn(),
    }));
    expect(html).toContain("Starred pages could not be loaded.");
    expect(html).toContain('data-testid="v2-daily-entry"');
  });
});

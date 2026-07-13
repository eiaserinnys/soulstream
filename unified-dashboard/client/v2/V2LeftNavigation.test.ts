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
      legacyFolders: [
        { id: "legacy-root", name: "Legacy root", sortOrder: 0 },
        { id: "legacy-child", name: "Legacy child", sortOrder: 0, parentFolderId: "legacy-root" },
      ],
      selectedLegacyFolderId: "legacy-child",
      legacyStatus: { status: "ready", message: null },
      onOpenLegacyFolder: vi.fn(),
    }));

    expect(html).toContain('data-testid="v2-daily-entry"');
    expect(html).toContain('aria-label="Starred pages"');
    expect(html).toContain('aria-current="page"');
    expect(html).toContain("첫 페이지");
    expect(html).toContain('aria-label="Remove 둘째 페이지 from starred pages"');
    expect(html).toContain("Legacy root");
    expect(html).toContain("Legacy child");
    expect(html).toContain('data-legacy-folder-id="legacy-child"');
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

  it.each([
    { name: "loading", loading: true, error: null, starredPages: [] },
    { name: "empty", loading: false, error: null, starredPages: [] },
    {
      name: "list",
      loading: false,
      error: null,
      starredPages: [
        { id: "page-1", title: "A long starred page", daily_date: null, version: 1, archived: false, metadata: { starred: true }, created_at: "", updated_at: "" },
      ],
    },
  ])("keeps the $name starred state from shrinking into legacy spaces", ({ loading, error, starredPages }) => {
    const html = renderToStaticMarkup(createElement(V2LeftNavigation, {
      selectedPageId: null,
      starredPages,
      loading,
      error,
      onOpenDaily: vi.fn(),
      onOpenPage: vi.fn(),
      onUnstarPage: vi.fn(),
      legacyFolders: Array.from({ length: 40 }, (_, index) => ({
        id: `legacy-${index}`,
        name: `Legacy folder ${index}`,
        sortOrder: index,
      })),
      legacyStatus: { status: "ready", message: null },
      onOpenLegacyFolder: vi.fn(),
    }));

    expect(html.match(/data-v2-nav-section=/g)).toHaveLength(3);
    expect(html.match(/data-v2-nav-section="[^"]+" class="[^"]*shrink-0/g)).toHaveLength(3);
    expect(html).toContain("overflow-y-auto");
  });
});

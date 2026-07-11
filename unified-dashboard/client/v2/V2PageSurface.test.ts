import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import { V2PageSurface } from "./V2PageSurface";

const page = {
  id: "page-1",
  title: "오늘의 기록",
  daily_date: "2026-07-12",
  version: 2,
  archived: false,
  metadata: { starred: true },
  created_at: "",
  updated_at: "",
};

describe("V2PageSurface", () => {
  it.each([
    ["loading", "Loading page"],
    ["authentication", "Sign in again"],
    ["error", "Page unavailable"],
  ] as const)("renders an explicit %s readiness state", (status, expected) => {
    const html = renderToStaticMarkup(createElement(V2PageSurface, {
      state: { status, message: expected },
      onToggleStar: vi.fn(),
    }));
    expect(html).toContain(`data-page-state="${status}"`);
    expect(html).toContain(expected);
    expect(html).not.toContain('data-testid="v2-empty-page"');
  });

  it("renders a read-only outline only after sync readiness", () => {
    const html = renderToStaticMarkup(createElement(V2PageSurface, {
      state: {
        status: "ready",
        page,
        starring: false,
        blocks: [
          { id: "root", parentId: null, positionKey: "a0", type: "paragraph", textValue: "Root", properties: {}, collapsed: false },
          { id: "child", parentId: "root", positionKey: "a0", type: "paragraph", textValue: "Child", properties: {}, collapsed: false },
        ],
      },
      onToggleStar: vi.fn(),
    }));
    expect(html).toContain('data-page-state="ready"');
    expect(html).toContain('aria-readonly="true"');
    expect(html).toContain('data-outline-depth="0"');
    expect(html).toContain('data-outline-depth="1"');
    expect(html).toContain("Root");
    expect(html).toContain("Child");
    expect(html).toContain('aria-label="Remove page from starred pages"');
  });

  it("shows the empty-page seam only for a synced page", () => {
    const html = renderToStaticMarkup(createElement(V2PageSurface, {
      state: { status: "ready", page, starring: false, blocks: [] },
      onToggleStar: vi.fn(),
    }));
    expect(html).toContain('data-testid="v2-empty-page"');
    expect(html).toContain("Ready for the editor in the next phase");
  });
});

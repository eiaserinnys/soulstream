import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import type { PageApiClient, PageDocumentBlock, PageYjsClient } from "@seosoyoung/soul-ui/page";

vi.mock("@seosoyoung/soul-ui/page-editor", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@seosoyoung/soul-ui/page-editor")>();
  const { createElement: element } = await import("react");
  return {
    ...actual,
    PageOutliner: ({ blocks }: { blocks: readonly PageDocumentBlock[] }) => element(
      "div",
      { "aria-label": "Page outline editor" },
      blocks.length === 0
        ? element("button", { "data-testid": "page-editor-create-first" }, "Start writing")
        : blocks.map((block, index) => element("textarea", {
            key: block.id,
            value: block.textValue,
            readOnly: true,
            "data-outline-depth": index,
          })),
    ),
  };
});

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
    expect(html).not.toContain('data-testid="page-editor-create-first"');
  });

  it("renders the editable outline only after sync readiness", () => {
    const blocks = [editorBlock("root", null, "a0", "Root"), editorBlock("child", "root", "a0", "Child")];
    const html = renderToStaticMarkup(createElement(V2PageSurface, {
      state: {
        status: "ready",
        page,
        editor: editorRuntime(),
        starring: false,
        blocks,
      },
      onToggleStar: vi.fn(),
    }));
    expect(html).toContain('data-page-state="ready"');
    expect(html).toContain('aria-label="Page outline editor"');
    expect(html).toContain('data-outline-depth="0"');
    expect(html).toContain('data-outline-depth="1"');
    expect(html).toContain(">Root</textarea>");
    expect(html).toContain(">Child</textarea>");
    expect(html).toContain('aria-label="Remove page from starred pages"');
  });

  it("shows the empty-page seam only for a synced page", () => {
    const html = renderToStaticMarkup(createElement(V2PageSurface, {
      state: { status: "ready", page, editor: editorRuntime(), starring: false, blocks: [] },
      onToggleStar: vi.fn(),
    }));
    expect(html).toContain('data-testid="page-editor-create-first"');
    expect(html).toContain("Start writing");
  });
});

function editorBlock(id: string, parentId: string | null, positionKey: string, value: string): PageDocumentBlock {
  return {
    id,
    parentId,
    positionKey,
    type: "paragraph",
    text: {} as PageDocumentBlock["text"],
    textValue: value,
    properties: {},
    collapsed: false,
  };
}

function editorRuntime() {
  const apiClient = {
    listPages: vi.fn(),
    searchPages: vi.fn(),
    searchBlocks: vi.fn(),
    getBlock: vi.fn(),
    getBacklinks: vi.fn(async () => ({ items: [], nextCursor: null })),
    getPage: vi.fn(),
    getDailyPage: vi.fn(),
    applyOperations: vi.fn(),
    transferBlocks: vi.fn(),
    setStarred: vi.fn(),
  } as PageApiClient;
  return { doc: {} as PageYjsClient["doc"], apiClient, onResync: vi.fn() };
}

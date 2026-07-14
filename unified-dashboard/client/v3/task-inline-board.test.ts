import { describe, expect, it, vi } from "vitest";

import {
  fetchInlineCustomView,
  fetchInlineMarkdown,
  fetchTaskBoardItems,
} from "./task-inline-board-api";

describe("task inline board API", () => {
  it("loads a runbook container once and excludes run sessions", async () => {
    const fetchMock = vi.fn(async () => json({
      boardItems: [
        boardItem("session", "run-1"),
        boardItem("markdown", "doc-1"),
        boardItem("custom_view", "view-1"),
        boardItem("asset", "asset-1"),
      ],
    }));

    await expect(fetchTaskBoardItems("rb-a", fetchMock as typeof globalThis.fetch))
      .resolves.toMatchObject([
        { itemType: "markdown", itemId: "doc-1" },
        { itemType: "custom_view", itemId: "view-1" },
        { itemType: "asset", itemId: "asset-1" },
      ]);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/board-items?container_kind=runbook&container_id=rb-a",
      expect.objectContaining({ credentials: "same-origin" }),
    );
  });

  it("loads markdown and custom view documents only through their existing routes", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(json({ id: "doc-1", title: "결정", body: "# 본문", version: 2 }))
      .mockResolvedValueOnce(json({ id: "view-1", title: "진행률", html: "<b>42%</b>", revision: 3 }));

    await expect(fetchInlineMarkdown("doc-1", fetchMock as typeof globalThis.fetch))
      .resolves.toMatchObject({ body: "# 본문" });
    await expect(fetchInlineCustomView("view-1", fetchMock as typeof globalThis.fetch))
      .resolves.toMatchObject({ html: "<b>42%</b>" });

    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual([
      "/api/markdown-documents/doc-1",
      "/api/custom-views/view-1",
    ]);
  });
});

function boardItem(itemType: string, itemId: string) {
  return {
    id: `${itemType}:${itemId}`,
    folderId: "folder-a",
    containerKind: "runbook",
    containerId: "rb-a",
    itemType,
    itemId,
    x: 0,
    y: 0,
    metadata: { title: itemId },
  };
}

function json(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

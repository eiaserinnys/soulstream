import { describe, expect, it, vi } from "vitest";

import {
  fetchInlineCustomView,
  fetchInlineMarkdown,
  fetchTaskBoardContainerItems,
  fetchTaskBoardItems,
  saveInlineMarkdown,
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

  it("keeps every board item for the full runbook board", async () => {
    const fetchMock = vi.fn(async () => json({
      boardItems: [
        boardItem("session", "run-1"),
        boardItem("markdown", "doc-1"),
        boardItem("custom_view", "view-1"),
      ],
    }));

    await expect(fetchTaskBoardContainerItems("rb-a", fetchMock as typeof globalThis.fetch))
      .resolves.toMatchObject([
        { itemType: "session", itemId: "run-1" },
        { itemType: "markdown", itemId: "doc-1" },
        { itemType: "custom_view", itemId: "view-1" },
      ]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
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

  it("saves inline markdown through the existing v1 PUT contract", async () => {
    const fetchMock = vi.fn(async () => json({
      id: "doc-1",
      title: "결정",
      body: "# 수정 본문",
      version: 3,
    }));

    await expect(saveInlineMarkdown({
      documentId: "doc-1",
      title: "결정",
      body: "# 수정 본문",
      expectedVersion: 2,
    }, fetchMock as typeof globalThis.fetch)).resolves.toMatchObject({ version: 3 });

    expect(fetchMock).toHaveBeenCalledWith(
      "/api/markdown-documents/doc-1",
      expect.objectContaining({
        method: "PUT",
        credentials: "same-origin",
        body: JSON.stringify({ title: "결정", body: "# 수정 본문", expectedVersion: 2 }),
      }),
    );
  });

  it("rejects a stale inline markdown save so the shared editor keeps its draft", async () => {
    const fetchMock = vi.fn(async () => new Response("conflict", { status: 409 }));

    await expect(saveInlineMarkdown({
      documentId: "doc-1",
      title: "결정",
      body: "# 수정 본문",
      expectedVersion: 2,
    }, fetchMock as typeof globalThis.fetch)).rejects.toThrow("다른 곳에서 변경");
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

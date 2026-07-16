import { describe, expect, it, vi } from "vitest";

import {
  CONTAINER_SEARCH_SCAN_LIMIT,
  ContainerBrowseService,
  type ContainerBrowseStore,
} from "../../src/catalog/container_browse_service.js";
import type {
  CatalogBoardItemRow,
  ContainerItemRecord,
} from "../../src/db/session_db_types.js";

const FOLDER = {
  id: "folder-1",
  name: "Folder",
  sort_order: 0,
  settings: {},
  parent_folder_id: null,
};

function boardItem(
  itemType: CatalogBoardItemRow["itemType"],
  itemId: string,
  metadata: Record<string, unknown> = {},
): CatalogBoardItemRow {
  return {
    id: `${itemType}:${itemId}`,
    folderId: "folder-1",
    containerKind: "runbook",
    containerId: "runbook-1",
    membershipKind: "primary",
    sourceRunbookItemId: null,
    itemType,
    itemId,
    x: 0,
    y: 0,
    metadata,
    updatedAt: "2026-07-16T00:00:00.000Z",
  };
}

function storeWith(
  records: ContainerItemRecord[],
  total = records.length,
  scan: { limit: number; scannedItems: number; truncated: boolean } | null = null,
) {
  const listContainerItems = vi.fn(async () => ({
    items: records,
    total,
    counts: {
      session: records.filter((item) => item.boardItem.itemType === "session").length,
      markdown: records.filter((item) => item.boardItem.itemType === "markdown").length,
      subfolder: 0,
      asset: 0,
      frame: 0,
      runbook: 0,
      custom_view: 0,
    },
    scan,
  }));
  const store: ContainerBrowseStore = {
    getFolderById: vi.fn(async () => FOLDER),
    getRunbookById: vi.fn(async (id) => id === "runbook-1" ? ({ id } as never) : null),
    listContainerItems,
  };
  return { store, listContainerItems };
}

describe("ContainerBrowseService", () => {
  it("uses display name, then latest user preview, then a readable untitled fallback", async () => {
    const { store } = storeWith([
      {
        boardItem: boardItem("session", "session-named"),
        archived: false,
        session: {
          agentSessionId: "session-named",
          displayName: "  이름 있는 세션  ",
          lastUserMessagePreview: "사용자 프리뷰",
          status: "running",
          agentId: "roselin_codex",
          sessionType: "codex",
          createdAt: "2026-07-16T00:00:00.000Z",
          updatedAt: "2026-07-16T00:01:00.000Z",
          eventCount: 3,
          awaySummary: null,
          callerSessionId: null,
          predecessorSessionId: null,
          nodeId: "node-a",
          lastEventId: 3,
          lastReadEventId: 2,
        },
      },
      {
        boardItem: boardItem("session", "session-preview"),
        archived: false,
        session: {
          agentSessionId: "session-preview",
          displayName: null,
          lastUserMessagePreview: "  최신\n사용자 😀 발화  ",
          status: "completed",
          agentId: "seosoyoung",
          sessionType: "claude",
          createdAt: "2026-07-16T00:00:00.000Z",
          updatedAt: "2026-07-16T00:02:00.000Z",
          eventCount: 8,
          awaySummary: null,
          callerSessionId: "parent",
          predecessorSessionId: "previous",
          nodeId: "node-a",
          lastEventId: 8,
          lastReadEventId: 8,
        },
      },
      {
        boardItem: boardItem("session", "session-untitled"),
        archived: false,
        session: {
          agentSessionId: "session-untitled",
          displayName: "",
          lastUserMessagePreview: "",
          status: null,
          agentId: null,
          sessionType: null,
          createdAt: "2026-07-16T00:00:00.000Z",
          updatedAt: "2026-07-16T00:03:00.000Z",
          eventCount: 0,
          awaySummary: null,
          callerSessionId: null,
          predecessorSessionId: null,
          nodeId: null,
          lastEventId: null,
          lastReadEventId: null,
        },
      },
    ]);

    const result = await new ContainerBrowseService(store).browse({
      container: { containerKind: "runbook", containerId: "runbook-1" },
    });

    expect(result.items.map((item) => item.type === "session" ? item.displayName : null)).toEqual([
      "이름 있는 세션",
      "최신 사용자 😀 발화",
      "제목 없는 세션",
    ]);
    expect(result.items[1]).toEqual(expect.objectContaining({
      type: "session",
      agentSessionId: "session-preview",
      agentId: "seosoyoung",
      status: "completed",
    }));
  });

  it("returns codepoint-safe markdown previews and all board item types", async () => {
    const body = `${"가".repeat(239)}😀끝`;
    const { store } = storeWith([
      {
        boardItem: boardItem("markdown", "doc-1"),
        archived: false,
        markdown: {
          id: "doc-1",
          title: "명세",
          body,
          updatedAt: "2026-07-16T00:01:00.000Z",
        },
      },
      {
        boardItem: boardItem("runbook", "runbook-child"),
        archived: false,
        runbook: { id: "runbook-child", title: "후속 업무", updatedAt: null },
      },
      {
        boardItem: boardItem("custom_view", "view-1"),
        archived: false,
        customView: { id: "view-1", title: "상태판", updatedAt: null },
      },
      {
        boardItem: boardItem("asset", "asset-1"),
        archived: false,
        asset: { id: "asset-1", title: "diagram.png", updatedAt: null },
      },
      {
        boardItem: boardItem("subfolder", "child-folder"),
        archived: false,
        subfolder: { id: "child-folder", title: "하위 프로젝트" },
      },
      {
        boardItem: boardItem("frame", "frame-1", { title: "그룹" }),
        archived: false,
      },
    ]);

    const result = await new ContainerBrowseService(store).browse({
      container: { containerKind: "runbook", containerId: "runbook-1" },
    });
    const markdown = result.items[0];
    expect(markdown).toEqual(expect.objectContaining({ type: "markdown", title: "명세" }));
    if (markdown?.type !== "markdown") throw new Error("expected markdown");
    expect(Array.from(markdown.preview)).toHaveLength(240);
    expect(markdown.preview.endsWith("…")).toBe(true);
    expect(markdown.preview).not.toContain("\ud83d");
    expect(result.items.map((item) => item.type)).toEqual([
      "markdown",
      "runbook",
      "custom_view",
      "asset",
      "subfolder",
      "frame",
    ]);
  });

  it("clamps browse to 100, search to 50, and keeps the query container-scoped", async () => {
    expect(CONTAINER_SEARCH_SCAN_LIMIT).toBe(2_000);
    const { store, listContainerItems } = storeWith([], 275, {
      limit: 2_000,
      scannedItems: 2_000,
      truncated: true,
    });
    const service = new ContainerBrowseService(store);

    const browse = await service.browse({
      container: { containerKind: "folder", containerId: "folder-1" },
      cursor: 100,
      limit: 999,
      includeArchived: true,
    });
    expect(browse.page).toEqual({
      cursor: 100,
      limit: 100,
      total: 275,
      nextCursor: 200,
    });
    expect(listContainerItems).toHaveBeenNthCalledWith(1, expect.objectContaining({
      container: { containerKind: "folder", containerId: "folder-1" },
      cursor: 100,
      limit: 100,
      includeArchived: true,
      query: null,
    }));

    const search = await service.search({
      container: { containerKind: "runbook", containerId: "runbook-1" },
      query: "  명세 😀  ",
      limit: 999,
    });
    expect(listContainerItems).toHaveBeenNthCalledWith(2, expect.objectContaining({
      container: { containerKind: "runbook", containerId: "runbook-1" },
      cursor: 0,
      limit: 50,
      query: "명세 😀",
      itemTypes: ["session", "markdown"],
      scanLimit: 2_000,
    }));
    expect(search.search).toEqual({
      scanLimit: 2_000,
      scannedItems: 2_000,
      truncated: true,
    });
  });

  it("rejects missing containers before querying board items", async () => {
    const { store, listContainerItems } = storeWith([]);
    store.getRunbookById = vi.fn(async () => null);

    await expect(new ContainerBrowseService(store).browse({
      container: { containerKind: "runbook", containerId: "missing" },
    })).rejects.toThrow("runbook not found: missing");
    expect(listContainerItems).not.toHaveBeenCalled();
  });
});

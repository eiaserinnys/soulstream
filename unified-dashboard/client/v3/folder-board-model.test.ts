import { describe, expect, it } from "vitest";

import {
  type CatalogBoardItem,
  type SessionSummary,
} from "@seosoyoung/soul-ui";

import {
  buildFolderBoardCatalog,
  buildFolderBoardResourceTabs,
  clampFolderResourceWidth,
  extractFolderBoardSessionIds,
  initialFolderBoardResourceState,
  mergeFolderBoardSessions,
  openFolderWorkspaceResource,
  reconcileFolderBoardResourceState,
  clampFolderChatWidth,
  computeTabStripOverflow,
  TASK_CHAT_MAX_WIDTH_PX,
  TASK_CHAT_MIN_WIDTH_PX,
  TASK_RESOURCE_MAX_WIDTH_PX,
  TASK_RESOURCE_MIN_WIDTH_PX,
} from "./folder-board-model";

describe("task board bounded catalog", () => {
  it("builds stable built-in tabs and only the resources opened from the board", () => {
    const items = [
      {
        ...boardItem("rb-a", "markdown", "doc-b"),
        metadata: { title: "운영 노트" },
      },
      {
        ...boardItem("rb-a", "markdown", "doc-a"),
        metadata: { title: "기획서" },
      },
      {
        ...boardItem("rb-a", "markdown", "doc-b"),
        id: "duplicate-doc-b",
        metadata: { title: "중복" },
      },
      boardItem("rb-a", "asset", "asset-a"),
      {
        ...boardItem("rb-a", "custom_view", "view-a"),
        metadata: { title: "검증 현황" },
      },
    ];

    expect(buildFolderBoardResourceTabs(items, [
      { kind: "custom_view", resourceId: "view-a" },
      { kind: "document", resourceId: "doc-b" },
    ])).toEqual([
      { id: "checklist", kind: "checklist", title: "체크리스트" },
      { id: "sessions", kind: "sessions", title: "세션" },
      { id: "custom-view:view-a", kind: "custom_view", title: "검증 현황", customViewId: "view-a" },
      { id: "document:doc-b", kind: "document", title: "운영 노트", documentId: "doc-b" },
    ]);
    expect(buildFolderBoardResourceTabs(items, [], false)).toEqual([
      { id: "sessions", kind: "sessions", title: "세션" },
    ]);
  });

  it("keeps multiple Flux tabs in open order without duplicating an existing resource", () => {
    const first = openFolderWorkspaceResource(initialFolderBoardResourceState(), {
      kind: "custom_view",
      resourceId: "view-a",
    });
    const second = openFolderWorkspaceResource(first, {
      kind: "custom_view",
      resourceId: "view-b",
    });
    const reopened = openFolderWorkspaceResource(second, {
      kind: "custom_view",
      resourceId: "view-a",
    });

    expect(reopened.openedResources).toEqual([
      { kind: "custom_view", resourceId: "view-a" },
      { kind: "custom_view", resourceId: "view-b" },
    ]);
    expect(reopened.activeTabId).toBe("custom-view:view-a");
  });

  it("removes deleted resources and returns an invalid active tab to the checklist", () => {
    const openDocument = openFolderWorkspaceResource(initialFolderBoardResourceState(), {
      kind: "document",
      resourceId: "doc-a",
    });

    expect(reconcileFolderBoardResourceState(openDocument, [
      boardItem("rb-a", "asset", "asset-a"),
    ])).toEqual(initialFolderBoardResourceState());
  });

  it("extracts only unique session ids from the selected task", () => {
    expect(extractFolderBoardSessionIds([
      boardItem("rb-a", "session", "session-b"),
      boardItem("rb-a", "markdown", "doc-a"),
      boardItem("rb-a", "session", "session-a"),
      boardItem("rb-a", "session", "session-b"),
    ])).toEqual(["session-a", "session-b"]);
  });

  it("builds a central catalog without task sessions or checklist cards", () => {
    const items = [
      boardItem("rb-a", "session", "session-a"),
      boardItem("rb-a", "markdown", "doc-a"),
    ];
    const catalog = buildFolderBoardCatalog({
      currentCatalog: null,
      boardItems: items,
      sessions: [session("session-a", "첫 이름")],
      folderId: "rb-a",
      folderName: "업무 A",
    });

    expect(catalog.folders).toEqual([
      expect.objectContaining({ id: "rb-a", name: "업무 A" }),
    ]);
    expect(catalog.boardItems).toEqual(items);
    expect(catalog.sessions).toEqual({});
    expect(catalog.sessionList).toEqual([]);
  });

  it("lets the scoped live result override the task-only snapshot", () => {
    expect(mergeFolderBoardSessions(
      [session("session-a", "플래너 이름")],
      [session("session-a", "보드 이름"), session("session-b", "보드 B")],
    ).map((item) => item.displayName)).toEqual(["보드 이름", "보드 B"]);
  });
});

function boardItem(
  folderId: string,
  itemType: CatalogBoardItem["itemType"],
  itemId: string,
  x = 0,
): CatalogBoardItem {
  return {
    id: `${folderId}:${itemType}:${itemId}`,
    folderId: folderId,
    itemType,
    itemId,
    x,
    y: 0,
  };
}

function session(
  agentSessionId: string,
  displayName: string,
  status: SessionSummary["status"] = "completed",
): SessionSummary {
  return {
    agentSessionId,
    claudeSessionId: agentSessionId,
    status,
    displayName,
  } as unknown as SessionSummary;
}

describe("clampFolderResourceWidth", () => {
  it("keeps a width inside the range untouched", () => {
    expect(clampFolderResourceWidth(360)).toBe(360);
  });

  it("clamps below the minimum up to the left column floor", () => {
    expect(clampFolderResourceWidth(120)).toBe(TASK_RESOURCE_MIN_WIDTH_PX);
    expect(clampFolderResourceWidth(TASK_RESOURCE_MIN_WIDTH_PX - 1)).toBe(
      TASK_RESOURCE_MIN_WIDTH_PX,
    );
  });

  it("clamps above the maximum so the chat column is never invaded", () => {
    expect(clampFolderResourceWidth(2000)).toBe(TASK_RESOURCE_MAX_WIDTH_PX);
    expect(clampFolderResourceWidth(TASK_RESOURCE_MAX_WIDTH_PX + 1)).toBe(
      TASK_RESOURCE_MAX_WIDTH_PX,
    );
  });

  it("falls back to the minimum for non-finite input", () => {
    expect(clampFolderResourceWidth(Number.NaN)).toBe(TASK_RESOURCE_MIN_WIDTH_PX);
    expect(clampFolderResourceWidth(Number.POSITIVE_INFINITY)).toBe(
      TASK_RESOURCE_MAX_WIDTH_PX,
    );
  });
});

describe("clampFolderChatWidth", () => {
  it("keeps a width inside the range untouched", () => {
    expect(clampFolderChatWidth(460)).toBe(460);
  });

  it("clamps to the chat column floor and ceiling independently of the left panel", () => {
    expect(clampFolderChatWidth(100)).toBe(TASK_CHAT_MIN_WIDTH_PX);
    expect(clampFolderChatWidth(2000)).toBe(TASK_CHAT_MAX_WIDTH_PX);
  });

  it("uses a floor matching the grid chat column minmax lower bound", () => {
    expect(TASK_CHAT_MIN_WIDTH_PX).toBe(320);
  });

  it("falls back to the minimum for non-finite input", () => {
    expect(clampFolderChatWidth(Number.NaN)).toBe(TASK_CHAT_MIN_WIDTH_PX);
  });
});

describe("computeTabStripOverflow", () => {
  it("hides both chevrons when the strip does not overflow", () => {
    expect(computeTabStripOverflow({ scrollLeft: 0, clientWidth: 300, scrollWidth: 300 }))
      .toEqual({ canScrollLeft: false, canScrollRight: false });
  });

  it("shows only the right chevron at the start of an overflowing strip", () => {
    expect(computeTabStripOverflow({ scrollLeft: 0, clientWidth: 200, scrollWidth: 600 }))
      .toEqual({ canScrollLeft: false, canScrollRight: true });
  });

  it("shows only the left chevron at the end of an overflowing strip", () => {
    expect(computeTabStripOverflow({ scrollLeft: 400, clientWidth: 200, scrollWidth: 600 }))
      .toEqual({ canScrollLeft: true, canScrollRight: false });
  });

  it("shows both chevrons in the middle", () => {
    expect(computeTabStripOverflow({ scrollLeft: 200, clientWidth: 200, scrollWidth: 600 }))
      .toEqual({ canScrollLeft: true, canScrollRight: true });
  });
});

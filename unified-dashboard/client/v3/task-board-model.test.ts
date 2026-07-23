import { describe, expect, it } from "vitest";

import {
  filterTaskBoardSpatialItems,
  type CatalogBoardItem,
  type CatalogState,
  type SessionSummary,
} from "@seosoyoung/soul-ui";

import {
  buildTaskBoardCatalog,
  buildTaskBoardResourceTabs,
  extractTaskBoardSessionIds,
  mergeTaskBoardSessions,
  scopeCatalogUpdateToTaskBoard,
  scopeCatalogUpdateToTaskBoardPreservingSessionList,
} from "./task-board-model";

describe("task board bounded catalog", () => {
  it("builds stable checklist, delegation, and multi-document resource tabs", () => {
    expect(buildTaskBoardResourceTabs([
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
    ])).toEqual([
      { id: "checklist", kind: "checklist", title: "체크리스트" },
      { id: "sessions", kind: "sessions", title: "위임 관계" },
      { id: "document:doc-b", kind: "document", title: "운영 노트", documentId: "doc-b" },
      { id: "document:doc-a", kind: "document", title: "기획서", documentId: "doc-a" },
    ]);
  });

  it("keeps only spatial resource objects on the central board", () => {
    expect(filterTaskBoardSpatialItems([
      boardItem("rb-a", "session", "session-a"),
      boardItem("rb-a", "task", "rb-a"),
      boardItem("rb-a", "subfolder", "folder-b"),
      boardItem("rb-a", "markdown", "doc-a"),
      boardItem("rb-a", "asset", "asset-a"),
      boardItem("rb-a", "custom_view", "view-a"),
      boardItem("rb-a", "frame", "frame-a"),
    ]).map((item) => item.itemType)).toEqual([
      "markdown",
      "asset",
      "custom_view",
      "frame",
    ]);
  });

  it("extracts only unique session ids from the selected task", () => {
    expect(extractTaskBoardSessionIds([
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
    const catalog = buildTaskBoardCatalog({
      currentCatalog: null,
      boardItems: items,
      sessions: [session("session-a", "첫 이름")],
      projectFolderId: "folder-a",
      projectTitle: "프로젝트 A",
    });

    expect(catalog.folders).toEqual([
      expect.objectContaining({ id: "folder-a", name: "프로젝트 A" }),
    ]);
    expect(catalog.boardItems).toEqual([items[1]]);
    expect(catalog.sessions).toEqual({});
    expect(catalog.sessionList).toEqual([]);
  });

  it("filters a global catalog event before applying live names, status, and board moves", () => {
    const current = buildTaskBoardCatalog({
      currentCatalog: null,
      boardItems: [boardItem("rb-a", "session", "session-a")],
      sessions: [session("session-a", "이전 이름", "running")],
      projectFolderId: "folder-a",
      projectTitle: "프로젝트 A",
    });
    const globalUpdate: CatalogState = {
      folders: [
        { id: "folder-a", name: "프로젝트 A", sortOrder: 0 },
        { id: "folder-other", name: "다른 폴더", sortOrder: 1 },
      ],
      sessions: {
        "session-a": { folderId: "folder-a", displayName: "바뀐 이름" },
        "session-new": { folderId: "folder-a", displayName: "새 세션" },
        "session-other": { folderId: "folder-other", displayName: "범위 밖" },
      },
      boardItems: [
        boardItem("rb-a", "session", "session-a", 120),
        boardItem("rb-a", "session", "session-new", 240),
        boardItem("rb-other", "session", "session-other"),
      ],
      sessionList: [
        session("session-a", "바뀐 이름", "completed"),
        session("session-new", "새 세션", "running"),
        session("session-other", "범위 밖", "completed"),
      ],
    };

    const next = scopeCatalogUpdateToTaskBoard(current, globalUpdate, "rb-a");

    expect(next.boardItems).toEqual([]);
    expect(next.sessions).toEqual({});
    expect(next.sessionList).toEqual([]);
  });

  it("does not reintroduce sessions after a targeted session refresh", () => {
    const items = [boardItem("rb-a", "session", "session-a")];
    const current = buildTaskBoardCatalog({
      currentCatalog: null,
      boardItems: items,
      sessions: [session("session-a", "이전 이름", "running")],
      projectFolderId: "folder-a",
      projectTitle: "프로젝트 A",
    });

    const next = buildTaskBoardCatalog({
      currentCatalog: current,
      boardItems: items,
      sessions: [session("session-a", "바뀐 이름", "completed")],
      projectFolderId: "folder-a",
      projectTitle: "프로젝트 A",
    });

    expect(next.sessions).toEqual({});
    expect(next.sessionList).toEqual([]);
  });

  it("keeps the global session projection while scoping a task-board catalog update", () => {
    const outside = session("session-outside", "다른 업무", "running");
    const task = session("session-a", "업무 세션", "running");
    const current: CatalogState = {
      ...buildTaskBoardCatalog({
        currentCatalog: null,
        boardItems: [boardItem("rb-a", "session", "session-a")],
        sessions: [session("session-a", "업무 세션")],
        projectFolderId: "folder-a",
        projectTitle: "프로젝트 A",
      }),
      sessionList: [task, outside],
    };
    const incoming: CatalogState = {
      ...current,
      sessionList: [session("session-a", "업무 세션", "completed"), { ...outside }],
    };

    const next = scopeCatalogUpdateToTaskBoardPreservingSessionList(current, incoming, "rb-a");

    expect(next.sessionList).not.toBe(current.sessionList);
    expect(next.sessionList?.[0]).not.toBe(task);
    expect(next.sessionList?.[0]?.status).toBe("completed");
    expect(next.sessionList?.[1]).toBe(outside);
  });

  it("lets the scoped live result override the task-only snapshot", () => {
    expect(mergeTaskBoardSessions(
      [session("session-a", "플래너 이름")],
      [session("session-a", "보드 이름"), session("session-b", "보드 B")],
    ).map((item) => item.displayName)).toEqual(["보드 이름", "보드 B"]);
  });
});

function boardItem(
  taskId: string,
  itemType: CatalogBoardItem["itemType"],
  itemId: string,
  x = 0,
): CatalogBoardItem {
  return {
    id: `${taskId}:${itemType}:${itemId}`,
    folderId: "folder-a",
    containerKind: "task",
    containerId: taskId,
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

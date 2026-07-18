import { describe, expect, it } from "vitest";

import type {
  CatalogBoardItem,
  CatalogState,
  SessionSummary,
} from "@seosoyoung/soul-ui";

import {
  buildTaskBoardCatalog,
  extractTaskBoardSessionIds,
  mergeTaskBoardSessions,
  scopeCatalogUpdateToTaskBoard,
  scopeCatalogUpdateToTaskBoardPreservingSessionList,
} from "./task-board-model";

describe("task board bounded catalog", () => {
  it("extracts only unique session ids from the selected task", () => {
    expect(extractTaskBoardSessionIds([
      boardItem("rb-a", "session", "session-b"),
      boardItem("rb-a", "markdown", "doc-a"),
      boardItem("rb-a", "session", "session-a"),
      boardItem("rb-a", "session", "session-b"),
    ])).toEqual(["session-a", "session-b"]);
  });

  it("builds a catalog containing only the selected task and its sessions", () => {
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
    expect(catalog.boardItems).toEqual(items);
    expect(Object.keys(catalog.sessions)).toEqual(["session-a"]);
    expect(catalog.sessions["session-a"].displayName).toBe("첫 이름");
    expect(catalog.sessionList?.map((item) => item.agentSessionId)).toEqual(["session-a"]);
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

    expect(next.boardItems).toHaveLength(2);
    expect(next.boardItems?.map((item) => item.itemId)).toEqual(["session-a", "session-new"]);
    expect(next.boardItems?.[0].x).toBe(120);
    expect(Object.keys(next.sessions)).toEqual(["session-a", "session-new"]);
    expect(next.sessions["session-a"].displayName).toBe("바뀐 이름");
    expect(next.sessionList).toEqual([
      expect.objectContaining({ agentSessionId: "session-a", status: "completed" }),
      expect.objectContaining({ agentSessionId: "session-new", status: "running" }),
    ]);
  });

  it("replaces stale catalog names and status after a targeted session refresh", () => {
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

    expect(next.sessions["session-a"].displayName).toBe("바뀐 이름");
    expect(next.sessionList).toEqual([
      expect.objectContaining({
        agentSessionId: "session-a",
        displayName: "바뀐 이름",
        status: "completed",
      }),
    ]);
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

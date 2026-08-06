import { beforeEach, describe, expect, it, vi } from "vitest";

import { CatalogService } from "../../src/catalog/catalog_service.js";
import { SessionDB, type SqlClient } from "../../src/db/session_db.js";
import type { SessionBroadcaster } from "../../src/upstream/session_broadcaster.js";
import { FolderControlPlaneService } from "../../../orch-server-ts/src/folders/folder_control_plane_service.js";
import type { FolderHostClient } from "../../src/folder/folder_host_client.js";
import { configureTestBoardProjectionReadHost } from "../helpers/configure_test_board_projection_host.js";

interface MockCall {
  fragments: string[];
  values: unknown[];
  inTransaction: boolean;
}

function createMockSql(resultFor?: (call: MockCall) => unknown[]) {
  const calls: MockCall[] = [];
  let inTransaction = false;
  const fn = ((strings: TemplateStringsArray, ...values: unknown[]) => {
    const call: MockCall = { fragments: Array.from(strings), values, inTransaction };
    calls.push(call);
    const result = resultFor ? resultFor(call) : [];
    return Promise.resolve(result);
  }) as unknown as SqlClient & {
    array: (a: unknown[]) => unknown[];
    json: (value: unknown) => unknown;
    end: () => Promise<void>;
    begin: <T>(callback: (sql: SqlClient) => Promise<T>) => Promise<T>;
  };
  fn.array = (a: unknown[]) => a;
  fn.json = (value: unknown) => value;
  fn.end = vi.fn().mockResolvedValue(undefined);
  fn.begin = vi.fn(async <T>(callback: (sql: SqlClient) => Promise<T>) => {
    inTransaction = true;
    try {
      return await callback(fn as unknown as SqlClient);
    } finally {
      inTransaction = false;
    }
  });
  return { sql: fn as unknown as SqlClient, calls };
}

function createSessionDb(sql: SqlClient): SessionDB {
  const db = new SessionDB(sql);
  configureTestBoardProjectionReadHost(db, sql);
  db.configureFolderHost(
    new FolderControlPlaneService(sql as never) as unknown as FolderHostClient,
  );
  return db;
}

function createBroadcasterMock() {
  const emitCatalogUpdated = vi.fn().mockResolvedValue(undefined);
  const emitSessionDeleted = vi.fn().mockResolvedValue(undefined);
  return {
    broadcaster: {
      emitCatalogUpdated,
      emitSessionDeleted,
    } as unknown as SessionBroadcaster,
    emitCatalogUpdated,
    emitSessionDeleted,
  };
}

/** 변경 이벤트용 폴더 목록을 반환하는 stub. */
function setupSqlWithCatalog() {
  return createMockSql((call) => {
    const text = call.fragments.join("|");
    if (text.includes("folder_get_all"))
      return [{
        id: "f1",
        name: "F1",
        sort_order: 0,
        settings: {},
        parent_folder_id: null,
        project_page_id: "page-f1",
        archived: false,
      }];
    if (text.includes("catalog_get_sessions"))
      return [{ session_id: "s1", folder_id: "f1", display_name: "Hi" }];
    if (text.includes("FROM sessions") && text.includes("session_id = ANY")) {
      const sessionIds = call.values[0] as string[];
      return sessionIds.map((sessionId) => ({
        session_id: sessionId,
        folder_id: "f1",
        display_name: `Session ${sessionId}`,
      }));
    }
    if (text.includes("UPDATE sessions") && text.includes("RETURNING"))
      return [{ session_id: "s1", folder_id: null, display_name: "Hi" }];
    if (text.includes("DELETE FROM board_items") && text.includes("RETURNING"))
      return [{ id: "session:s1" }];
    if (text.includes("FROM sessions") && text.includes("WHERE folder_id"))
      return [{ session_id: "s1", folder_id: "f1", display_name: "Hi" }];
    if (text.includes("FROM session_get"))
      return [{
        session_id: String(call.values[0]),
        folder_id: "f1",
        display_name: `Session ${String(call.values[0])}`,
      }];
    if (text.includes("SELECT id") && text.includes("FROM board_items"))
      return [{ id: "session:s1" }];
    return [];
  });
}

describe("CatalogService.listFolders", () => {
  it("getAllFolders 결과를 sortOrder/settings 키로 정규화", async () => {
    const createdAt = new Date("2026-06-03T00:00:00.000Z");
    const { sql } = createMockSql(() => [
      {
        id: "f1",
        name: "F1",
        sort_order: 1,
        settings: { x: 1 },
        parent_folder_id: null,
        project_page_id: "page-f1",
        archived: false,
        created_at: createdAt,
      },
      {
        id: "f2",
        name: "F2",
        sort_order: 2,
        settings: null,
        parent_folder_id: "f1",
        project_page_id: null,
        archived: false,
      },
    ]);
    const db = createSessionDb(sql);
    const { broadcaster } = createBroadcasterMock();
    const svc = new CatalogService(db, broadcaster);
    const folders = await svc.listFolders();
    expect(folders).toEqual([
      {
        id: "f1",
        name: "F1",
        sortOrder: 1,
        settings: { x: 1 },
        parentFolderId: null,
        projectPageId: "page-f1",
        createdAt: "2026-06-03T00:00:00.000Z",
      },
      { id: "f2", name: "F2", sortOrder: 2, settings: {}, parentFolderId: "f1", projectPageId: null },
    ]);
  });
});

describe("CatalogService.createFolder", () => {
  it("uses the orch identity host for MCP create/rename/delete without a local DB fallback", async () => {
    const { sql, calls } = setupSqlWithCatalog();
    const db = createSessionDb(sql);
    const { broadcaster, emitCatalogUpdated } = createBroadcasterMock();
    const identityId = "00000000-0000-4000-8000-0000000000af";
    const host = {
      create: vi.fn(async (input: { name: string; sortOrder: number; parentFolderId: string | null }) => ({
        id: identityId,
        pageId: identityId,
        folder: {
          id: identityId,
          name: input.name,
          sortOrder: input.sortOrder,
          settings: {},
          parentFolderId: input.parentFolderId,
          projectPageId: identityId,
        },
      })),
      rename: vi.fn(async () => ({})),
      archive: vi.fn(async () => ({})),
    };
    const svc = new CatalogService(db, broadcaster, undefined, host as never);

    await expect(svc.createFolder("MCP 프로젝트", 4, null)).resolves.toMatchObject({
      id: identityId,
      projectPageId: identityId,
    });
    await svc.renameFolder(identityId, "MCP 이름 변경");
    await svc.deleteFolder(identityId);

    expect(host.create).toHaveBeenCalledTimes(1);
    expect(host.rename).toHaveBeenCalledTimes(1);
    expect(host.archive).toHaveBeenCalledTimes(1);
    expect(calls.some((call) => call.fragments.join("|").includes("folder_create"))).toBe(false);
    expect(emitCatalogUpdated).not.toHaveBeenCalled();
  });
});

describe("CatalogService.listChildFolders", () => {
  it("현재 폴더의 직접 자식 폴더만 반환하고 손자 폴더는 제외", async () => {
    const { sql } = createMockSql(() => [
      { id: "root", name: "Root", sort_order: 0, settings: {}, parent_folder_id: null },
      { id: "child-a", name: "Child A", sort_order: 1, settings: {}, parent_folder_id: "root" },
      { id: "child-b", name: "Child B", sort_order: 2, settings: {}, parent_folder_id: "root" },
      { id: "grand", name: "Grand", sort_order: 3, settings: {}, parent_folder_id: "child-a" },
    ]);
    const db = createSessionDb(sql);
    const { broadcaster } = createBroadcasterMock();
    const svc = new CatalogService(db, broadcaster);

    await expect(svc.listChildFolders("root")).resolves.toEqual([
      { id: "child-a", name: "Child A", sortOrder: 1, settings: {}, parentFolderId: "root", projectPageId: null },
      { id: "child-b", name: "Child B", sortOrder: 2, settings: {}, parentFolderId: "root", projectPageId: null },
    ]);
  });
});

describe("CatalogService.browseFolder", () => {
  it("직접 자식 폴더, 세션 페이지, 문서/파일 보드 항목을 한 번에 반환", async () => {
    const { sql } = createMockSql((call) => {
      const text = call.fragments.join("|");
      if (text.includes("folder_get_all")) {
        return [
          { id: "root", name: "Root", sort_order: 0, settings: {}, parent_folder_id: null },
          { id: "child", name: "Child", sort_order: 1, settings: {}, parent_folder_id: "root" },
          { id: "grand", name: "Grand", sort_order: 2, settings: {}, parent_folder_id: "child" },
        ];
      }
      return [];
    });
    const db = createSessionDb(sql);
    vi.spyOn(db, "getFolderById").mockResolvedValue({
      id: "root",
      name: "Root",
      sort_order: 0,
      settings: {},
      parent_folder_id: null,
    });
    const listContainerItems = vi.spyOn(db, "listContainerItems").mockImplementation(
      async (params) => {
        if (params.itemTypes?.includes("session")) {
          return {
            items: [{
              boardItem: {
                id: "session:sess-a",
                folderId: "root",
                containerKind: "folder",
                containerId: "root",
                itemType: "session",
                itemId: "sess-a",
                x: 0,
                y: 0,
                metadata: {},
              },
              archived: false,
              session: {
                agentSessionId: "sess-a",
                displayName: "Session A",
                lastUserMessagePreview: "Prompt",
                status: "running",
                agentId: null,
                sessionType: "claude",
                createdAt: "2026-06-17T00:00:00.000Z",
                updatedAt: "2026-06-17T01:00:00.000Z",
                eventCount: 5,
                awaySummary: null,
                callerSessionId: null,
                predecessorSessionId: null,
                nodeId: "node-a",
                lastEventId: 50,
                lastReadEventId: 40,
              },
            }],
            total: 2,
            counts: { session: 2, markdown: 0, subfolder: 0, asset: 0, frame: 0, task: 0, custom_view: 0 },
          };
        }
        const boardItems = [
          {
            id: "markdown:doc-1",
            folderId: "root",
            containerKind: "folder" as const,
            containerId: "root",
            itemType: "markdown" as const,
            itemId: "doc-1",
            x: 0,
            y: 0,
            metadata: { title: "Spec" },
          },
          {
            id: "asset:asset-1",
            folderId: "root",
            containerKind: "folder" as const,
            containerId: "root",
            itemType: "asset" as const,
            itemId: "asset-1",
            x: 280,
            y: 0,
            metadata: { originalName: "image.png" },
          },
        ];
        return {
          items: boardItems.map((boardItem) => ({ boardItem, archived: false })),
          total: 2,
          counts: { session: 0, markdown: 1, subfolder: 0, asset: 1, frame: 0, task: 0, custom_view: 0 },
        };
      },
    );
    const { broadcaster } = createBroadcasterMock();
    const svc = new CatalogService(db, broadcaster);

    const result = await svc.browseFolder({
      folderId: "root",
      sessionCursor: 0,
      sessionLimit: 1,
    });

    expect(result.folder.id).toBe("root");
    expect(result.childFolders.map((folder) => folder.id)).toEqual(["child"]);
    expect(result.sessions).toEqual([
      expect.objectContaining({
        sessionId: "sess-a",
        title: "Session A",
        status: "running",
        eventCount: 5,
        nodeId: "node-a",
      }),
    ]);
    expect(result.sessionsPage).toEqual({
      cursor: 0,
      limit: 1,
      total: 2,
      nextCursor: 1,
    });
    expect(result.boardItems.map((item) => item.itemId)).toEqual(["doc-1", "asset-1"]);
    expect(result.counts).toEqual({
      childFolders: 1,
      sessions: 2,
      boardItems: 2,
      documents: 1,
      assets: 1,
    });

    expect(listContainerItems).toHaveBeenCalledWith(expect.objectContaining({
      container: { containerKind: "folder", containerId: "root" },
      itemTypes: ["session"],
      limit: 1,
      cursor: 0,
    }));
  });

  it("없는 폴더는 명시적으로 거부", async () => {
    const { sql } = createMockSql((call) => {
      if (call.fragments.join("|").includes("folder_get_all")) return [];
      return [];
    });
    const db = createSessionDb(sql);
    const { broadcaster } = createBroadcasterMock();
    const svc = new CatalogService(db, broadcaster);

    await expect(svc.browseFolder({ folderId: "missing" })).rejects.toThrow(
      "folder not found: missing",
    );
  });
});

describe("CatalogService.setFolderParent", () => {
  it("parent_folder_id 갱신 + null 루트 복귀 후 broadcast", async () => {
    const { sql, calls } = createMockSql((call) => {
      const text = call.fragments.join("|");
      if (text.includes("folder_get_all"))
        return [
          { id: "root", name: "Root", sort_order: 0, settings: {}, parent_folder_id: null },
          { id: "child", name: "Child", sort_order: 1, settings: {}, parent_folder_id: "root" },
        ];
      if (text.includes("catalog_get_sessions")) return [];
      return [];
    });
    const db = createSessionDb(sql);
    const { broadcaster, emitCatalogUpdated } = createBroadcasterMock();
    const svc = new CatalogService(db, broadcaster);

    await svc.setFolderParent("child", "root");
    await svc.setFolderParent("child", null);

    const updates = calls.filter((c) =>
      c.fragments.join("|").includes("folder_update"),
    );
    expect(updates).toHaveLength(2);
    expect(updates[0]!.values).toEqual(["child", ["parent_folder_id"], ["root"]]);
    expect(updates[1]!.values).toEqual(["child", ["parent_folder_id"], [null]]);
    expect(emitCatalogUpdated).toHaveBeenCalledTimes(2);
  });

  it("자기 자신을 parent로 지정하면 DB update 전에 거부", async () => {
    const { sql, calls } = setupSqlWithCatalog();
    const db = createSessionDb(sql);
    const { broadcaster } = createBroadcasterMock();
    const svc = new CatalogService(db, broadcaster);

    await expect(svc.setFolderParent("f1", "f1")).rejects.toThrow(/cycle/);
    expect(calls.some((c) => c.fragments.join("|").includes("folder_update"))).toBe(false);
  });

  it("후손 폴더를 parent로 지정하면 DB update 전에 거부", async () => {
    const { sql, calls } = createMockSql((call) => {
      if (call.fragments.join("|").includes("folder_get_all"))
        return [
          { id: "root", name: "Root", sort_order: 0, settings: {}, parent_folder_id: null },
          { id: "child", name: "Child", sort_order: 1, settings: {}, parent_folder_id: "root" },
          { id: "grand", name: "Grand", sort_order: 2, settings: {}, parent_folder_id: "child" },
        ];
      return [];
    });
    const db = createSessionDb(sql);
    const { broadcaster } = createBroadcasterMock();
    const svc = new CatalogService(db, broadcaster);

    await expect(svc.setFolderParent("root", "grand")).rejects.toThrow(/cycle/);
    expect(calls.some((c) => c.fragments.join("|").includes("folder_update"))).toBe(false);
  });

  it("시스템 폴더 move는 DB update 전에 거부", async () => {
    const { sql, calls } = setupSqlWithCatalog();
    const db = createSessionDb(sql);
    const { broadcaster } = createBroadcasterMock();
    const svc = new CatalogService(db, broadcaster);

    await expect(svc.setFolderParent("claude", null)).rejects.toThrow(/system folder/i);
    expect(calls.some((c) => c.fragments.join("|").includes("folder_update"))).toBe(false);
  });
});

describe("CatalogService.renameFolder", () => {
  it("folder_update(columns=['name'], values=[name]) + broadcast", async () => {
    const { sql, calls } = setupSqlWithCatalog();
    const db = createSessionDb(sql);
    const { broadcaster, emitCatalogUpdated } = createBroadcasterMock();
    const svc = new CatalogService(db, broadcaster);

    await svc.renameFolder("f1", "새 이름");

    const updateCall = calls.find((c) =>
      c.fragments.join("|").includes("folder_update"),
    );
    expect(updateCall).toBeDefined();
    expect(updateCall!.values).toEqual(["f1", ["name"], ["새 이름"]]);
    expect(emitCatalogUpdated).toHaveBeenCalledTimes(1);
  });

  it("시스템 폴더 rename은 DB update 전에 거부", async () => {
    const { sql, calls } = setupSqlWithCatalog();
    const db = createSessionDb(sql);
    const { broadcaster } = createBroadcasterMock();
    const svc = new CatalogService(db, broadcaster);

    await expect(svc.renameFolder("claude", "새 이름")).rejects.toThrow(/system folder/i);
    expect(calls.some((c) => c.fragments.join("|").includes("folder_update"))).toBe(false);
  });
});

describe("CatalogService.deleteFolder", () => {
  it("시스템 폴더 delete는 DB delete 전에 거부", async () => {
    const { sql, calls } = setupSqlWithCatalog();
    const db = createSessionDb(sql);
    const { broadcaster } = createBroadcasterMock();
    const svc = new CatalogService(db, broadcaster);

    await expect(svc.deleteFolder("llm")).rejects.toThrow(/system folder/i);
    expect(calls.some((c) => c.fragments.join("|").includes("SET archived = TRUE")))
      .toBe(false);
  });
});

describe("CatalogService.moveSessionsToFolder", () => {
  it("세션마다 session_assign_folder 호출 후 1회 broadcast", async () => {
    const { sql, calls } = setupSqlWithCatalog();
    const db = createSessionDb(sql);
    const { broadcaster, emitCatalogUpdated } = createBroadcasterMock();
    const svc = new CatalogService(db, broadcaster);

    await svc.moveSessionsToFolder(["s1", "s2", "s3"], "f1");

    const assigns = calls.filter((c) =>
      c.fragments.join("|").includes("session_assign_folder"),
    );
    expect(assigns).toHaveLength(3);
    expect(assigns.map((c) => c.values[0])).toEqual(["s1", "s2", "s3"]);
    const assignmentReads = calls.filter((c) =>
      c.fragments.join("|").includes("session_id = ANY"),
    );
    expect(assignmentReads).toHaveLength(1);
    expect(assignmentReads[0]?.values[0]).toEqual(["s1", "s2", "s3"]);
    expect(emitCatalogUpdated).toHaveBeenCalledWith(
      expect.any(Array),
      {
        s1: { folderId: "f1", displayName: "Session s1" },
        s2: { folderId: "f1", displayName: "Session s2" },
        s3: { folderId: "f1", displayName: "Session s3" },
      },
      {},
    );
  });

  it("folderId=null → 폴더 해제 (각 호출에 null 전달)", async () => {
    const { sql, calls } = setupSqlWithCatalog();
    const db = createSessionDb(sql);
    const { broadcaster } = createBroadcasterMock();
    const svc = new CatalogService(db, broadcaster);

    await svc.moveSessionsToFolder(["s1"], null);

    const assigns = calls.filter((c) =>
      c.fragments.join("|").includes("session_assign_folder"),
    );
    expect(assigns[0].values).toEqual(["s1", null]);
  });
});

describe("CatalogService board items", () => {
  it("moveBoardItemToContainer는 미영속 세션 타일을 대상 task에 편입한다", async () => {
    const assignSessionToFolder = vi.fn().mockResolvedValue(undefined);
    const upsertSessionBoardItem = vi.fn().mockResolvedValue({
      id: "session:s1",
      folderId: "f1",
      containerKind: "task",
      containerId: "rb-1",
      membershipKind: "primary",
      sourceTaskItemId: null,
      itemType: "session",
      itemId: "s1",
      x: 120,
      y: 240,
      metadata: {},
    });
    const db = {
      resolveBoardYjsContainerScope: vi.fn().mockResolvedValue({
        folderId: "f1",
        containerKind: "task",
        containerId: "rb-1",
      }),
      getBoardItemById: vi.fn().mockResolvedValue(null),
      getSession: vi.fn().mockResolvedValue({ session_id: "s1", folder_id: "f1" }),
      getSessionAssignmentsByIds: vi.fn().mockResolvedValue([
        { session_id: "s1", folder_id: "f1", display_name: null },
      ]),
      assignSessionToFolder,
      getAllFolders: vi.fn().mockResolvedValue([]),
    } as unknown as SessionDB;
    const boardYjsService = {
      upsertSessionBoardItem,
    };
    const { broadcaster, emitCatalogUpdated } = createBroadcasterMock();
    const svc = new CatalogService(db, broadcaster, boardYjsService as never);

    const result = await svc.moveBoardItemToContainer({
      boardItemId: "session:s1",
      target: { containerKind: "task", containerId: "rb-1" },
      position: { x: 121, y: 239 },
      idempotencyKey: "move-1",
    });

    expect(result.enrolled).toBe(true);
    expect(result.boardItem).toMatchObject({
      id: "session:s1",
      folderId: "f1",
      containerKind: "task",
      containerId: "rb-1",
      x: 120,
      y: 240,
    });
    expect(assignSessionToFolder).toHaveBeenCalledWith("s1", "f1");
    expect(upsertSessionBoardItem).toHaveBeenCalledWith({
      folderId: "f1",
      container: { containerKind: "task", containerId: "rb-1" },
      sessionId: "s1",
      sourceTaskItemId: null,
      x: 120,
      y: 240,
    });
    expect(emitCatalogUpdated).toHaveBeenCalledTimes(1);
  });

  it("moveBoardItemToContainer는 DB-only stale 세션도 target folder 기준으로 편입한다", async () => {
    const assignSessionToFolder = vi.fn().mockResolvedValue(undefined);
    const moveBoardItemToContainer = vi.fn().mockRejectedValue(
      new Error("board item not found in source Y.Doc: session:s1"),
    );
    const upsertSessionBoardItem = vi.fn().mockResolvedValue({
      id: "session:s1",
      folderId: "target-folder",
      containerKind: "task",
      containerId: "rb-1",
      membershipKind: "primary",
      sourceTaskItemId: null,
      itemType: "session",
      itemId: "s1",
      x: 280,
      y: 0,
      metadata: {},
    });
    const db = {
      resolveBoardYjsContainerScope: vi.fn().mockResolvedValue({
        folderId: "target-folder",
        containerKind: "task",
        containerId: "rb-1",
      }),
      getBoardItemById: vi.fn().mockResolvedValue({
        id: "session:s1",
        folderId: "source-folder",
        containerKind: "folder",
        containerId: "source-folder",
        membershipKind: "primary",
        sourceTaskItemId: null,
        itemType: "session",
        itemId: "s1",
        x: 0,
        y: 0,
        metadata: {},
      }),
      getSession: vi.fn().mockResolvedValue({ session_id: "s1", folder_id: "source-folder" }),
      getSessionAssignmentsByIds: vi.fn().mockResolvedValue([
        { session_id: "s1", folder_id: "target-folder", display_name: null },
      ]),
      assignSessionToFolder,
      getBoardItems: vi.fn().mockResolvedValue([
        {
          folderId: "target-folder",
          containerKind: "task",
          containerId: "rb-1",
          x: 0,
          y: 0,
        },
      ]),
      getAllFolders: vi.fn().mockResolvedValue([]),
    } as unknown as SessionDB;
    const boardYjsService = {
      moveBoardItemToContainer,
      upsertSessionBoardItem,
    };
    const { broadcaster, emitCatalogUpdated } = createBroadcasterMock();
    const svc = new CatalogService(db, broadcaster, boardYjsService as never);

    const result = await svc.moveBoardItemToContainer({
      boardItemId: "session:s1",
      target: { containerKind: "task", containerId: "rb-1" },
      idempotencyKey: "move-1",
    });

    expect(result.enrolled).toBe(true);
    expect(assignSessionToFolder).toHaveBeenCalledWith("s1", "target-folder");
    expect(assignSessionToFolder).not.toHaveBeenCalledWith("s1", "source-folder");
    expect(upsertSessionBoardItem).toHaveBeenCalledWith({
      folderId: "target-folder",
      container: { containerKind: "task", containerId: "rb-1" },
      sessionId: "s1",
      sourceTaskItemId: null,
      x: 280,
      y: 0,
    });
    expect(emitCatalogUpdated).toHaveBeenCalledTimes(1);
  });

  it("moveBoardItemToContainer의 미영속 세션 편입은 재시도해도 같은 대상에 upsert한다", async () => {
    const upsertSessionBoardItem = vi.fn(async (input: {
      folderId: string;
      container: { containerKind: "task"; containerId: string };
      sessionId: string;
      x: number;
      y: number;
    }) => ({
      id: `session:${input.sessionId}`,
      folderId: input.folderId,
      containerKind: input.container.containerKind,
      containerId: input.container.containerId,
      membershipKind: "primary" as const,
      sourceTaskItemId: null,
      itemType: "session" as const,
      itemId: input.sessionId,
      x: input.x,
      y: input.y,
      metadata: {},
    }));
    const db = {
      resolveBoardYjsContainerScope: vi.fn().mockResolvedValue({
        folderId: "f1",
        containerKind: "task",
        containerId: "rb-1",
      }),
      getBoardItemById: vi.fn().mockResolvedValue(null),
      getSession: vi.fn().mockResolvedValue({ session_id: "s1", folder_id: "f1" }),
      getSessionAssignmentsByIds: vi.fn().mockResolvedValue([
        { session_id: "s1", folder_id: "f1", display_name: null },
      ]),
      assignSessionToFolder: vi.fn().mockResolvedValue(undefined),
      getAllFolders: vi.fn().mockResolvedValue([]),
    } as unknown as SessionDB;
    const { broadcaster } = createBroadcasterMock();
    const svc = new CatalogService(db, broadcaster, { upsertSessionBoardItem } as never);
    const params = {
      boardItemId: "session:s1",
      target: { containerKind: "task" as const, containerId: "rb-1" },
      position: { x: 120, y: 240 },
      idempotencyKey: "move-1",
    };

    const first = await svc.moveBoardItemToContainer(params);
    const second = await svc.moveBoardItemToContainer(params);

    expect(first).toEqual(second);
    expect(upsertSessionBoardItem).toHaveBeenCalledTimes(2);
    expect(first.enrolled).toBe(true);
  });

  it("moveBoardItemToContainer는 실재하지 않는 세션 id를 여전히 거부한다", async () => {
    const assignSessionToFolder = vi.fn().mockResolvedValue(undefined);
    const upsertSessionBoardItem = vi.fn().mockResolvedValue(undefined);
    const db = {
      resolveBoardYjsContainerScope: vi.fn().mockResolvedValue({
        folderId: "f1",
        containerKind: "task",
        containerId: "rb-1",
      }),
      getBoardItemById: vi.fn().mockResolvedValue(null),
      getSession: vi.fn().mockResolvedValue(null),
      assignSessionToFolder,
      getAllFolders: vi.fn().mockResolvedValue([]),
    } as unknown as SessionDB;
    const { broadcaster, emitCatalogUpdated } = createBroadcasterMock();
    const svc = new CatalogService(db, broadcaster, { upsertSessionBoardItem } as never);

    await expect(svc.moveBoardItemToContainer({
      boardItemId: "session:missing",
      target: { containerKind: "task", containerId: "rb-1" },
      idempotencyKey: "move-1",
    })).rejects.toThrow("board item not found: session:missing");

    expect(assignSessionToFolder).not.toHaveBeenCalled();
    expect(upsertSessionBoardItem).not.toHaveBeenCalled();
    expect(emitCatalogUpdated).not.toHaveBeenCalled();
  });

  it("moveBoardItemToContainer의 기존 정상 이동은 BoardYjsService move 경로를 유지한다", async () => {
    const assignSessionToFolder = vi.fn().mockResolvedValue(undefined);
    const moveBoardItemToContainer = vi.fn().mockResolvedValue({
      id: "session:s1",
      folderId: "target-folder",
      containerKind: "task",
      containerId: "rb-1",
      membershipKind: "primary",
      sourceTaskItemId: null,
      itemType: "session",
      itemId: "s1",
      x: 120,
      y: 240,
      metadata: {},
    });
    const upsertSessionBoardItem = vi.fn().mockResolvedValue(undefined);
    const db = {
      resolveBoardYjsContainerScope: vi.fn().mockResolvedValue({
        folderId: "target-folder",
        containerKind: "task",
        containerId: "rb-1",
      }),
      getBoardItemById: vi.fn().mockResolvedValue({
        id: "session:s1",
        folderId: "source-folder",
        containerKind: "folder",
        containerId: "source-folder",
        membershipKind: "primary",
        sourceTaskItemId: null,
        itemType: "session",
        itemId: "s1",
        x: 0,
        y: 0,
        metadata: {},
      }),
      getSession: vi.fn().mockResolvedValue({ session_id: "s1", folder_id: "source-folder" }),
      getSessionAssignmentsByIds: vi.fn().mockResolvedValue([
        { session_id: "s1", folder_id: "target-folder", display_name: null },
      ]),
      assignSessionToFolder,
      getAllFolders: vi.fn().mockResolvedValue([]),
    } as unknown as SessionDB;
    const { broadcaster, emitCatalogUpdated } = createBroadcasterMock();
    const svc = new CatalogService(
      db,
      broadcaster,
      { moveBoardItemToContainer, upsertSessionBoardItem } as never,
    );

    const result = await svc.moveBoardItemToContainer({
      boardItemId: "session:s1",
      target: { containerKind: "task", containerId: "rb-1" },
      position: { x: 121, y: 239 },
      idempotencyKey: "move-1",
    });

    expect(result.enrolled).toBe(false);
    expect(moveBoardItemToContainer).toHaveBeenCalledWith({
      boardItem: expect.objectContaining({ id: "session:s1" }),
      targetScope: { folderId: "target-folder", containerKind: "task", containerId: "rb-1" },
      position: { x: 120, y: 240 },
      idempotencyKey: "move-1",
    });
    expect(upsertSessionBoardItem).not.toHaveBeenCalled();
    expect(assignSessionToFolder).toHaveBeenCalledWith("s1", "target-folder");
    expect(emitCatalogUpdated).toHaveBeenCalledTimes(1);
  });

  it("moveBoardItemToContainer는 task 업무 이동을 서버 identity 정본에 위임한다", async () => {
    const source = {
      id: "task:rb-task",
      folderId: "source-folder",
      containerKind: "folder" as const,
      containerId: "source-folder",
      membershipKind: "primary" as const,
      sourceTaskItemId: null,
      itemType: "task" as const,
      itemId: "rb-task",
      x: 0,
      y: 0,
      metadata: {},
    };
    const moved = { ...source, folderId: "target-folder", containerId: "target-folder" };
    const moveBoardItemToContainer = vi.fn().mockResolvedValue(moved);
    const db = {
      resolveBoardYjsContainerScope: vi.fn().mockResolvedValue({
        folderId: "target-folder",
        containerKind: "folder",
        containerId: "target-folder",
      }),
      getBoardItemById: vi.fn().mockResolvedValue(source),
      getAllFolders: vi.fn().mockResolvedValue([]),
    } as unknown as SessionDB;
    const { broadcaster } = createBroadcasterMock();
    const svc = new CatalogService(db, broadcaster, { moveBoardItemToContainer } as never);

    await expect(svc.moveBoardItemToContainer({
      boardItemId: source.id,
      target: { containerKind: "folder", containerId: "target-folder" },
      idempotencyKey: "move-task-1",
    })).resolves.toMatchObject({ boardItem: moved, enrolled: false });

    expect(moveBoardItemToContainer).toHaveBeenCalledWith({
      boardItem: source,
      targetScope: {
        folderId: "target-folder",
        containerKind: "folder",
        containerId: "target-folder",
      },
      idempotencyKey: "move-task-1",
    });
  });

  it("createMarkdownDocument는 orch Board Yjs mutation port만 사용한다", async () => {
    const db = {
      getAllFolders: vi.fn().mockResolvedValue([]),
    } as unknown as SessionDB;
    const boardYjsService = {
      createMarkdownDocument: vi.fn().mockResolvedValue({
        document: { id: "doc-1", title: "Note", body: "Body", version: 1 },
        boardItem: { id: "markdown:doc-1", folderId: "f1", itemType: "markdown", itemId: "doc-1", x: 60, y: 100 },
      }),
    };
    const { broadcaster, emitCatalogUpdated } = createBroadcasterMock();
    const svc = new CatalogService(db, broadcaster, boardYjsService as never);

    const result = await svc.createMarkdownDocument({
      folderId: "f1",
      title: "Note",
      body: "Body",
      x: 59,
      y: 101,
    });

    expect(boardYjsService.createMarkdownDocument).toHaveBeenCalledWith({
      folderId: "f1",
      container: { containerKind: "folder", containerId: "f1" },
      title: "Note",
      body: "Body",
      x: 60,
      y: 100,
      documentId: expect.stringMatching(/^[0-9a-f-]{36}$/i),
    });
    expect(result.document.id).toBe("doc-1");
    expect(emitCatalogUpdated).toHaveBeenCalledWith(
      [],
      {},
      {
        "markdown:doc-1": expect.objectContaining({
          id: "markdown:doc-1",
          itemType: "markdown",
          itemId: "doc-1",
        }),
      },
    );
  });

  it("updateBoardItemPosition는 board item의 container를 찾아 orch port를 갱신", async () => {
    const db = {
      getBoardItemById: vi.fn().mockResolvedValue({
        id: "markdown:doc-1",
        folderId: "f1",
        itemType: "markdown",
        itemId: "doc-1",
        x: 0,
        y: 0,
      }),
      getAllFolders: vi.fn().mockResolvedValue([]),
    } as unknown as SessionDB;
    const boardYjsService = {
      updateBoardItemPosition: vi.fn().mockResolvedValue(undefined),
    };
    const { broadcaster } = createBroadcasterMock();
    const svc = new CatalogService(db, broadcaster, boardYjsService as never);

    await svc.updateBoardItemPosition("markdown:doc-1", 59, 101);

    expect(boardYjsService.updateBoardItemPosition).toHaveBeenCalledWith(
      { containerKind: "folder", containerId: "f1" },
      "markdown:doc-1",
      60,
      100,
    );
  });

  it("updateMarkdownDocument는 orch Board Yjs mutation port만 사용한다", async () => {
    const db = {
      getMarkdownDocumentBoardItem: vi.fn().mockResolvedValue({
        id: "markdown:doc-1",
        folderId: "f1",
        itemType: "markdown",
        itemId: "doc-1",
        x: 0,
        y: 0,
      }),
      getAllFolders: vi.fn().mockResolvedValue([]),
    } as unknown as SessionDB;
    const boardYjsService = {
      updateMarkdownDocument: vi.fn().mockResolvedValue({ id: "doc-1", title: "New", body: "Body", version: 2 }),
    };
    const { broadcaster } = createBroadcasterMock();
    const svc = new CatalogService(db, broadcaster, boardYjsService as never);

    const result = await svc.updateMarkdownDocument("doc-1", {
      title: "New",
      body: "Body",
      expectedVersion: 1,
    });

    expect(boardYjsService.updateMarkdownDocument).toHaveBeenCalledWith(
      { containerKind: "folder", containerId: "f1" },
      "doc-1",
      { title: "New", body: "Body", expectedVersion: 1 },
    );
    expect(result).toEqual({ id: "doc-1", title: "New", body: "Body", version: 2 });
  });

  it("deleteMarkdownDocument는 orch Board Yjs mutation port만 사용한다", async () => {
    const db = {
      getMarkdownDocumentBoardItem: vi.fn().mockResolvedValue({
        id: "markdown:doc-1",
        folderId: "f1",
        itemType: "markdown",
        itemId: "doc-1",
        x: 0,
        y: 0,
      }),
      getAllFolders: vi.fn().mockResolvedValue([]),
    } as unknown as SessionDB;
    const boardYjsService = {
      deleteMarkdownDocument: vi.fn().mockResolvedValue(undefined),
    };
    const { broadcaster, emitCatalogUpdated } = createBroadcasterMock();
    const svc = new CatalogService(db, broadcaster, boardYjsService as never);

    await svc.deleteMarkdownDocument("doc-1");

    expect(boardYjsService.deleteMarkdownDocument).toHaveBeenCalledWith(
      { containerKind: "folder", containerId: "f1" },
      "doc-1",
    );
    expect(emitCatalogUpdated).toHaveBeenCalledWith(
      [],
      {},
      { "markdown:doc-1": null },
    );
  });

  it("orphan markdown projection은 worker DB에서 조용히 고치지 않는다", async () => {
    const db = {
      getMarkdownDocumentBoardItem: vi.fn().mockResolvedValue(null),
      getMarkdownDocument: vi.fn().mockResolvedValue({
        id: "doc-orphan",
        title: "Orphan",
        body: "",
        version: 1,
      }),
      getAllFolders: vi.fn().mockResolvedValue([]),
    } as unknown as SessionDB;
    const { broadcaster } = createBroadcasterMock();
    const svc = new CatalogService(db, broadcaster, {
      updateMarkdownDocument: vi.fn(),
      deleteMarkdownDocument: vi.fn(),
    } as never);

    await expect(svc.updateMarkdownDocument("doc-orphan", {
      title: "New",
      expectedVersion: 1,
    })).rejects.toThrow("markdown document board item not found");
    await expect(svc.deleteMarkdownDocument("doc-orphan"))
      .rejects.toThrow("markdown document board item not found");
  });
});

describe("CatalogService.renameSession", () => {
  it("host renameSession + broadcast", async () => {
    const { sql } = setupSqlWithCatalog();
    const db = createSessionDb(sql);
    const { broadcaster, emitCatalogUpdated } = createBroadcasterMock();
    const renameSession = vi.fn().mockResolvedValue({});
    const svc = new CatalogService(
      db,
      broadcaster,
      undefined,
      undefined,
      { renameSession } as never,
    );

    await svc.renameSession("s1", "새 이름");
    await svc.renameSession("s1", "새 이름");

    expect(renameSession).toHaveBeenNthCalledWith(
      1,
      "s1",
      "새 이름",
      expect.stringMatching(/^rename_session:s1:/),
    );
    expect(renameSession.mock.calls[1]?.[2]).toBe(
      renameSession.mock.calls[0]?.[2],
    );
    expect(emitCatalogUpdated).toHaveBeenCalledWith(
      expect.any(Array),
      {
        s1: { folderId: "f1", displayName: "Session s1" },
      },
      {},
    );
  });
});

describe("CatalogService.deleteSession", () => {
  it("host deleteSession + broadcastCatalog + emitSessionDeleted", async () => {
    const { sql } = setupSqlWithCatalog();
    const db = createSessionDb(sql);
    const { broadcaster, emitCatalogUpdated, emitSessionDeleted } =
      createBroadcasterMock();
    const deleteSession = vi.fn().mockResolvedValue({});
    const svc = new CatalogService(
      db,
      broadcaster,
      undefined,
      undefined,
      { deleteSession } as never,
    );

    await svc.deleteSession("s1");

    expect(deleteSession).toHaveBeenCalledWith("s1", "delete_session:s1");
    expect(emitCatalogUpdated).toHaveBeenCalledWith(
      expect.any(Array),
      { s1: null },
      { "session:s1": null },
    );
    expect(emitSessionDeleted).toHaveBeenCalledWith("s1");
  });
});

describe("CatalogService.getFolderSystemPrompt", () => {
  it("폴더 부재 → throw", async () => {
    const { sql } = createMockSql(() => []);
    const db = createSessionDb(sql);
    const { broadcaster } = createBroadcasterMock();
    const svc = new CatalogService(db, broadcaster);
    await expect(svc.getFolderSystemPrompt("missing")).rejects.toThrow(
      /folder not found/,
    );
  });

  it("settings.folderPrompt 반환", async () => {
    const { sql } = createMockSql(() => [
      {
        id: "f1",
        name: "F1",
        sort_order: 0,
        settings: { folderPrompt: "당신은 도우미입니다" },
      },
    ]);
    const db = createSessionDb(sql);
    const { broadcaster } = createBroadcasterMock();
    const svc = new CatalogService(db, broadcaster);
    expect(await svc.getFolderSystemPrompt("f1")).toBe("당신은 도우미입니다");
  });

  it("folderPrompt 키 없으면 null", async () => {
    const { sql } = createMockSql(() => [
      { id: "f1", name: "F1", sort_order: 0, settings: { otherKey: "x" } },
    ]);
    const db = createSessionDb(sql);
    const { broadcaster } = createBroadcasterMock();
    const svc = new CatalogService(db, broadcaster);
    expect(await svc.getFolderSystemPrompt("f1")).toBeNull();
  });
});

describe("CatalogService.setFolderSystemPrompt", () => {
  it("prompt 빈 문자열 → settings에서 folderPrompt 키 제거 + broadcast", async () => {
    let callIndex = 0;
    const { sql, calls } = createMockSql((call) => {
      callIndex += 1;
      const text = call.fragments.join("|");
      if (text.includes("WHERE id = ") || text.includes("FROM folders"))
        return [
          {
            id: "f1",
            name: "F1",
            sort_order: 0,
            settings: { folderPrompt: "old", other: "x" },
          },
        ];
      if (text.includes("folder_get_all"))
        return [{ id: "f1", name: "F1", sort_order: 0, settings: {} }];
      if (text.includes("catalog_get_sessions")) return [];
      return [];
    });
    const db = createSessionDb(sql);
    const { broadcaster, emitCatalogUpdated } = createBroadcasterMock();
    const svc = new CatalogService(db, broadcaster);

    await svc.setFolderSystemPrompt("f1", "");

    const updateCall = calls.find((c) =>
      c.fragments.join("|").includes("folder_update"),
    );
    expect(updateCall).toBeDefined();
    expect(updateCall!.values[0]).toBe("f1");
    expect(updateCall!.values[1]).toEqual(["settings"]);
    // settings JSON에 folderPrompt가 빠지고 other 키만 남아야 함
    const settingsJson = (updateCall!.values[2] as string[])[0];
    const parsed = JSON.parse(settingsJson);
    expect(parsed).toEqual({ other: "x" });
    expect(emitCatalogUpdated).toHaveBeenCalledTimes(1);
    expect(callIndex).toBeGreaterThan(0);
  });

  it("prompt 문자열 → settings에 folderPrompt 키 설정", async () => {
    const { sql, calls } = createMockSql((call) => {
      const text = call.fragments.join("|");
      if (text.includes("FROM folders"))
        return [{ id: "f1", name: "F1", sort_order: 0, settings: {} }];
      if (text.includes("folder_get_all"))
        return [{ id: "f1", name: "F1", sort_order: 0, settings: {} }];
      if (text.includes("catalog_get_sessions")) return [];
      return [];
    });
    const db = createSessionDb(sql);
    const { broadcaster } = createBroadcasterMock();
    const svc = new CatalogService(db, broadcaster);

    await svc.setFolderSystemPrompt("f1", "당신은 도우미");

    const updateCall = calls.find((c) =>
      c.fragments.join("|").includes("folder_update"),
    );
    const settingsJson = (updateCall!.values[2] as string[])[0];
    expect(JSON.parse(settingsJson)).toEqual({ folderPrompt: "당신은 도우미" });
  });
});

describe("CatalogService.broadcastCatalog", () => {
  it("emits folder-only changes with both empty delta keys and no catalog-wide scans", async () => {
    const { sql, calls } = setupSqlWithCatalog();
    const db = createSessionDb(sql);
    const { broadcaster, emitCatalogUpdated } = createBroadcasterMock();
    const svc = new CatalogService(db, broadcaster);

    await svc.broadcastCatalog();

    expect(emitCatalogUpdated).toHaveBeenCalledTimes(1);
    expect(emitCatalogUpdated).toHaveBeenCalledWith(
      [expect.objectContaining({ id: "f1", projectPageId: "page-f1" })],
      {},
      {},
    );
    expect(calls.some((call) =>
      call.fragments.join("|").includes("catalog_get_sessions")
    )).toBe(false);
  });
});

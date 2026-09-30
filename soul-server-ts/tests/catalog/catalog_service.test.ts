import { beforeEach, describe, expect, it, vi } from "vitest";

import { CatalogService } from "../../src/catalog/catalog_service.js";
import { SessionDB, type SqlClient } from "../../src/db/session_db.js";
import { SessionBroadcaster } from "../../src/upstream/session_broadcaster.js";
import { AgentRegistry } from "../../src/agent_registry.js";
import { FolderControlPlaneService } from "../../../orch-server-ts/src/folders/folder_control_plane_service.js";
import { createLiveFolderProvider } from "../../../orch-server-ts/src/runtime/live_folder_route_provider.js";
import { serializeChecklistRow } from "../../../orch-server-ts/src/folders/folder_contracts.js";
import { mergeCatalogSessionsDelta } from "../../../packages/soul-ui/src/hooks/session-catalog-helpers.js";
import { useFolderChecklistStore } from "../../../packages/soul-ui/src/stores/folder-checklist-store.js";
import type { CatalogFolder, CatalogState } from "../../../packages/soul-ui/src/shared/catalog-types.js";
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
  const db = new SessionDB();
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
        checklist_enabled: true,
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
        checklist_enabled: false,
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
        checklistEnabled: true,
        settings: { x: 1 },
        parentFolderId: null,
        projectPageId: "page-f1",
        createdAt: "2026-06-03T00:00:00.000Z",
      },
      { id: "f2", name: "F2", checklistEnabled: false, sortOrder: 2, settings: {}, parentFolderId: "f1", projectPageId: null },
    ]);
  });
});

describe("catalog checklist visibility", () => {
  it("keeps catalog and checklist snapshot enabled across alternating orch and worker refreshes", async () => {
    const row = {
      id: "f1", name: "업무", sort_order: 0, settings: {},
      parent_folder_id: null, project_page_id: "page-f1",
      checklist_enabled: true, status: "open", archived: false, version: 1,
      created_at: "2026-09-30T00:00:00Z", updated_at: "2026-09-30T00:00:00Z",
    };
    const { sql } = createMockSql((call) =>
      call.fragments.join("|").includes("folder_get_all") ? [{ ...row }] : [],
    );
    const provider = createLiveFolderProvider({ resolveSql: async () => sql } as never);
    let catalog: CatalogState = { folders: [], sessions: {} };
    const trace: Array<{ source: string; catalog: boolean | null; snapshot: boolean | null }> = [];
    const record = (source: string) => trace.push({
      source,
      catalog: catalog.folders[0]?.checklistEnabled ?? null,
      snapshot: useFolderChecklistStore.getState().byId.f1?.snapshot?.folder.checklistEnabled ?? null,
    });
    const broadcaster = new SessionBroadcaster(async (message) => {
      // The client replaces folders with each catalog_updated payload.
      catalog = mergeCatalogSessionsDelta(catalog, message.folders as CatalogFolder[], {}, {});
      record("worker");
    }, new AgentRegistry([]), "eiaserinnys");
    const svc = new CatalogService(createSessionDb(sql), broadcaster);
    const originalFetch = globalThis.fetch;
    globalThis.fetch = vi.fn(async () => new Response(JSON.stringify({
      folder: serializeChecklistRow(row), sections: [], items: [],
    })));
    useFolderChecklistStore.getState().reset();
    try {
      await useFolderChecklistStore.getState().loadFolder("f1");
      for (let refresh = 0; refresh < 3; refresh++) {
        catalog = mergeCatalogSessionsDelta(catalog, await provider.listFolders() as CatalogFolder[], {}, {});
        record("orch");
        await svc.broadcastCatalog();
        await useFolderChecklistStore.getState().loadFolder("f1", { force: true });
        record("snapshot");
      }
      console.info("checklist refresh trace", JSON.stringify(trace));
      expect(trace.map(({ catalog, snapshot }) => [catalog, snapshot]))
        .toEqual(Array.from({ length: 9 }, () => [true, true]));

      // An intentional server toggle must still hide the section immediately.
      row.checklist_enabled = false;
      await svc.broadcastCatalog();
      await useFolderChecklistStore.getState().loadFolder("f1", { force: true });
      expect(catalog.folders[0]?.checklistEnabled).toBe(false);
      expect(useFolderChecklistStore.getState().byId.f1?.snapshot?.folder.checklistEnabled).toBe(false);
    } finally {
      globalThis.fetch = originalFetch;
      useFolderChecklistStore.getState().reset();
    }
  });
});

describe("CatalogService.createFolder", () => {
  it("sends catalog folder creation through the folder host", async () => {
    const { sql } = setupSqlWithCatalog();
    const db = createSessionDb(sql);
    const { broadcaster } = createBroadcasterMock();
    const folder = { id: "f1", name: "Folder", sortOrder: 4, settings: {}, parentFolderId: null, projectPageId: "p1" };
    const host = { createFolder: vi.fn().mockResolvedValue({ folder, operation: {}, idempotent: false }) };
    const svc = new CatalogService(db, broadcaster, undefined, host as never);

    await expect(svc.createFolder("Folder", 4, null)).resolves.toEqual(folder);
    expect(host.createFolder).toHaveBeenCalledWith(expect.objectContaining({
      actorKind: "system", actorSessionId: null, name: "Folder", sortOrder: 4, parentFolderId: null,
      idempotencyKey: expect.any(String),
    }));
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
      { id: "child-a", name: "Child A", checklistEnabled: false, sortOrder: 1, settings: {}, parentFolderId: "root", projectPageId: null },
      { id: "child-b", name: "Child B", checklistEnabled: false, sortOrder: 2, settings: {}, parentFolderId: "root", projectPageId: null },
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
    const listFolderItems = vi.spyOn(db, "listFolderItems").mockImplementation(
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

    expect(listFolderItems).toHaveBeenCalledWith(expect.objectContaining({
      folderId: "root",
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

describe("CatalogService folder mutations", () => {
  it("routes rename, root move, archive, and prompt setting through the folder host", async () => {
    const { sql } = setupSqlWithCatalog();
    const db = createSessionDb(sql);
    vi.spyOn(db, "getFolderById").mockResolvedValue({ id: "f1", name: "F1", version: 3, settings: { other: "x" } } as never);
    const { broadcaster } = createBroadcasterMock();
    const host = { renameFolder: vi.fn().mockResolvedValue({}), setFolderArchived: vi.fn().mockResolvedValue({}) };
    const svc = new CatalogService(db, broadcaster, undefined, host as never);

    await svc.renameFolder("f1", "Renamed");
    await svc.setFolderParent("f1", null);
    await svc.setFolderSystemPrompt("f1", "Guidance");
    await svc.deleteFolder("f1");

    expect(host.renameFolder).toHaveBeenNthCalledWith(1, expect.objectContaining({ folderId: "f1", expectedVersion: 3, name: "Renamed" }));
    expect(host.renameFolder).toHaveBeenNthCalledWith(2, expect.objectContaining({ folderId: "f1", expectedVersion: 3, parentFolderId: null }));
    expect(host.renameFolder).toHaveBeenNthCalledWith(3, expect.objectContaining({ folderId: "f1", expectedVersion: 3, settings: { other: "x", folderPrompt: "Guidance" } }));
    expect(host.setFolderArchived).toHaveBeenCalledWith(expect.objectContaining({ folderId: "f1", expectedVersion: 3, archived: true }));
  });
});

describe("CatalogService.moveSessionsToFolder", () => {
  it("세션마다 atomic Board Yjs 이동 호출 후 1회 broadcast", async () => {
    const { sql, calls } = setupSqlWithCatalog();
    const db = createSessionDb(sql);
    const { broadcaster, emitCatalogUpdated } = createBroadcasterMock();
    const moveSessionToFolder = vi.fn().mockResolvedValue(null);
    const svc = new CatalogService(db, broadcaster, { moveSessionToFolder } as never);

    await svc.moveSessionsToFolder(["s1", "s2", "s3"], "f1");

    expect(moveSessionToFolder.mock.calls).toEqual([
      ["s1", "f1"],
      ["s2", "f1"],
      ["s3", "f1"],
    ]);
    expect(calls.some((c) => c.fragments.join("|").includes("session_assign_folder")))
      .toBe(false);
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

  it("folderId=null → atomic 이동 포트에 폴더 해제를 전달", async () => {
    const { sql, calls } = setupSqlWithCatalog();
    const db = createSessionDb(sql);
    const { broadcaster } = createBroadcasterMock();
    const moveSessionToFolder = vi.fn().mockResolvedValue(null);
    const svc = new CatalogService(db, broadcaster, { moveSessionToFolder } as never);

    await svc.moveSessionsToFolder(["s1"], null);

    expect(moveSessionToFolder).toHaveBeenCalledWith("s1", null);
    expect(calls.some((c) => c.fragments.join("|").includes("session_assign_folder")))
      .toBe(false);
  });
});

describe("CatalogService board items", () => {
  it("moves a primary board item to a folder through Board Yjs", async () => {
    const boardItem = { id: "markdown:doc-1", folderId: "source", membershipKind: "primary", itemType: "markdown", itemId: "doc-1", x: 0, y: 0, metadata: {} };
    const moved = { ...boardItem, folderId: "target" };
    const db = {
      getFolderById: vi.fn().mockResolvedValue({ id: "target" }),
      getBoardItemById: vi.fn().mockResolvedValue(boardItem),
      getAllFolders: vi.fn().mockResolvedValue([]),
    } as unknown as SessionDB;
    const boardYjsService = { moveBoardItemToFolder: vi.fn().mockResolvedValue(moved) };
    const { broadcaster, emitCatalogUpdated } = createBroadcasterMock();
    const svc = new CatalogService(db, broadcaster, boardYjsService as never);

    await expect(svc.moveBoardItemToFolder({ boardItemId: boardItem.id, folderId: "target", idempotencyKey: "move-1" }))
      .resolves.toEqual({ boardItem: moved, enrolled: false });
    expect(boardYjsService.moveBoardItemToFolder).toHaveBeenCalledWith({ boardItem, targetFolderId: "target", idempotencyKey: "move-1" });
    expect(emitCatalogUpdated).toHaveBeenCalled();
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
      "f1",
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
      "f1",
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
      "f1",
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

describe("CatalogService.broadcastSessionDeletion", () => {
  it("broadcasts only the catalog projection after lifecycle-owned deletion", async () => {
    const { sql } = setupSqlWithCatalog();
    const db = createSessionDb(sql);
    const { broadcaster, emitCatalogUpdated, emitSessionDeleted } =
      createBroadcasterMock();
    const svc = new CatalogService(
      db,
      broadcaster,
    );

    await svc.broadcastSessionDeletion("s1", ["session:s1"]);

    expect(emitCatalogUpdated).toHaveBeenCalledWith(
      expect.any(Array),
      { s1: null },
      { "session:s1": null },
    );
    expect(emitSessionDeleted).not.toHaveBeenCalled();
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

import { beforeEach, describe, expect, it, vi } from "vitest";

import { CatalogService } from "../../src/catalog/catalog_service.js";
import { MarkdownDocumentVersionConflictError } from "../../src/db/markdown_document_version.js";
import { SessionDB, type SqlClient } from "../../src/db/session_db.js";
import type { SessionBroadcaster } from "../../src/upstream/session_broadcaster.js";

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

/** SessionDB.getCatalog 결과를 broadcast로 흘릴 수 있도록 stub. */
function setupSqlWithCatalog() {
  return createMockSql((call) => {
    const text = call.fragments.join("|");
    if (text.includes("folder_get_all"))
      return [{ id: "f1", name: "F1", sort_order: 0, settings: {}, parent_folder_id: null }];
    if (text.includes("catalog_get_sessions"))
      return [{ session_id: "s1", folder_id: "f1", display_name: "Hi" }];
    return [];
  });
}

describe("CatalogService.listFolders", () => {
  it("getAllFolders 결과를 sortOrder/settings 키로 정규화", async () => {
    const createdAt = new Date("2026-06-03T00:00:00.000Z");
    const { sql } = createMockSql(() => [
      { id: "f1", name: "F1", sort_order: 1, settings: { x: 1 }, parent_folder_id: null, created_at: createdAt },
      { id: "f2", name: "F2", sort_order: 2, settings: null, parent_folder_id: "f1" },
    ]);
    const db = new SessionDB(sql);
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
        createdAt: "2026-06-03T00:00:00.000Z",
      },
      { id: "f2", name: "F2", sortOrder: 2, settings: {}, parentFolderId: "f1" },
    ]);
  });
});

describe("CatalogService.createFolder", () => {
  it("folder_create 호출 + broadcastCatalog", async () => {
    const { sql, calls } = setupSqlWithCatalog();
    const db = new SessionDB(sql);
    const { broadcaster, emitCatalogUpdated } = createBroadcasterMock();
    const svc = new CatalogService(db, broadcaster);

    const folder = await svc.createFolder("새 폴더", 5, "parent");
    expect(folder.name).toBe("새 폴더");
    expect(folder.sortOrder).toBe(5);
    expect(folder.parentFolderId).toBe("parent");
    expect(folder.id).toMatch(/^[0-9a-f-]{36}$/i);
    expect(folder.settings).toEqual({});

    const folderCreateCall = calls.find((c) =>
      c.fragments.join("|").includes("folder_create"),
    );
    expect(folderCreateCall).toBeDefined();
    expect(folderCreateCall!.values).toEqual([folder.id, "새 폴더", 5, "parent"]);

    expect(emitCatalogUpdated).toHaveBeenCalledTimes(1);
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
    const db = new SessionDB(sql);
    const { broadcaster } = createBroadcasterMock();
    const svc = new CatalogService(db, broadcaster);

    await expect(svc.listChildFolders("root")).resolves.toEqual([
      { id: "child-a", name: "Child A", sortOrder: 1, settings: {}, parentFolderId: "root" },
      { id: "child-b", name: "Child B", sortOrder: 2, settings: {}, parentFolderId: "root" },
    ]);
  });
});

describe("CatalogService.browseFolder", () => {
  it("직접 자식 폴더, 세션 페이지, 문서/파일 보드 항목을 한 번에 반환", async () => {
    const { sql, calls } = createMockSql((call) => {
      const text = call.fragments.join("|");
      if (text.includes("folder_get_all")) {
        return [
          { id: "root", name: "Root", sort_order: 0, settings: {}, parent_folder_id: null },
          { id: "child", name: "Child", sort_order: 1, settings: {}, parent_folder_id: "root" },
          { id: "grand", name: "Grand", sort_order: 2, settings: {}, parent_folder_id: "child" },
        ];
      }
      if (text.includes("catalog_get_sessions")) {
        return [
          { session_id: "sess-a", folder_id: "root", display_name: "Session A" },
          { session_id: "sess-b", folder_id: "root", display_name: "Session B" },
        ];
      }
      if (text.includes("board_yjs_catalog_cache")) return [];
      if (text.includes("FROM board_items")) {
        return [
          {
            id: "markdown:doc-1",
            folder_id: "root",
            item_type: "markdown",
            item_id: "doc-1",
            x: 0,
            y: 0,
            metadata: { title: "Spec", preview: "Short spec", version: 1 },
            created_at: null,
            updated_at: null,
          },
          {
            id: "asset:asset-1",
            folder_id: "root",
            item_type: "asset",
            item_id: "asset-1",
            x: 280,
            y: 0,
            metadata: {
              assetId: "asset-1",
              originalName: "image.png",
              mimeType: "image/png",
              byteSize: 1234,
            },
            created_at: null,
            updated_at: null,
          },
          {
            id: "markdown:doc-child",
            folder_id: "child",
            item_type: "markdown",
            item_id: "doc-child",
            x: 0,
            y: 0,
            metadata: { title: "Child doc" },
            created_at: null,
            updated_at: null,
          },
        ];
      }
      if (text.includes("session_list_summary")) {
        return [
          {
            session_id: "sess-a",
            display_name: "Session A",
            status: "running",
            session_type: "claude",
            created_at: new Date("2026-06-17T00:00:00.000Z"),
            updated_at: new Date("2026-06-17T01:00:00.000Z"),
            event_count: "5",
            away_summary: null,
            caller_session_id: null,
            last_event_id: "50",
            last_read_event_id: "40",
            node_id: "node-a",
            total_count: "2",
          },
        ];
      }
      return [];
    });
    const db = new SessionDB(sql);
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

    const sessionListCall = calls.find((call) =>
      call.fragments.join("|").includes("session_list_summary"),
    );
    expect(sessionListCall?.values).toEqual([null, null, 1, 0, "root", null]);
  });

  it("없는 폴더는 명시적으로 거부", async () => {
    const { sql } = createMockSql((call) => {
      if (call.fragments.join("|").includes("folder_get_all")) return [];
      return [];
    });
    const db = new SessionDB(sql);
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
    const db = new SessionDB(sql);
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
    const db = new SessionDB(sql);
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
    const db = new SessionDB(sql);
    const { broadcaster } = createBroadcasterMock();
    const svc = new CatalogService(db, broadcaster);

    await expect(svc.setFolderParent("root", "grand")).rejects.toThrow(/cycle/);
    expect(calls.some((c) => c.fragments.join("|").includes("folder_update"))).toBe(false);
  });

  it("시스템 폴더 move는 DB update 전에 거부", async () => {
    const { sql, calls } = setupSqlWithCatalog();
    const db = new SessionDB(sql);
    const { broadcaster } = createBroadcasterMock();
    const svc = new CatalogService(db, broadcaster);

    await expect(svc.setFolderParent("claude", null)).rejects.toThrow(/system folder/i);
    expect(calls.some((c) => c.fragments.join("|").includes("folder_update"))).toBe(false);
  });
});

describe("CatalogService.renameFolder", () => {
  it("folder_update(columns=['name'], values=[name]) + broadcast", async () => {
    const { sql, calls } = setupSqlWithCatalog();
    const db = new SessionDB(sql);
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
    const db = new SessionDB(sql);
    const { broadcaster } = createBroadcasterMock();
    const svc = new CatalogService(db, broadcaster);

    await expect(svc.renameFolder("claude", "새 이름")).rejects.toThrow(/system folder/i);
    expect(calls.some((c) => c.fragments.join("|").includes("folder_update"))).toBe(false);
  });
});

describe("CatalogService.deleteFolder", () => {
  it("folder_delete + broadcast", async () => {
    const { sql, calls } = setupSqlWithCatalog();
    const db = new SessionDB(sql);
    const { broadcaster, emitCatalogUpdated } = createBroadcasterMock();
    const svc = new CatalogService(db, broadcaster);

    await svc.deleteFolder("f1");

    const deleteCall = calls.find((c) =>
      c.fragments.join("|").includes("folder_delete"),
    );
    expect(deleteCall).toBeDefined();
    expect(deleteCall!.values).toEqual(["f1"]);
    expect(emitCatalogUpdated).toHaveBeenCalledTimes(1);
  });

  it("시스템 폴더 delete는 DB delete 전에 거부", async () => {
    const { sql, calls } = setupSqlWithCatalog();
    const db = new SessionDB(sql);
    const { broadcaster } = createBroadcasterMock();
    const svc = new CatalogService(db, broadcaster);

    await expect(svc.deleteFolder("llm")).rejects.toThrow(/system folder/i);
    expect(calls.some((c) => c.fragments.join("|").includes("folder_delete"))).toBe(false);
  });
});

describe("CatalogService.moveSessionsToFolder", () => {
  it("세션마다 session_assign_folder 호출 후 1회 broadcast", async () => {
    const { sql, calls } = setupSqlWithCatalog();
    const db = new SessionDB(sql);
    const { broadcaster, emitCatalogUpdated } = createBroadcasterMock();
    const svc = new CatalogService(db, broadcaster);

    await svc.moveSessionsToFolder(["s1", "s2", "s3"], "f1");

    const assigns = calls.filter((c) =>
      c.fragments.join("|").includes("session_assign_folder"),
    );
    expect(assigns).toHaveLength(3);
    expect(assigns.map((c) => c.values[0])).toEqual(["s1", "s2", "s3"]);
    expect(emitCatalogUpdated).toHaveBeenCalledTimes(1);
  });

  it("folderId=null → 폴더 해제 (각 호출에 null 전달)", async () => {
    const { sql, calls } = setupSqlWithCatalog();
    const db = new SessionDB(sql);
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
  it("createMarkdownDocument는 BoardYjsService 경로를 우선 사용하고 legacy DB create를 호출하지 않는다", async () => {
    const db = {
      createMarkdownDocument: vi.fn().mockResolvedValue({
        document: { id: "legacy-doc", title: "Legacy", body: "", version: 1 },
        boardItem: { id: "markdown:legacy-doc", folderId: "f1", itemType: "markdown", itemId: "legacy-doc", x: 60, y: 100 },
      }),
      getCatalog: vi.fn().mockResolvedValue({ folders: [], sessions: {}, boardItems: [] }),
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
    expect(db.createMarkdownDocument).not.toHaveBeenCalled();
    expect(result.document.id).toBe("doc-1");
    expect(emitCatalogUpdated).toHaveBeenCalledTimes(1);
  });

  it("updateBoardItemPosition은 20px 격자에 스냅한 뒤 broadcast", async () => {
    const db = {
      ensureBoardItems: vi.fn().mockResolvedValue(undefined),
      updateBoardItemPosition: vi.fn().mockResolvedValue(undefined),
      getCatalog: vi.fn().mockResolvedValue({ folders: [], sessions: {}, boardItems: [] }),
    } as unknown as SessionDB;
    const { broadcaster, emitCatalogUpdated } = createBroadcasterMock();
    const svc = new CatalogService(db, broadcaster);

    await svc.updateBoardItemPosition("session:s1", 59, 101);

    expect(db.ensureBoardItems).toHaveBeenCalledTimes(1);
    expect(db.updateBoardItemPosition).toHaveBeenCalledWith("session:s1", 60, 100);
    expect(emitCatalogUpdated).toHaveBeenCalledTimes(1);
  });

  it("updateBoardItemPosition는 board item의 folder를 찾아 BoardYjsService를 우선 갱신", async () => {
    const db = {
      getBoardItemById: vi.fn().mockResolvedValue({
        id: "markdown:doc-1",
        folderId: "f1",
        itemType: "markdown",
        itemId: "doc-1",
        x: 0,
        y: 0,
      }),
      ensureBoardItems: vi.fn().mockResolvedValue(undefined),
      updateBoardItemPosition: vi.fn().mockResolvedValue(undefined),
      getCatalog: vi.fn().mockResolvedValue({ folders: [], sessions: {}, boardItems: [] }),
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
    expect(db.updateBoardItemPosition).not.toHaveBeenCalled();
  });

  it("createMarkdownDocument는 명시 좌표를 스냅해 board item 생성", async () => {
    const db = {
      createMarkdownDocument: vi.fn().mockResolvedValue({
        document: { id: "doc-1", title: "Note", body: "Body", version: 1 },
        boardItem: { id: "markdown:doc-1", folderId: "f1", itemType: "markdown", itemId: "doc-1", x: 60, y: 100 },
      }),
      getCatalog: vi.fn().mockResolvedValue({ folders: [], sessions: {}, boardItems: [] }),
    } as unknown as SessionDB;
    const { broadcaster, emitCatalogUpdated } = createBroadcasterMock();
    const svc = new CatalogService(db, broadcaster);

    await svc.createMarkdownDocument({
      folderId: "f1",
      title: "Note",
      body: "Body",
      x: 59,
      y: 101,
    });

    const payload = vi.mocked(db.createMarkdownDocument).mock.calls[0][0];
    expect(payload.documentId).toMatch(/^[0-9a-f-]{36}$/i);
    expect(payload).toMatchObject({
      folderId: "f1",
      title: "Note",
      body: "Body",
      x: 60,
      y: 100,
    });
    expect(emitCatalogUpdated).toHaveBeenCalledTimes(1);
  });

  it("createMarkdownDocument는 좌표가 없으면 첫 빈 280px 슬롯에 배치", async () => {
    const db = {
      ensureBoardItems: vi.fn().mockResolvedValue(undefined),
      getBoardItems: vi.fn().mockResolvedValue([
        { folderId: "f1", x: 0, y: 0 },
        { folderId: "f1", x: 280, y: 0 },
      ]),
      createMarkdownDocument: vi.fn().mockResolvedValue({
        document: { id: "doc-1", title: "Note", body: "", version: 1 },
        boardItem: { id: "markdown:doc-1", folderId: "f1", itemType: "markdown", itemId: "doc-1", x: 560, y: 0 },
      }),
      getCatalog: vi.fn().mockResolvedValue({ folders: [], sessions: {}, boardItems: [] }),
    } as unknown as SessionDB;
    const { broadcaster } = createBroadcasterMock();
    const svc = new CatalogService(db, broadcaster);

    await svc.createMarkdownDocument({ folderId: "f1", title: "Note" });

    expect(db.ensureBoardItems).toHaveBeenCalledTimes(1);
    expect(db.createMarkdownDocument).toHaveBeenCalledWith(expect.objectContaining({
      folderId: "f1",
      x: 560,
      y: 0,
    }));
  });

  it("updateMarkdownDocument는 BoardYjsService 경로를 우선 사용해 stale Yjs overwrite를 막는다", async () => {
    const db = {
      getMarkdownDocumentBoardItem: vi.fn().mockResolvedValue({
        id: "markdown:doc-1",
        folderId: "f1",
        itemType: "markdown",
        itemId: "doc-1",
        x: 0,
        y: 0,
      }),
      updateMarkdownDocument: vi.fn().mockResolvedValue({ id: "doc-1", title: "Legacy", body: "", version: 2 }),
      getCatalog: vi.fn().mockResolvedValue({ folders: [], sessions: {}, boardItems: [] }),
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
    expect(db.updateMarkdownDocument).not.toHaveBeenCalled();
    expect(result).toEqual({ id: "doc-1", title: "New", body: "Body", version: 2 });
  });

  it("updateMarkdownDocument DB fallback도 expectedVersion을 전달한다", async () => {
    const db = {
      getMarkdownDocumentBoardItem: vi.fn().mockResolvedValue(null),
      updateMarkdownDocument: vi.fn().mockResolvedValue({ id: "doc-1", title: "New", body: "Body", version: 2 }),
      getCatalog: vi.fn().mockResolvedValue({ folders: [], sessions: {}, boardItems: [] }),
    } as unknown as SessionDB;
    const { broadcaster } = createBroadcasterMock();
    const svc = new CatalogService(db, broadcaster);

    await svc.updateMarkdownDocument("doc-1", {
      title: "New",
      expectedVersion: 1,
    });

    expect(db.updateMarkdownDocument).toHaveBeenCalledWith(
      "doc-1",
      { title: "New", expectedVersion: 1 },
    );
  });

  it("updateMarkdownDocument stale token은 broadcast 없이 전파한다", async () => {
    const db = {
      getMarkdownDocumentBoardItem: vi.fn().mockResolvedValue(null),
      updateMarkdownDocument: vi.fn().mockRejectedValue(
        new MarkdownDocumentVersionConflictError("doc-1", 1, 2),
      ),
      getCatalog: vi.fn().mockResolvedValue({ folders: [], sessions: {}, boardItems: [] }),
    } as unknown as SessionDB;
    const { broadcaster, emitCatalogUpdated } = createBroadcasterMock();
    const svc = new CatalogService(db, broadcaster);

    await expect(
      svc.updateMarkdownDocument("doc-1", {
        body: "stale",
        expectedVersion: 1,
      }),
    ).rejects.toThrow(/version conflict/);

    expect(emitCatalogUpdated).not.toHaveBeenCalled();
  });

  it("deleteMarkdownDocument는 BoardYjsService 경로를 우선 사용해 Yjs replica에서 함께 제거", async () => {
    const db = {
      getMarkdownDocumentBoardItem: vi.fn().mockResolvedValue({
        id: "markdown:doc-1",
        folderId: "f1",
        itemType: "markdown",
        itemId: "doc-1",
        x: 0,
        y: 0,
      }),
      deleteMarkdownDocument: vi.fn().mockResolvedValue(undefined),
      getCatalog: vi.fn().mockResolvedValue({ folders: [], sessions: {}, boardItems: [] }),
    } as unknown as SessionDB;
    const boardYjsService = {
      deleteMarkdownDocument: vi.fn().mockResolvedValue(undefined),
    };
    const { broadcaster } = createBroadcasterMock();
    const svc = new CatalogService(db, broadcaster, boardYjsService as never);

    await svc.deleteMarkdownDocument("doc-1");

    expect(boardYjsService.deleteMarkdownDocument).toHaveBeenCalledWith(
      { containerKind: "folder", containerId: "f1" },
      "doc-1",
    );
    expect(db.deleteMarkdownDocument).not.toHaveBeenCalled();
  });
});

describe("CatalogService.renameSession", () => {
  it("db.renameSession + broadcast", async () => {
    const { sql, calls } = setupSqlWithCatalog();
    const db = new SessionDB(sql);
    const { broadcaster, emitCatalogUpdated } = createBroadcasterMock();
    const svc = new CatalogService(db, broadcaster);

    await svc.renameSession("s1", "새 이름");

    const renameCall = calls.find((c) =>
      c.fragments.join("|").includes("session_rename"),
    );
    expect(renameCall).toBeDefined();
    expect(renameCall!.values).toEqual(["s1", "새 이름"]);
    expect(emitCatalogUpdated).toHaveBeenCalledTimes(1);
  });
});

describe("CatalogService.deleteSession", () => {
  it("db.deleteSession + broadcastCatalog + emitSessionDeleted", async () => {
    const { sql, calls } = setupSqlWithCatalog();
    const db = new SessionDB(sql);
    const { broadcaster, emitCatalogUpdated, emitSessionDeleted } =
      createBroadcasterMock();
    const svc = new CatalogService(db, broadcaster);

    await svc.deleteSession("s1");

    const deleteCall = calls.find((c) =>
      c.fragments.join("|").includes("session_delete"),
    );
    expect(deleteCall).toBeDefined();
    expect(deleteCall!.values).toEqual(["s1"]);
    expect(emitCatalogUpdated).toHaveBeenCalledTimes(1);
    expect(emitSessionDeleted).toHaveBeenCalledWith("s1");
  });
});

describe("CatalogService.getFolderSystemPrompt", () => {
  it("폴더 부재 → throw", async () => {
    const { sql } = createMockSql(() => []);
    const db = new SessionDB(sql);
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
    const db = new SessionDB(sql);
    const { broadcaster } = createBroadcasterMock();
    const svc = new CatalogService(db, broadcaster);
    expect(await svc.getFolderSystemPrompt("f1")).toBe("당신은 도우미입니다");
  });

  it("folderPrompt 키 없으면 null", async () => {
    const { sql } = createMockSql(() => [
      { id: "f1", name: "F1", sort_order: 0, settings: { otherKey: "x" } },
    ]);
    const db = new SessionDB(sql);
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
    const db = new SessionDB(sql);
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
    const db = new SessionDB(sql);
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
  it("getCatalog 결과를 emitCatalogUpdated에 그대로 전달", async () => {
    const { sql } = setupSqlWithCatalog();
    const db = new SessionDB(sql);
    const { broadcaster, emitCatalogUpdated } = createBroadcasterMock();
    const svc = new CatalogService(db, broadcaster);

    await svc.broadcastCatalog();

    expect(emitCatalogUpdated).toHaveBeenCalledTimes(1);
    const arg = emitCatalogUpdated.mock.calls[0][0];
    expect(arg).toHaveProperty("folders");
    expect(arg).toHaveProperty("sessions");
  });
});

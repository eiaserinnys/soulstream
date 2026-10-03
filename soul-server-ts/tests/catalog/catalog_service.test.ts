import { describe, expect, it, vi } from "vitest";

import { FolderControlPlaneService } from "../../../orch-server-ts/src/folders/folder_control_plane_service.js";
import { CatalogService } from "../../src/catalog/catalog_service.js";
import { SessionDB, type SqlClient } from "../../src/db/session_db.js";
import type { FolderHostClient } from "../../src/folder/folder_host_client.js";
import type { SessionBroadcaster } from "../../src/upstream/session_broadcaster.js";
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

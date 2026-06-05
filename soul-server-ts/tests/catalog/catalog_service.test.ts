import { beforeEach, describe, expect, it, vi } from "vitest";

import { CatalogService } from "../../src/catalog/catalog_service.js";
import { SessionDB, type SqlClient } from "../../src/db/session_db.js";
import type { SessionBroadcaster } from "../../src/upstream/session_broadcaster.js";

interface MockCall {
  fragments: string[];
  values: unknown[];
}

function createMockSql(resultFor?: (call: MockCall) => unknown[]) {
  const calls: MockCall[] = [];
  const fn = ((strings: TemplateStringsArray, ...values: unknown[]) => {
    const call: MockCall = { fragments: Array.from(strings), values };
    calls.push(call);
    const result = resultFor ? resultFor(call) : [];
    return Promise.resolve(result);
  }) as unknown as SqlClient & {
    array: (a: unknown[]) => unknown[];
    end: () => Promise<void>;
  };
  fn.array = (a: unknown[]) => a;
  fn.end = vi.fn().mockResolvedValue(undefined);
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

describe("CatalogService.setFolderParent", () => {
  it("자기 자신을 parent로 지정하면 DB update 전에 거부", async () => {
    const { sql, calls } = setupSqlWithCatalog();
    const db = new SessionDB(sql);
    const { broadcaster } = createBroadcasterMock();
    const svc = new CatalogService(db, broadcaster);

    await expect(svc.setFolderParent("f1", "f1")).rejects.toThrow(/cycle/);
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
  it("updateBoardItemPosition은 40px 격자에 스냅한 뒤 broadcast", async () => {
    const db = {
      updateBoardItemPosition: vi.fn().mockResolvedValue(undefined),
      getCatalog: vi.fn().mockResolvedValue({ folders: [], sessions: {}, boardItems: [] }),
    } as unknown as SessionDB;
    const { broadcaster, emitCatalogUpdated } = createBroadcasterMock();
    const svc = new CatalogService(db, broadcaster);

    await svc.updateBoardItemPosition("session:s1", 59, 101);

    expect(db.updateBoardItemPosition).toHaveBeenCalledWith("session:s1", 40, 120);
    expect(emitCatalogUpdated).toHaveBeenCalledTimes(1);
  });

  it("createMarkdownDocument는 명시 좌표를 스냅해 board item 생성", async () => {
    const db = {
      createMarkdownDocument: vi.fn().mockResolvedValue({
        document: { id: "doc-1", title: "Note", body: "Body" },
        boardItem: { id: "markdown:doc-1", folderId: "f1", itemType: "markdown", itemId: "doc-1", x: 40, y: 120 },
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
      x: 40,
      y: 120,
    });
    expect(emitCatalogUpdated).toHaveBeenCalledTimes(1);
  });

  it("createMarkdownDocument는 좌표가 없으면 첫 빈 160px 슬롯에 배치", async () => {
    const db = {
      ensureBoardItems: vi.fn().mockResolvedValue(undefined),
      getBoardItems: vi.fn().mockResolvedValue([
        { folderId: "f1", x: 0, y: 0 },
        { folderId: "f1", x: 160, y: 0 },
      ]),
      createMarkdownDocument: vi.fn().mockResolvedValue({
        document: { id: "doc-1", title: "Note", body: "" },
        boardItem: { id: "markdown:doc-1", folderId: "f1", itemType: "markdown", itemId: "doc-1", x: 320, y: 0 },
      }),
      getCatalog: vi.fn().mockResolvedValue({ folders: [], sessions: {}, boardItems: [] }),
    } as unknown as SessionDB;
    const { broadcaster } = createBroadcasterMock();
    const svc = new CatalogService(db, broadcaster);

    await svc.createMarkdownDocument({ folderId: "f1", title: "Note" });

    expect(db.ensureBoardItems).toHaveBeenCalledTimes(1);
    expect(db.createMarkdownDocument).toHaveBeenCalledWith(expect.objectContaining({
      folderId: "f1",
      x: 320,
      y: 0,
    }));
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

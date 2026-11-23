/**
 * SessionDB 단위 테스트 — mock sql tagged-template 함수로 호출 인자 검증.
 *
 * 통합 동작(stored proc 실행)은 별도 e2e 또는 testcontainers — 본 PR 범위 외.
 * 본 테스트는 *SessionDB의 책임* (인자 직렬화, 화이트리스트 가드, 반환 파싱)만 검증.
 */

import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";

import { SessionDB, type SqlClient } from "../../src/db/session_db.js";
import { FolderControlPlaneService } from "../../../orch-server-ts/src/folders/folder_control_plane_service.js";
import { configureTestBoardProjectionReadHost } from "../helpers/configure_test_board_projection_host.js";

interface MockCall {
  fragments: string[];
  values: unknown[];
  inTransaction: boolean;
}

/** postgres.js의 tagged template 함수를 흉내내는 mock. */
function createMockSql(resultFor?: (call: MockCall) => unknown[]) {
  const calls: MockCall[] = [];
  let inTransaction = false;

  const fn = ((strings: TemplateStringsArray, ...values: unknown[]) => {
    const call: MockCall = { fragments: Array.from(strings), values, inTransaction };
    calls.push(call);
    const result = resultFor ? resultFor(call) : [];
    // postgres.js의 query는 Promise<row[]>를 반환
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
  fn.begin = (async <T>(callback: (sql: SqlClient) => Promise<T>) => {
    inTransaction = true;
    try {
      return await callback(fn as unknown as SqlClient);
    } finally {
      inTransaction = false;
    }
  }) as typeof fn.begin;

  return { sql: fn as unknown as SqlClient, calls, begin: fn.begin };
}

function createFolderHostedDb(sql: SqlClient): SessionDB {
  const db = new SessionDB();
  const reads = configureTestBoardProjectionReadHost(db, sql);
  db.configureFolderHost(new FolderControlPlaneService(sql as never, () => reads.getBoardItems()) as never);
  return db;
}

describe("SessionDB folder ops (B-5)", () => {
  it("assignSessionToFolder → session_assign_folder(sessionId, folderId)", async () => {
    const { sql, calls } = createMockSql();
    await createFolderHostedDb(sql).assignSessionToFolder("sess-1", "folder-42");
    expect(calls).toHaveLength(1);
    expect(calls[0]!.values).toEqual(["sess-1", "folder-42"]);
    expect(calls[0]!.fragments.join("|")).toContain("session_assign_folder");
  });

  it("assignSessionToFolder(folderId=null) → stored proc에 NULL 전달 (폴더 해제)", async () => {
    const { sql, calls } = createMockSql();
    await createFolderHostedDb(sql).assignSessionToFolder("sess-1", null);
    expect(calls[0]!.values).toEqual(["sess-1", null]);
  });

  it("getDefaultFolder(name) → folder_get_default 호출, 첫 행 반환 또는 null", async () => {
    const folderRow = { id: "default-claude", name: "⚙️ 클로드 코드 세션" };
    const { sql: foundSql } = createMockSql(() => [folderRow]);
    expect(await createFolderHostedDb(foundSql).getDefaultFolder("⚙️ 클로드 코드 세션")).toEqual(folderRow);

    const { sql: emptySql } = createMockSql(() => []);
    expect(await createFolderHostedDb(emptySql).getDefaultFolder("missing")).toBeNull();
  });

  it("getCatalog → 평면 저장소에서 boardItems를 읽는다", async () => {
    const createdAt = new Date("2026-06-03T00:00:00.000Z");
    const folderRows = [
      {
        id: "f1",
        name: "F1",
        sort_order: 1,
        settings: { excludeFromFeed: true },
        parent_folder_id: null,
        project_page_id: "page-f1",
        archived: false,
        status: "open",
        version: 1,
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
        status: "open",
        version: 1,
      },
    ];
    const sessionRows = [
      { session_id: "s1", folder_id: "f1", display_name: "Hello" },
      { session_id: "s2", folder_id: null, display_name: null },
    ];
    const cachedBoardItems = [{
      id: "session:s1",
      folderId: "f1",
      membershipKind: "primary",
      itemType: "session",
      itemId: "s1",
      x: 0,
      y: 0,
      metadata: {},
      createdAt: "2026-06-03T00:00:00.000Z",
      updatedAt: "2026-06-03T00:00:00.000Z",
    }];
    const { sql, calls } = createMockSql((call) => {
      const text = call.fragments.join("|");
      if (text.includes("folder_get_all")) return folderRows;
      if (text.includes("catalog_get_sessions")) return sessionRows;
      if (text.includes("UNION ALL") && text.includes("FROM markdown_documents")) {
        return cachedBoardItems.map(item => ({
          id: item.id, folder_id: item.folderId, membership_kind: item.membershipKind,
          item_type: item.itemType, item_id: item.itemId, x: item.x, y: item.y,
          metadata: item.metadata, created_at: new Date(item.createdAt), updated_at: new Date(item.updatedAt),
        }));
      }
      if (text.includes("board_yjs_documents") || text.includes("board_yjs_updates")) {
        throw new Error("catalog must not decode or compact Yjs documents");
      }
      if (text.includes("INSERT INTO board_items") || text.includes("DELETE FROM board_items")) {
        throw new Error("catalog must not write board_items");
      }
      return [];
    });
    const db = createFolderHostedDb(sql);
    const catalog = await db.getCatalog();
    const secondCatalog = await db.getCatalog();

    expect(catalog.folders).toEqual([
      {
        id: "f1",
        name: "F1",
        sortOrder: 1,
        settings: { excludeFromFeed: true },
        parentFolderId: null,
        projectPageId: "page-f1",
        archived: false,
        status: "open",
        version: 1,
        createdAt: "2026-06-03T00:00:00.000Z",
      },
      {
        id: "f2",
        name: "F2",
        sortOrder: 2,
        settings: {},
        parentFolderId: "f1",
        projectPageId: null,
        archived: false,
        status: "open",
        version: 1,
      },  // null settings → 빈 객체로 정규화
    ]);
    expect(catalog.sessions).toEqual({
      s1: { folderId: "f1", displayName: "Hello" },
      s2: { folderId: null, displayName: null },
    });
    expect(catalog.boardItems).toEqual([
      {
        id: "session:s1",
        folderId: "f1",
        membershipKind: "primary",
        itemType: "session",
        itemId: "s1",
        x: 0,
        y: 0,
        metadata: {},
        createdAt: "2026-06-03T00:00:00.000Z",
        updatedAt: "2026-06-03T00:00:00.000Z",
      },
    ]);
    expect(secondCatalog.boardItems).toEqual(catalog.boardItems);
    expect(calls.filter((call) =>
      call.fragments.join("|").includes("FROM markdown_documents")
    )).toHaveLength(2);
    expect(calls.some((call) =>
      call.fragments.join("|").includes("board_yjs_documents") ||
      call.fragments.join("|").includes("board_yjs_updates")
    )).toBe(false);
    expect(calls.some((call) =>
      call.fragments.join("|").includes("board_item_get_all")
    )).toBe(false);
    expect(calls.some((call) =>
      call.fragments.join("|").includes("board_seed_items")
    )).toBe(false);
    expect(calls.some((call) =>
      call.fragments.join("|").includes("INSERT INTO board_items") ||
      call.fragments.join("|").includes("DELETE FROM board_items")
    )).toBe(false);
  });
});

describe("SessionDB.getPrimarySessionBoardItem", () => {
  it("getPrimarySessionBoardItem → primary session membership을 normalized board item으로 반환", async () => {
    const { calls } = createMockSql();
    const db = new SessionDB();
    const getPrimarySessionBoardItem = vi.fn().mockResolvedValue({
      id: "session:s1",
      folderId: "f1",
      containerKind: "task",
      containerId: "rb-1",
      membershipKind: "primary",
      sourceTaskItemId: "rb-item-1",
      itemType: "session",
      itemId: "s1",
      x: 32,
      y: 64,
      metadata: {},
      createdAt: "2026-07-07T00:00:00.000Z",
      updatedAt: "2026-07-07T00:00:00.000Z",
    });
    db.configureFolderContentHost({ getPrimarySessionBoardItem } as never);

    const item = await db.getPrimarySessionBoardItem("s1");

    expect(getPrimarySessionBoardItem).toHaveBeenCalledWith("s1");
    expect(calls).toHaveLength(0);
    expect(item).toEqual({
      id: "session:s1",
      folderId: "f1",
      containerKind: "task",
      containerId: "rb-1",
      membershipKind: "primary",
      sourceTaskItemId: "rb-item-1",
      itemType: "session",
      itemId: "s1",
      x: 32,
      y: 64,
      metadata: {},
      createdAt: "2026-07-07T00:00:00.000Z",
      updatedAt: "2026-07-07T00:00:00.000Z",
    });
  });

  it("getPrimarySessionBoardItem → row 없음이면 null", async () => {
    const { calls } = createMockSql();
    const db = new SessionDB();
    const getPrimarySessionBoardItem = vi.fn().mockResolvedValue(null);
    db.configureFolderContentHost({ getPrimarySessionBoardItem } as never);

    await expect(db.getPrimarySessionBoardItem("missing")).resolves.toBeNull();
    expect(getPrimarySessionBoardItem).toHaveBeenCalledWith("missing");
    expect(calls).toHaveLength(0);
  });
});

describe("SessionDB session-data host delegation", () => {
  it("preserves the public read interface while delegating to the configured host", async () => {
    const { calls } = createMockSql();
    const db = new SessionDB();
    const getSession = vi.fn().mockResolvedValue({ session_id: "s1" });
    const listSessionsSummary = vi.fn().mockResolvedValue({ sessions: [], total: 0 });
    const countEvents = vi.fn().mockResolvedValue(7);
    const getSessionOwnerNode = vi.fn().mockResolvedValue({ node_id: "node-a" });
    db.configureSessionDataHost({
      getSession,
      getSessionOwnerNode,
      listSessionsSummary,
      countEvents,
    } as never);

    await expect(db.getSession("s1")).resolves.toEqual({ session_id: "s1" });
    await expect(db.listSessionsSummary({ limit: 10, offset: 0 }))
      .resolves.toEqual({ sessions: [], total: 0 });
    await expect(db.countEvents("s1")).resolves.toBe(7);
    await expect(db.getSessionOwnerNode("s1")).resolves.toEqual({ node_id: "node-a" });

    expect(getSession).toHaveBeenCalledWith("s1");
    expect(getSessionOwnerNode).toHaveBeenCalledWith("s1");
    expect(listSessionsSummary).toHaveBeenCalledWith({ limit: 10, offset: 0 });
    expect(countEvents).toHaveBeenCalledWith("s1");
    expect(calls).toHaveLength(0);
  });

  it("keeps upstream binding warnings as a worker-side projection", async () => {
    const { calls } = createMockSql();
    const db = new SessionDB();
    const row = { session_id: "s1", display_name: "게이트", binding_warnings: [] };
    const listSessionsForUpstreamDump = vi.fn().mockResolvedValue({
      sessions: [row],
      total: 1,
    });
    const listForSessions = vi.fn().mockResolvedValue([{
      session_id: "s1",
      page_state: "manual_repair",
      legacy_state: "completed",
    }]);
    db.configureSessionDataHost({ listSessionsForUpstreamDump } as never);
    db.configureSessionPageBindingHost({ listForSessions } as never);

    const result = await db.listSessionsForUpstreamDump({
      limit: 10_000,
      offset: 0,
      nodeId: "node-1",
    });

    expect(listSessionsForUpstreamDump).toHaveBeenCalledWith({
      limit: 10_000,
      offset: 0,
      nodeId: "node-1",
    });
    expect(listForSessions).toHaveBeenCalledWith(["s1"]);
    expect(result.sessions[0]?.binding_warnings).not.toEqual([]);
    expect(calls).toHaveLength(0);
  });

  it("delegates turn excerpt and resume context without local SQL", async () => {
    const { calls } = createMockSql();
    const db = new SessionDB();
    const getTurnExcerpt = vi.fn().mockResolvedValue({ totalEvents: 0, turns: [] });
    const getResumeContext = vi.fn().mockResolvedValue({
      session: null,
      folderSessions: { sessions: [], total: 0 },
      runningSessions: { sessions: [], total: 0 },
      predecessor: null,
    });
    db.configureSessionDataHost({ getTurnExcerpt, getResumeContext } as never);

    await db.getTurnExcerpt("s1", 250);
    await db.getResumeContext("s1", 15);

    expect(getTurnExcerpt).toHaveBeenCalledWith("s1", 250);
    expect(getResumeContext).toHaveBeenCalledWith("s1", 15);
    expect(calls).toHaveLength(0);
  });
  it("getAllFolders → folder_get_all 행 그대로 + settings null 정규화", async () => {
    const { sql } = createMockSql(() => [
      {
        id: "f1",
        name: "F1",
        sort_order: 0,
        settings: { x: 1 },
        parent_folder_id: null,
        project_page_id: "page-f1",
        archived: false,
        status: "open",
        version: 1,
      },
      {
        id: "f2",
        name: "F2",
        sort_order: 1,
        settings: null,
        parent_folder_id: "f1",
        project_page_id: null,
        archived: false,
        status: "open",
        version: 1,
      },
    ]);
    const folders = await createFolderHostedDb(sql).getAllFolders();
    expect(folders).toEqual([
      {
        id: "f1",
        name: "F1",
        sort_order: 0,
        settings: { x: 1 },
        parent_folder_id: null,
        project_page_id: "page-f1",
        archived: false,
        status: "open",
        version: 1,
      },
      {
        id: "f2",
        name: "F2",
        sort_order: 1,
        settings: {},
        parent_folder_id: "f1",
        project_page_id: null,
        archived: false,
        status: "open",
        version: 1,
      },
    ]);
  });

});

describe("board_seed_items SQL", () => {
  it("limits cleanup and insertion to the requested folder", () => {
    const schema = readFileSync(
      new URL("../../../packages/db-schema/sql/schema.sql", import.meta.url),
      "utf8",
    );
    const start = schema.indexOf("CREATE OR REPLACE FUNCTION board_seed_items(p_folder_id TEXT)");
    const end = schema.indexOf("$$;", start);
    expect(start).toBeGreaterThanOrEqual(0);
    expect(end).toBeGreaterThan(start);
    const body = schema.slice(start, end);
    expect(body).toContain("pg_advisory_xact_lock");
    expect(body).toContain("hashtext('soulstream:board_items')::bigint");
    expect(body.match(/bi\.folder_id = p_folder_id/g)).toHaveLength(5);
    expect(body).toContain("s.folder_id = p_folder_id");
    expect(body).toContain("f.parent_folder_id = p_folder_id");
    expect(body).toContain("ON CONFLICT DO NOTHING");
    expect(body).toContain("existing_primary.membership_kind = 'primary'");
  });
});

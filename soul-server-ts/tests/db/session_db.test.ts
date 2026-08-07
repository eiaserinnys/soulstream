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
import { ClaudeTranscriptRepository } from "../../../orch-server-ts/src/control_plane/repositories/claude_transcript_repository.js";

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
  fn.begin = vi.fn(async <T>(callback: (sql: SqlClient) => Promise<T>) => {
    inTransaction = true;
    try {
      return await callback(fn as unknown as SqlClient);
    } finally {
      inTransaction = false;
    }
  });

  return { sql: fn as unknown as SqlClient, calls, begin: fn.begin };
}

function createFolderHostedDb(sql: SqlClient): SessionDB {
  const db = new SessionDB();
  db.configureFolderHost(new FolderControlPlaneService(sql as never) as never);
  return db;
}

describe("SessionDB Claude transcript mirror", () => {
  it("appendClaudeTranscriptEntries delegates JSON batch to stored proc", async () => {
    const { sql, calls } = createMockSql(() => [{ claude_transcript_append: 2 }]);
    const db = new ClaudeTranscriptRepository(sql);

    const written = await db.appendClaudeTranscriptEntries(
      { projectKey: "project-a", sessionId: "claude-sess-1" },
      [
        { type: "user", uuid: "u1", message: { content: "hi" } },
        { type: "assistant", uuid: "a1", message: { content: "hello" } },
      ],
    );

    expect(written).toBe(2);
    expect(calls).toHaveLength(1);
    const [call] = calls;
    expect(call.fragments.join("?")).toContain("claude_transcript_append");
    expect(call.values[0]).toBe("project-a");
    expect(call.values[1]).toBe("claude-sess-1");
    expect(call.values[2]).toBeNull();
    expect(JSON.parse(call.values[3] as string)).toEqual([
      { type: "user", uuid: "u1", message: { content: "hi" } },
      { type: "assistant", uuid: "a1", message: { content: "hello" } },
    ]);
    expect(call.values[4]).toBeInstanceOf(Date);
  });

  it("appendClaudeTranscriptEntries no-ops for empty batches", async () => {
    const { sql, calls } = createMockSql();
    const db = new ClaudeTranscriptRepository(sql);

    const written = await db.appendClaudeTranscriptEntries(
      { projectKey: "project-a", sessionId: "claude-sess-1" },
      [],
    );

    expect(written).toBe(0);
    expect(calls).toHaveLength(0);
  });

  it("loadClaudeTranscriptEntries returns null when the store has no rows", async () => {
    const { sql, calls } = createMockSql(() => []);
    const db = new ClaudeTranscriptRepository(sql);

    const entries = await db.loadClaudeTranscriptEntries({
      projectKey: "project-a",
      sessionId: "missing",
      subpath: "subagents/agent-a",
    });

    expect(entries).toBeNull();
    expect(calls[0].fragments.join("?")).toContain("claude_transcript_load");
    expect(calls[0].values).toEqual(["project-a", "missing", "subagents/agent-a"]);
  });

  it("loadClaudeTranscriptEntries parses entry JSON rows in storage order", async () => {
    const { sql } = createMockSql(() => [
      { entry: { type: "user", uuid: "u1" } },
      { entry: { type: "assistant", uuid: "a1" } },
    ]);
    const db = new ClaudeTranscriptRepository(sql);

    await expect(
      db.loadClaudeTranscriptEntries({ projectKey: "project-a", sessionId: "claude-sess-1" }),
    ).resolves.toEqual([
      { type: "user", uuid: "u1" },
      { type: "assistant", uuid: "a1" },
    ]);
  });

  it("list/delete transcript helpers preserve project/session/subpath keys", async () => {
    const { sql, calls } = createMockSql((call) => {
      const query = call.fragments.join("?");
      if (query.includes("claude_transcript_list_sessions")) {
        return [{ session_id: "claude-sess-1", mtime: "1770000000000" }];
      }
      if (query.includes("claude_transcript_list_subkeys")) {
        return [{ subpath: "subagents/agent-a" }];
      }
      return [];
    });
    const db = new ClaudeTranscriptRepository(sql);

    await expect(db.listClaudeTranscriptSessions("project-a")).resolves.toEqual([
      { sessionId: "claude-sess-1", mtime: 1770000000000 },
    ]);
    await expect(
      db.listClaudeTranscriptSubkeys({ projectKey: "project-a", sessionId: "claude-sess-1" }),
    ).resolves.toEqual(["subagents/agent-a"]);
    await db.deleteClaudeTranscript({
      projectKey: "project-a",
      sessionId: "claude-sess-1",
      subpath: "subagents/agent-a",
    });

    expect(calls[0].fragments.join("?")).toContain("claude_transcript_list_sessions");
    expect(calls[0].values).toEqual(["project-a"]);
    expect(calls[1].fragments.join("?")).toContain("claude_transcript_list_subkeys");
    expect(calls[1].values).toEqual(["project-a", "claude-sess-1"]);
    expect(calls[2].fragments.join("?")).toContain("claude_transcript_delete");
    expect(calls[2].values).toEqual(["project-a", "claude-sess-1", "subagents/agent-a"]);
  });
});


describe("SessionDB folder ops (B-5)", () => {
  it("assignSessionToFolder → session_assign_folder(sessionId, folderId)", async () => {
    const { sql, calls } = createMockSql();
    await createFolderHostedDb(sql).assignSessionToFolder("sess-1", "folder-42");
    expect(calls).toHaveLength(1);
    expect(calls[0].values).toEqual(["sess-1", "folder-42"]);
    expect(calls[0].fragments.join("|")).toContain("session_assign_folder");
  });

  it("assignSessionToFolder(folderId=null) → stored proc에 NULL 전달 (폴더 해제)", async () => {
    const { sql, calls } = createMockSql();
    await createFolderHostedDb(sql).assignSessionToFolder("sess-1", null);
    expect(calls[0].values).toEqual(["sess-1", null]);
  });

  it("getDefaultFolder(name) → folder_get_default 호출, 첫 행 반환 또는 null", async () => {
    const folderRow = { id: "default-claude", name: "⚙️ 클로드 코드 세션" };
    const { sql: foundSql } = createMockSql(() => [folderRow]);
    expect(await createFolderHostedDb(foundSql).getDefaultFolder("⚙️ 클로드 코드 세션")).toEqual(folderRow);

    const { sql: emptySql } = createMockSql(() => []);
    expect(await createFolderHostedDb(emptySql).getDefaultFolder("missing")).toBeNull();
  });

  it("getCatalog → catalog cache 우선 + legacy read-only fallback으로 boardItems를 합성", async () => {
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
    ];
    const sessionRows = [
      { session_id: "s1", folder_id: "f1", display_name: "Hello" },
      { session_id: "s2", folder_id: null, display_name: null },
    ];
    const cachedBoardItems = [{
      id: "session:s1",
      folderId: "f1",
      containerKind: "folder",
      containerId: "f1",
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
      if (text.includes("FROM board_yjs_catalog_cache")) {
        return [{ container_id: "f1", board_items: cachedBoardItems }];
      }
      if (text.includes("board_yjs_documents") || text.includes("board_yjs_updates")) {
        throw new Error("catalog must not decode or compact Yjs documents");
      }
      if (text.includes("board_item_get_all")) {
        throw new Error("catalog must not read all board_items when cache exists");
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
        createdAt: "2026-06-03T00:00:00.000Z",
      },
      {
        id: "f2",
        name: "F2",
        sortOrder: 2,
        settings: {},
        parentFolderId: "f1",
        projectPageId: null,
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
        containerKind: "folder",
        containerId: "f1",
        membershipKind: "primary",
        sourceTaskItemId: null,
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
      call.fragments.join("|").includes("FROM board_yjs_catalog_cache")
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
    const { sql, calls } = createMockSql();
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
    db.configureBoardProjectionHost({ getPrimarySessionBoardItem } as never);

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
    const { sql, calls } = createMockSql();
    const db = new SessionDB();
    const getPrimarySessionBoardItem = vi.fn().mockResolvedValue(null);
    db.configureBoardProjectionHost({ getPrimarySessionBoardItem } as never);

    await expect(db.getPrimarySessionBoardItem("missing")).resolves.toBeNull();
    expect(getPrimarySessionBoardItem).toHaveBeenCalledWith("missing");
    expect(calls).toHaveLength(0);
  });
});

describe("SessionDB session-data host delegation", () => {
  it("preserves the public read interface while delegating to the configured host", async () => {
    const { sql, calls } = createMockSql();
    const db = new SessionDB();
    const getSession = vi.fn().mockResolvedValue({ session_id: "s1" });
    const listSessionsSummary = vi.fn().mockResolvedValue({ sessions: [], total: 0 });
    const countEvents = vi.fn().mockResolvedValue(7);
    db.configureSessionDataHost({
      getSession,
      listSessionsSummary,
      countEvents,
    } as never);

    await expect(db.getSession("s1")).resolves.toEqual({ session_id: "s1" });
    await expect(db.listSessionsSummary({ limit: 10, offset: 0 }))
      .resolves.toEqual({ sessions: [], total: 0 });
    await expect(db.countEvents("s1")).resolves.toBe(7);

    expect(getSession).toHaveBeenCalledWith("s1");
    expect(listSessionsSummary).toHaveBeenCalledWith({ limit: 10, offset: 0 });
    expect(countEvents).toHaveBeenCalledWith("s1");
    expect(calls).toHaveLength(0);
  });

  it("keeps upstream binding warnings as a worker-side projection", async () => {
    const { sql, calls } = createMockSql();
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
    const { sql, calls } = createMockSql();
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
      },
      {
        id: "f2",
        name: "F2",
        sort_order: 1,
        settings: null,
        parent_folder_id: "f1",
        project_page_id: null,
        archived: false,
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
      },
      {
        id: "f2",
        name: "F2",
        sort_order: 1,
        settings: {},
        parent_folder_id: "f1",
        project_page_id: null,
      },
    ]);
  });

  it("createFolder → identity host 우회를 명시적으로 거부", async () => {
    const { sql, calls } = createMockSql();
    const db = new SessionDB();

    await expect(db.createFolder("child", "Child", 7, "parent")).rejects.toThrow(
      "folder creation must use identity host",
    );

    expect(calls).toHaveLength(0);
  });

  it("updateFolder parent_folder_id=null → 루트 승격을 stored proc에 null로 전달", async () => {
    const { sql, calls } = createMockSql();
    const db = createFolderHostedDb(sql);

    await db.updateFolder("child", ["parent_folder_id"], [null]);

    expect(calls).toHaveLength(1);
    expect(calls[0].values).toEqual(["child", ["parent_folder_id"], [null]]);
  });

});

describe("session_delete SQL", () => {
  it("세션 삭제 전 transcript mirror row를 agent/Claude session id 기준으로 정리한다", () => {
    const schema = readFileSync(
      new URL("../../../packages/db-schema/sql/schema.sql", import.meta.url),
      "utf8",
    );
    const migration = readFileSync(
      new URL("../../../packages/db-schema/sql/migrations/015_claude_transcript_store.sql", import.meta.url),
      "utf8",
    );

    for (const sql of [schema, migration]) {
      const start = sql.indexOf("CREATE OR REPLACE FUNCTION session_delete");
      const end = sql.indexOf("$$;", start);
      expect(start).toBeGreaterThanOrEqual(0);
      expect(end).toBeGreaterThan(start);
      const body = sql.slice(start, end);
      expect(body).toContain("DELETE FROM claude_transcript_entries");
      expect(body).toContain("claude_session_id");
      expect(body.indexOf("DELETE FROM claude_transcript_entries")).toBeLessThan(
        body.indexOf("DELETE FROM sessions"),
      );
    }
  });
});

describe("board_seed_items SQL", () => {
  it("serializes board_items writes, ignores unique conflicts, and excludes sessions with primary membership elsewhere", () => {
    const schema = readFileSync(
      new URL("../../../packages/db-schema/sql/schema.sql", import.meta.url),
      "utf8",
    );
    const migration = readFileSync(
      new URL("../../../packages/db-schema/sql/migrations/033_board_seed_primary_membership_guard.sql", import.meta.url),
      "utf8",
    );

    for (const sql of [schema, migration]) {
      const start = sql.indexOf("CREATE OR REPLACE FUNCTION board_seed_items");
      const end = sql.indexOf("$$;", start);
      expect(start).toBeGreaterThanOrEqual(0);
      expect(end).toBeGreaterThan(start);
      const body = sql.slice(start, end);
      expect(body).toContain("pg_advisory_xact_lock");
      expect(body).toContain("hashtext('soulstream:board_items')::bigint");
      expect(body).toContain("ON CONFLICT DO NOTHING");
      expect(body).not.toContain("ON CONFLICT (id) DO NOTHING");
      expect(body).toContain("existing_primary.item_type = 'session'");
      expect(body).toContain("existing_primary.item_id = s.session_id");
      expect(body).toContain("existing_primary.membership_kind = 'primary'");
    }
  });
});

describe("claude_transcript_append SQL", () => {
  it("normalizes JSONB batch shape before jsonb_array_elements", () => {
    const schema = readFileSync(
      new URL("../../../packages/db-schema/sql/schema.sql", import.meta.url),
      "utf8",
    );
    const migration = readFileSync(
      new URL(
        "../../../packages/db-schema/sql/migrations/016_claude_transcript_append_jsonb_shape_guard.sql",
        import.meta.url,
      ),
      "utf8",
    );

    for (const sql of [schema, migration]) {
      const start = sql.indexOf("CREATE OR REPLACE FUNCTION claude_transcript_append");
      const end = sql.indexOf("$$;", start);
      expect(start).toBeGreaterThanOrEqual(0);
      expect(end).toBeGreaterThan(start);
      const body = sql.slice(start, end);
      expect(body).toContain("jsonb_typeof(p_entries)");
      expect(body).toContain("WHEN 'array'");
      expect(body).toContain("WHEN 'object'");
      expect(body).toContain("'[]'::jsonb");
      expect(body).toContain("jsonb_array_elements(v_entries)");
    }
  });
});

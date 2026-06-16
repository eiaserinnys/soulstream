/**
 * SessionDB 단위 테스트 — mock sql tagged-template 함수로 호출 인자 검증.
 *
 * 통합 동작(stored proc 실행)은 별도 e2e 또는 testcontainers — 본 PR 범위 외.
 * 본 테스트는 *SessionDB의 책임* (인자 직렬화, 화이트리스트 가드, 반환 파싱)만 검증.
 */

import { readFileSync } from "node:fs";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { createBoardYDocSnapshot } from "../../src/collaboration/board_yjs_model.js";
import { SessionDB, type SqlClient } from "../../src/db/session_db.js";
import { MarkdownDocumentVersionConflictError } from "../../src/db/markdown_document_version.js";

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

describe("SessionDB.ensureStableSessionOrderIndex", () => {
  it("runs the stable session order index concurrently outside a transaction", async () => {
    const { sql, calls } = createMockSql();

    await new SessionDB(sql).ensureStableSessionOrderIndex();

    expect(calls).toHaveLength(2);
    const stateQuery = calls[0].fragments.join("?");
    expect(stateQuery).toContain("FROM pg_class c");
    expect(stateQuery).toContain("JOIN pg_index i ON i.indexrelid = c.oid");
    expect(stateQuery).toContain("idx_sessions_updated_at_session_id");
    expect(calls[0].inTransaction).toBe(false);

    const query = calls[1].fragments.join("?");
    expect(query).toContain(
      "CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_sessions_updated_at_session_id",
    );
    expect(query).toContain("ON sessions (updated_at DESC, session_id DESC)");
    expect(calls[1].inTransaction).toBe(false);
  });

  it("drops an invalid stable session order index before recreating it", async () => {
    const { sql, calls } = createMockSql((call) => {
      const query = call.fragments.join("?");
      if (query.includes("FROM pg_class c")) {
        return [{ indisvalid: false, indisready: false }];
      }
      return [];
    });

    await new SessionDB(sql).ensureStableSessionOrderIndex();

    expect(calls).toHaveLength(3);
    const dropQuery = calls[1].fragments.join("?");
    expect(dropQuery).toContain(
      "DROP INDEX CONCURRENTLY idx_sessions_updated_at_session_id",
    );
    expect(calls.every((call) => !call.inTransaction)).toBe(true);

    const createQuery = calls[2].fragments.join("?");
    expect(createQuery).toContain(
      "CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_sessions_updated_at_session_id",
    );
  });
});

describe("SessionDB.registerSession", () => {
  it("11개 인자가 순서대로 stored proc에 전달됨", async () => {
    const { sql, calls } = createMockSql();
    const db = new SessionDB(sql);

    const now = new Date("2026-05-17T01:00:00Z");
    await db.registerSession({
      sessionId: "sess-1",
      nodeId: "eias-shopping-ts",
      agentId: "codex-default",
      claudeSessionId: null,
      sessionType: "claude",
      prompt: "hello",
      clientId: null,
      status: "running",
      createdAt: now,
      updatedAt: now,
      callerSessionId: null,
    });

    expect(calls).toHaveLength(1);
    const [call] = calls;
    expect(call.values).toEqual([
      "sess-1",
      "eias-shopping-ts",
      "codex-default",
      null,
      "claude",
      "hello",
      null,
      "running",
      now,
      now,
      null,
    ]);
    expect(call.fragments.join("?")).toContain("session_register");
  });
});

describe("SessionDB.updateSession", () => {
  it("화이트리스트 외 컬럼 → 진입 throw (stored proc 호출 안 함)", async () => {
    const { sql, calls } = createMockSql();
    const db = new SessionDB(sql);

    await expect(
      // @ts-expect-error — 타입은 막지만 runtime gate 검증
      db.updateSession("sess-1", { session_type: "llm" }),
    ).rejects.toThrow(/not in session_update whitelist/);

    expect(calls).toHaveLength(0);
  });

  it("빈 fields → no-op (stored proc 호출 안 함)", async () => {
    const { sql, calls } = createMockSql();
    const db = new SessionDB(sql);
    await db.updateSession("sess-1", {});
    expect(calls).toHaveLength(0);
  });

  it("status + last_event_id 정상 전달", async () => {
    const { sql, calls } = createMockSql();
    const db = new SessionDB(sql);
    await db.updateSession("sess-1", {
      status: "completed",
      last_event_id: 42,
    });
    expect(calls).toHaveLength(1);
    const [call] = calls;
    // values: [sessionId, columns[], values[], updatedAt]
    expect(call.values[0]).toBe("sess-1");
    expect(call.values[1]).toEqual(["status", "last_event_id"]);
    expect(call.values[2]).toEqual(["completed", "42"]);
    expect(call.values[3]).toBeInstanceOf(Date);
  });

  it("last_message는 JSON 직렬화", async () => {
    const { sql, calls } = createMockSql();
    const db = new SessionDB(sql);
    await db.updateSession("sess-1", {
      last_message: { type: "text_delta", preview: "hi", timestamp: "2026" },
    });
    const [, , values] = calls[0].values as [string, string[], string[], Date];
    expect(JSON.parse(values[0])).toEqual({
      type: "text_delta",
      preview: "hi",
      timestamp: "2026",
    });
  });

  it("boolean → 'true'/'false' 문자열 변환", async () => {
    const { sql, calls } = createMockSql();
    const db = new SessionDB(sql);
    await db.updateSession("sess-1", { was_running_at_shutdown: true });
    const [, , values] = calls[0].values as [string, string[], string[], Date];
    expect(values[0]).toBe("true");
  });

  it("null 명시 → null 그대로 전달", async () => {
    const { sql, calls } = createMockSql();
    const db = new SessionDB(sql);
    await db.updateSession("sess-1", { folder_id: null });
    const [, , values] = calls[0].values as [string, string[], unknown[], Date];
    expect(values[0]).toBeNull();
  });
});

describe("SessionDB.interruptRunningSessionsForNode", () => {
  it("같은 노드의 running 세션을 interrupted로 전환하고 개수를 반환", async () => {
    const { sql, calls } = createMockSql(() => [{ interrupted_count: "3" }]);
    const db = new SessionDB(sql);

    const count = await db.interruptRunningSessionsForNode("node-1");

    expect(count).toBe(3);
    expect(calls).toHaveLength(1);
    expect(calls[0].values).toEqual(["node-1"]);
    const query = calls[0].fragments.join("?");
    expect(query).toContain("UPDATE sessions");
    expect(query).toContain("status = 'interrupted'");
    expect(query).toContain("was_running_at_shutdown = FALSE");
    expect(query).toContain("node_id =");
    expect(query).toContain("status = 'running'");
  });

  it("반환 행이 비어 있으면 0", async () => {
    const { sql } = createMockSql(() => []);
    const count = await new SessionDB(sql).interruptRunningSessionsForNode("node-1");
    expect(count).toBe(0);
  });
});

describe("SessionDB.appendMetadata", () => {
  it("caller_info entry를 session_append_metadata stored proc에 JSON 배열로 전달", async () => {
    const { sql, calls } = createMockSql(() => [{ session_append_metadata: 7 }]);
    const db = new SessionDB(sql);

    const eventId = await db.appendMetadata("sess-1", {
      type: "caller_info",
      value: { source: "slack", display_name: "Alice" },
    });

    expect(eventId).toBe(7);
    expect(calls).toHaveLength(1);
    const [call] = calls;
    expect(call.fragments.join("?")).toContain("session_append_metadata");
    expect(call.values[0]).toBe("sess-1");
    expect(JSON.parse(call.values[1] as string)).toEqual([
      { type: "caller_info", value: { source: "slack", display_name: "Alice" } },
    ]);
    expect(call.values[2]).toBe("metadata");
    expect(JSON.parse(call.values[3] as string)).toMatchObject({
      type: "metadata",
      metadata_type: "caller_info",
      value: { source: "slack", display_name: "Alice" },
    });
    expect(call.values[5]).toBeInstanceOf(Date);
  });
});

describe("SessionDB board Yjs persistence", () => {
  it("snapshot 저장과 조회는 board_yjs_documents를 사용", async () => {
    const snapshot = Buffer.from([1, 2, 3]);
    const { sql, calls } = createMockSql((call) => {
      if (call.fragments.join("?").includes("SELECT snapshot FROM board_yjs_documents")) {
        return [{ snapshot }];
      }
      return [];
    });
    const db = new SessionDB(sql);

    await db.storeBoardYjsSnapshot("board-folder:f1", snapshot);
    const loaded = await db.getBoardYjsSnapshot("board-folder:f1");

    expect(calls[0].fragments.join("?")).toContain("INSERT INTO board_yjs_documents");
    expect(calls[0].values[0]).toBe("board-folder:f1");
    expect(calls[0].values[1]).toEqual(snapshot);
    expect(loaded).toEqual(new Uint8Array(snapshot));
  });

  it("update log는 document row를 보장한 뒤 board_yjs_updates에 append", async () => {
    const { sql, calls } = createMockSql();
    const db = new SessionDB(sql);

    await db.appendBoardYjsUpdate("board-folder:f1", new Uint8Array([9]));

    expect(calls).toHaveLength(2);
    expect(calls[0].fragments.join("?")).toContain("INSERT INTO board_yjs_documents");
    expect(calls[1].fragments.join("?")).toContain("INSERT INTO board_yjs_updates");
    expect(calls[1].values).toEqual(["board-folder:f1", Buffer.from([9])]);
  });

  it("첫 진입 seed는 board_items와 markdown_documents를 함께 로드", async () => {
    const { sql } = createMockSql((call) => {
      const query = call.fragments.join("?");
      if (query.includes("board_item_get_all")) {
        return [
          {
            id: "markdown:d1",
            folder_id: "f1",
            item_type: "markdown",
            item_id: "d1",
            x: 0,
            y: 0,
            metadata: { title: "Note" },
            created_at: null,
            updated_at: null,
          },
          {
            id: "session:s2",
            folder_id: "f2",
            item_type: "session",
            item_id: "s2",
            x: 0,
            y: 0,
            metadata: {},
            created_at: null,
            updated_at: null,
          },
        ];
      }
      if (query.includes("FROM markdown_documents")) {
        return [{ id: "d1", title: "Note", body: "Body", version: 1, created_at: null, updated_at: null }];
      }
      return [];
    });
    const db = new SessionDB(sql);

    const seed = await db.loadBoardYjsSeed("f1");

    expect(seed.boardItems).toHaveLength(1);
    expect(seed.boardItems[0].id).toBe("markdown:d1");
    expect(seed.markdownDocuments).toEqual([{ id: "d1", title: "Note", body: "Body", version: 1 }]);
  });

  it("replica sync는 폴더 내 누락 item 삭제 후 board_items와 markdown_documents를 upsert", async () => {
    const { sql, calls } = createMockSql();
    const db = new SessionDB(sql);

    await db.syncBoardYjsReplica("f1", {
      boardItems: [{
        id: "markdown:d1",
        folderId: "f1",
        itemType: "markdown",
        itemId: "d1",
        x: 280,
        y: 160,
        metadata: { title: "Note" },
      }],
      markdownDocuments: [{ id: "d1", title: "Note", body: "Body", version: 3 }],
    });

    expect(calls[0].fragments.join("?")).toContain("pg_advisory_xact_lock");
    expect(calls[1].fragments.join("?")).toContain("DELETE FROM board_items");
    expect(calls[2].fragments.join("?")).toContain("INSERT INTO board_items");
    expect(calls[3].fragments.join("?")).toContain("INSERT INTO markdown_documents");
    expect(calls[4].fragments.join("?")).toContain("INSERT INTO board_yjs_catalog_cache");
    expect(calls[2].values[6]).toEqual({ title: "Note" });
    expect(calls[4].values[0]).toBe("f1");
    expect(calls[4].values[1]).toEqual([
      expect.objectContaining({ id: "markdown:d1", x: 280, y: 160 }),
    ]);
    expect(calls[4].values[2]).toEqual([
      expect.objectContaining({ id: "d1", title: "Note", body: "Body", version: 3 }),
    ]);
    expect(typeof calls[4].values[1]).not.toBe("string");
    expect(typeof calls[4].values[2]).not.toBe("string");
  });

  it("replica sync는 lock, board_items, markdown_documents, catalog cache 갱신을 한 transaction에서 수행", async () => {
    const { sql, calls, begin } = createMockSql();
    const db = new SessionDB(sql);

    await db.syncBoardYjsReplica("f1", {
      boardItems: [{
        id: "markdown:d1",
        folderId: "f1",
        itemType: "markdown",
        itemId: "d1",
        x: 280,
        y: 160,
        metadata: { title: "Note" },
      }],
      markdownDocuments: [{ id: "d1", title: "Note", body: "Body", version: 3 }],
    });

    expect(begin).toHaveBeenCalledTimes(1);
    const mutationCalls = calls.filter((call) => {
      const query = call.fragments.join("?");
      return (
        query.includes("pg_advisory_xact_lock") ||
        query.includes("DELETE FROM board_items") ||
        query.includes("INSERT INTO board_items") ||
        query.includes("INSERT INTO markdown_documents") ||
        query.includes("INSERT INTO board_yjs_catalog_cache")
      );
    });
    expect(mutationCalls).toHaveLength(5);
    expect(mutationCalls.every((call) => call.inTransaction)).toBe(true);
  });

  it("markdown update는 matching version에서만 성공하고 version을 증가시킨다", async () => {
    const { sql, calls } = createMockSql((call) => {
      const query = call.fragments.join("?");
      if (query.includes("UPDATE markdown_documents")) {
        return [{
          id: "doc-1",
          title: "New",
          body: "Body",
          version: 2,
          created_at: null,
          updated_at: null,
        }];
      }
      return [];
    });
    const db = new SessionDB(sql);

    const updated = await db.updateMarkdownDocument("doc-1", {
      title: "New",
      expectedVersion: 1,
    });

    expect(updated).toEqual({ id: "doc-1", title: "New", body: "Body", version: 2 });
    const updateCall = calls.find((call) =>
      call.fragments.join("?").includes("UPDATE markdown_documents")
    );
    expect(updateCall?.fragments.join("?")).toContain("version = version + 1");
    expect(updateCall?.fragments.join("?")).toContain("AND version =");
    expect(updateCall?.values).toContain(1);
  });

  it("markdown stale update는 기존 document가 있으면 conflict로 거부한다", async () => {
    const { sql } = createMockSql((call) => {
      const query = call.fragments.join("?");
      if (query.includes("UPDATE markdown_documents")) return [];
      if (query.includes("SELECT * FROM markdown_documents")) {
        return [{
          id: "doc-1",
          title: "Old",
          body: "Original",
          version: 2,
          created_at: null,
          updated_at: null,
        }];
      }
      return [];
    });
    const db = new SessionDB(sql);

    await expect(
      db.updateMarkdownDocument("doc-1", {
        body: "Stale body",
        expectedVersion: 1,
      }),
    ).rejects.toBeInstanceOf(MarkdownDocumentVersionConflictError);
  });
});

describe("SessionDB.setClaudeSessionId (F-3B)", () => {
  it("T5: session_set_claude_id stored proc에 (sessionId, threadId) 전달", async () => {
    const { sql, calls } = createMockSql();
    const db = new SessionDB(sql);

    await db.setClaudeSessionId("sess-1", "thr-codex-abc123");

    expect(calls).toHaveLength(1);
    const [call] = calls;
    expect(call.values).toEqual(["sess-1", "thr-codex-abc123"]);
    expect(call.fragments.join("?")).toContain("session_set_claude_id");
  });

  it("stored proc throw (예: immutability violation) → 호출자에게 그대로 전파", async () => {
    const sqlFn = ((_strings: TemplateStringsArray) => {
      return Promise.reject(
        new Error("claude_session_id immutability violation"),
      );
    }) as unknown as SqlClient & {
      array: (a: unknown[]) => unknown[];
      end: () => Promise<void>;
    };
    sqlFn.array = (a) => a;
    sqlFn.end = vi.fn().mockResolvedValue(undefined);

    const db = new SessionDB(sqlFn as unknown as SqlClient);
    await expect(
      db.setClaudeSessionId("sess-1", "thr-different"),
    ).rejects.toThrow(/immutability violation/);
  });
});

describe("SessionDB.updateLastMessage", () => {
  it("last_message JSON + updatedAt 전달", async () => {
    const { sql, calls } = createMockSql();
    const db = new SessionDB(sql);
    const msg = { type: "text_delta", preview: "x", timestamp: "2026" };
    await db.updateLastMessage("sess-1", msg);

    expect(calls).toHaveLength(1);
    const [call] = calls;
    expect(call.values[0]).toBe("sess-1");
    expect(JSON.parse(call.values[1] as string)).toEqual(msg);
    expect(call.values[2]).toBeInstanceOf(Date);
  });
});

describe("SessionDB.appendEvent", () => {
  it("반환 event_id를 number로 파싱", async () => {
    const { sql, calls } = createMockSql(() => [{ event_append: 7 }]);
    const db = new SessionDB(sql);
    const createdAt = new Date();
    const id = await db.appendEvent({
      sessionId: "sess-1",
      eventType: "text_delta",
      payload: '{"type":"text_delta"}',
      searchableText: "hi",
      createdAt,
      dedupeKey: "claude-sdk:assistant:msg-1:0",
    });
    expect(id).toBe(7);
    expect(calls[0].values).toEqual([
      "sess-1",
      "text_delta",
      '{"type":"text_delta"}',
      "hi",
      createdAt,
      "claude-sdk:assistant:msg-1:0",
    ]);
  });

  it("dedupe key로 기존 event id를 조회", async () => {
    const { sql, calls } = createMockSql(() => [{ id: "17" }]);
    const db = new SessionDB(sql);
    const id = await db.findEventIdByDedupeKey(
      "sess-1",
      "claude-sdk:assistant:msg-1:0",
    );

    expect(id).toBe(17);
    expect(calls[0].fragments.join("?")).toContain("dedupe_key");
    expect(calls[0].values).toEqual([
      "sess-1",
      "claude-sdk:assistant:msg-1:0",
    ]);
  });

  it("반환에 event_append 키 없으면 throw", async () => {
    const { sql } = createMockSql(() => [{}]);
    const db = new SessionDB(sql);
    await expect(
      db.appendEvent({
        sessionId: "sess-1",
        eventType: "text_delta",
        payload: "{}",
        searchableText: "",
        createdAt: new Date(),
      }),
    ).rejects.toThrow(/event_append returned non-number/);
  });
});

describe("SessionDB supervisor data layer", () => {
  it("appendSupervisorEvent → supervisor_event_append payload JSON + result parse", async () => {
    const now = new Date("2026-06-07T09:00:00Z");
    const { sql, calls } = createMockSql(() => [
      {
        offset: "5",
        inserted: true,
        contiguous_upto: 3,
        highest_seen_event_id: 3,
        gap_start: null,
        gap_end: null,
      },
    ]);
    const db = new SessionDB(sql);

    const result = await db.appendSupervisorEvent({
      sourceNode: "node-a",
      sourceSessionId: "sess-a",
      sourceEventId: 3,
      eventType: "text_delta",
      payload: { text: "안녕" },
      createdAt: now,
    });

    expect(result).toEqual({
      offset: 5,
      inserted: true,
      contiguousUpto: 3,
      highestSeenEventId: 3,
      gapStart: null,
      gapEnd: null,
    });
    expect(calls).toHaveLength(1);
    expect(calls[0].fragments.join("?")).toContain("supervisor_event_append");
    expect(calls[0].values).toEqual([
      "node-a",
      "sess-a",
      3,
      "text_delta",
      "{\"text\":\"안녕\"}",
      now,
    ]);
  });

  it("readSupervisorEventsAfter → supervisor_event_read_after ordered rows", async () => {
    const createdAt = new Date("2026-06-07T09:00:00Z");
    const insertedAt = new Date("2026-06-07T09:00:01Z");
    const { sql, calls } = createMockSql(() => [
      {
        offset: "1",
        source_node: "node-a",
        source_session_id: "sess-a",
        source_event_id: 1,
        event_type: "text_delta",
        payload: { text: "hello" },
        created_at: createdAt,
        inserted_at: insertedAt,
      },
    ]);

    const rows = await new SessionDB(sql).readSupervisorEventsAfter(0, 10);

    expect(calls[0].fragments.join("?")).toContain("supervisor_event_read_after");
    expect(calls[0].values).toEqual([0, 10]);
    expect(rows[0]).toEqual({
      offset: 1,
      sourceNode: "node-a",
      sourceSessionId: "sess-a",
      sourceEventId: 1,
      eventType: "text_delta",
      payload: { text: "hello" },
      createdAt,
      insertedAt,
    });
  });

  it("getSupervisorEventHeadOffset → supervisor_events max offset", async () => {
    const { sql, calls } = createMockSql(() => [{ head: "123" }]);

    const head = await new SessionDB(sql).getSupervisorEventHeadOffset();

    expect(calls[0].fragments.join("?")).toContain('MAX("offset")');
    expect(head).toBe(123);
  });

  it("consumer cursor and registry methods call supervisor procedures", async () => {
    const now = new Date("2026-06-07T09:00:00Z");
    const { sql, calls } = createMockSql((call) => {
      const query = call.fragments.join("?");
      if (query.includes("supervisor_consumer_cursor_get")) {
        return [{ supervisor_consumer_cursor_get: "7" }];
      }
      if (query.includes("supervisor_consumer_cursor_set")) {
        return [{ supervisor_consumer_cursor_set: "9" }];
      }
      if (query.includes("supervisor_registry_upsert")) {
        return [
          {
            role: "cluster",
            active_session_id: "sess-supervisor",
            epoch: "2",
            cursor_offset: "9",
            handover_state: "hard_pending",
            cumulative_tokens: "42",
            compaction_count: "1",
            last_seen_at: now,
            wake_dispatch_state: "active",
            wake_last_signature: null,
            wake_repeat_count: "0",
            wake_blocked_reason: null,
            wake_blocked_at: null,
            created_at: now,
            updated_at: now,
          },
        ];
      }
      if (query.includes("supervisor_registry_set_wake_dispatch_state")) {
        return [
          {
            role: "cluster",
            active_session_id: "sess-supervisor",
            epoch: "2",
            cursor_offset: "9",
            handover_state: "hard_pending",
            cumulative_tokens: "42",
            compaction_count: "1",
            last_seen_at: now,
            wake_dispatch_state: "blocked",
            wake_last_signature: "events|9->10|count=1|sources=sess-a|types=user_message",
            wake_repeat_count: "3",
            wake_blocked_reason: "wake delivery failed before cursor advance",
            wake_blocked_at: now,
            created_at: now,
            updated_at: now,
          },
        ];
      }
      if (query.includes("supervisor_registry_record_usage_delta")) {
        return [
          {
            role: "cluster",
            active_session_id: "sess-supervisor",
            epoch: "2",
            cursor_offset: "9",
            handover_state: "hard_pending",
            cumulative_tokens: "142",
            compaction_count: "2",
            last_seen_at: now,
            wake_dispatch_state: "active",
            wake_last_signature: null,
            wake_repeat_count: "0",
            wake_blocked_reason: null,
            wake_blocked_at: null,
            created_at: now,
            updated_at: now,
          },
        ];
      }
      if (query.includes("supervisor_registry_delete")) {
        return [{ supervisor_registry_delete: true }];
      }
      return [];
    });
    const db = new SessionDB(sql);

    await expect(db.getSupervisorConsumerCursor("cluster-supervisor")).resolves.toBe(7);
    await expect(db.setSupervisorConsumerCursor("cluster-supervisor", 9)).resolves.toBe(9);
    const registry = await db.upsertSupervisorRegistry({
      role: "cluster",
      activeSessionId: "sess-supervisor",
      epoch: 2,
      cursorOffset: 9,
      handoverState: "hard_pending",
      cumulativeTokens: 42,
      compactionCount: 1,
      lastSeenAt: now,
    });
    const blocked = await db.setSupervisorWakeDispatchState({
      role: "cluster",
      state: "blocked",
      lastSignature: "events|9->10|count=1|sources=sess-a|types=user_message",
      repeatCount: 3,
      blockedReason: "wake delivery failed before cursor advance",
      blockedAt: now,
    });
    const usage = await db.recordSupervisorUsageDelta({
      role: "cluster",
      tokenDelta: 100,
      compactionDelta: 1,
      lastSeenAt: now,
    });
    await expect(db.deleteSupervisorRegistry("cluster")).resolves.toBe(true);

    expect(registry).toMatchObject({
      role: "cluster",
      activeSessionId: "sess-supervisor",
      epoch: 2,
      cursorOffset: 9,
      handoverState: "hard_pending",
      cumulativeTokens: 42,
      compactionCount: 1,
      wakeDispatchState: "active",
      wakeRepeatCount: 0,
    });
    expect(blocked).toMatchObject({
      role: "cluster",
      wakeDispatchState: "blocked",
      wakeLastSignature: "events|9->10|count=1|sources=sess-a|types=user_message",
      wakeRepeatCount: 3,
      wakeBlockedReason: "wake delivery failed before cursor advance",
      wakeBlockedAt: now,
    });
    expect(usage).toMatchObject({
      cumulativeTokens: 142,
      compactionCount: 2,
    });
    expect(calls.map((c) => c.fragments.join("?"))).toEqual([
      expect.stringContaining("supervisor_consumer_cursor_get"),
      expect.stringContaining("supervisor_consumer_cursor_set"),
      expect.stringContaining("supervisor_registry_upsert"),
      expect.stringContaining("supervisor_registry_set_wake_dispatch_state"),
      expect.stringContaining("supervisor_registry_record_usage_delta"),
      expect.stringContaining("supervisor_registry_delete"),
    ]);
  });
});

describe("SessionDB Claude transcript mirror", () => {
  it("appendClaudeTranscriptEntries delegates JSON batch to stored proc", async () => {
    const { sql, calls } = createMockSql(() => [{ claude_transcript_append: 2 }]);
    const db = new SessionDB(sql);

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
    const db = new SessionDB(sql);

    const written = await db.appendClaudeTranscriptEntries(
      { projectKey: "project-a", sessionId: "claude-sess-1" },
      [],
    );

    expect(written).toBe(0);
    expect(calls).toHaveLength(0);
  });

  it("loadClaudeTranscriptEntries returns null when the store has no rows", async () => {
    const { sql, calls } = createMockSql(() => []);
    const db = new SessionDB(sql);

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
    const db = new SessionDB(sql);

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
    const db = new SessionDB(sql);

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

describe("SessionDB.getSession", () => {
  it("rows[0] 반환, 비어있으면 null", async () => {
    const { sql: emptySql } = createMockSql(() => []);
    expect(await new SessionDB(emptySql).getSession("x")).toBeNull();

    const row = { session_id: "x", status: "running" };
    const { sql: rowSql } = createMockSql(() => [row]);
    expect(await new SessionDB(rowSql).getSession("x")).toEqual(row);
  });
});

describe("SessionDB folder ops (B-5)", () => {
  it("assignSessionToFolder → session_assign_folder(sessionId, folderId)", async () => {
    const { sql, calls } = createMockSql();
    await new SessionDB(sql).assignSessionToFolder("sess-1", "folder-42");
    expect(calls).toHaveLength(1);
    expect(calls[0].values).toEqual(["sess-1", "folder-42"]);
    expect(calls[0].fragments.join("|")).toContain("session_assign_folder");
  });

  it("assignSessionToFolder(folderId=null) → stored proc에 NULL 전달 (폴더 해제)", async () => {
    const { sql, calls } = createMockSql();
    await new SessionDB(sql).assignSessionToFolder("sess-1", null);
    expect(calls[0].values).toEqual(["sess-1", null]);
  });

  it("getDefaultFolder(name) → folder_get_default 호출, 첫 행 반환 또는 null", async () => {
    const folderRow = { id: "default-claude", name: "⚙️ 클로드 코드 세션" };
    const { sql: foundSql } = createMockSql(() => [folderRow]);
    expect(await new SessionDB(foundSql).getDefaultFolder("⚙️ 클로드 코드 세션")).toEqual(folderRow);

    const { sql: emptySql } = createMockSql(() => []);
    expect(await new SessionDB(emptySql).getDefaultFolder("missing")).toBeNull();
  });

  it("getCatalog → catalog cache 우선 + legacy read-only fallback으로 boardItems를 합성", async () => {
    const createdAt = new Date("2026-06-03T00:00:00.000Z");
    const folderRows = [
      { id: "f1", name: "F1", sort_order: 1, settings: { excludeFromFeed: true }, parent_folder_id: null, created_at: createdAt },
      { id: "f2", name: "F2", sort_order: 2, settings: null, parent_folder_id: "f1" },
    ];
    const sessionRows = [
      { session_id: "s1", folder_id: "f1", display_name: "Hello" },
      { session_id: "s2", folder_id: null, display_name: null },
    ];
    const cachedBoardItems = [{
      id: "session:s1",
      folderId: "f1",
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
        return [{ folder_id: "f1", board_items: cachedBoardItems }];
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
    const db = new SessionDB(sql);
    const catalog = await db.getCatalog();
    const secondCatalog = await db.getCatalog();

    expect(catalog.folders).toEqual([
      {
        id: "f1",
        name: "F1",
        sortOrder: 1,
        settings: { excludeFromFeed: true },
        parentFolderId: null,
        createdAt: "2026-06-03T00:00:00.000Z",
      },
      { id: "f2", name: "F2", sortOrder: 2, settings: {}, parentFolderId: "f1" },  // null settings → 빈 객체로 정규화
    ]);
    expect(catalog.sessions).toEqual({
      s1: { folderId: "f1", displayName: "Hello" },
      s2: { folderId: null, displayName: null },
    });
    expect(catalog.boardItems).toEqual([
      {
        id: "session:s1",
        folderId: "f1",
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

describe("SessionDB MCP cogito 메서드 (본 카드 신규)", () => {
  it("renameSession → session_rename(sessionId, displayName | null)", async () => {
    const { sql, calls } = createMockSql();
    const db = new SessionDB(sql);
    await db.renameSession("sess-1", "새 이름");
    expect(calls).toHaveLength(1);
    expect(calls[0].values).toEqual(["sess-1", "새 이름"]);
    expect(calls[0].fragments.join("?")).toContain("session_rename");
  });

  it("renameSession(null) → 이름 제거", async () => {
    const { sql, calls } = createMockSql();
    const db = new SessionDB(sql);
    await db.renameSession("sess-1", null);
    expect(calls[0].values).toEqual(["sess-1", null]);
  });

  it("listSessionsSummary → 빈 결과 시 total=0", async () => {
    const { sql } = createMockSql(() => []);
    const result = await new SessionDB(sql).listSessionsSummary({
      limit: 10,
      offset: 0,
    });
    expect(result).toEqual({ sessions: [], total: 0 });
  });

  it("listSessionsSummary → 첫 행의 total_count를 total로 사용", async () => {
    const now = new Date("2026-05-18T00:00:00Z");
    const { sql, calls } = createMockSql(() => [
      {
        session_id: "s1",
        display_name: "Hi",
        status: "running",
        session_type: "claude",
        created_at: now,
        updated_at: now,
        event_count: "5",
        away_summary: null,
        caller_session_id: null,
        last_event_id: "9",
        last_read_event_id: "4",
        node_id: "node-1",
        total_count: "42",
      },
    ]);
    const result = await new SessionDB(sql).listSessionsSummary({
      search: "Hi",
      limit: 20,
      offset: 0,
      folderId: "claude",
      nodeId: "node-1",
    });
    expect(result.total).toBe(42);
    expect(result.sessions).toHaveLength(1);
    expect(result.sessions[0].event_count).toBe(5);
    expect(result.sessions[0].session_id).toBe("s1");
    expect(result.sessions[0].last_event_id).toBe(9);
    expect(result.sessions[0].last_read_event_id).toBe(4);
    expect(result.sessions[0].node_id).toBe("node-1");
    // 인자 순서: search, session_type(null), limit, offset, folderId, nodeId
    expect(calls[0].values).toEqual(["Hi", null, 20, 0, "claude", "node-1"]);
  });

  it("listRunningSessionsSummary → running 세션만 current session 제외 후 최신순으로 조회", async () => {
    const now = new Date("2026-06-07T05:00:00Z");
    const { sql, calls } = createMockSql(() => [
      {
        session_id: "running-2",
        display_name: "Running 2",
        node_id: "node-B",
        folder_id: "folder-B",
        folder_name: "Folder B",
        updated_at: now,
        total_count: "16",
      },
    ]);
    const result = await new SessionDB(sql).listRunningSessionsSummary({
      limit: 15,
      excludeSessionId: "current-session",
    });

    expect(result.total).toBe(16);
    expect(result.sessions).toEqual([
      {
        session_id: "running-2",
        display_name: "Running 2",
        node_id: "node-B",
        folder_id: "folder-B",
        folder_name: "Folder B",
        updated_at: now,
      },
    ]);
    const query = calls[0].fragments.join("?");
    expect(query).toContain("s.status = 'running'");
    expect(query).toContain("LEFT JOIN folders f ON f.id = s.folder_id");
    expect(query).toContain("s.session_id <>");
    expect(query).toContain("ORDER BY f.updated_at DESC, f.session_id DESC");
    expect(calls[0].values).toEqual(["current-session", "current-session", 15]);
  });

  it("getAllFolders → folder_get_all 행 그대로 + settings null 정규화", async () => {
    const { sql } = createMockSql(() => [
      { id: "f1", name: "F1", sort_order: 0, settings: { x: 1 }, parent_folder_id: null },
      { id: "f2", name: "F2", sort_order: 1, settings: null, parent_folder_id: "f1" },
    ]);
    const folders = await new SessionDB(sql).getAllFolders();
    expect(folders).toEqual([
      { id: "f1", name: "F1", sort_order: 0, settings: { x: 1 }, parent_folder_id: null },
      { id: "f2", name: "F2", sort_order: 1, settings: {}, parent_folder_id: "f1" },
    ]);
  });

  it("createFolder(parentFolderId) → folder_create 네 번째 인자로 부모 폴더 전달", async () => {
    const { sql, calls } = createMockSql();
    const db = new SessionDB(sql);

    await db.createFolder("child", "Child", 7, "parent");

    expect(calls).toHaveLength(1);
    expect(calls[0].fragments.join("?")).toContain("folder_create");
    expect(calls[0].values).toEqual(["child", "Child", 7, "parent"]);
  });

  it("updateFolder parent_folder_id=null → 루트 승격을 stored proc에 null로 전달", async () => {
    const { sql, calls } = createMockSql();
    const db = new SessionDB(sql);

    await db.updateFolder("child", ["parent_folder_id"], [null]);

    expect(calls).toHaveLength(1);
    expect(calls[0].values).toEqual(["child", ["parent_folder_id"], [null]]);
  });

  it("countEvents → event_count(sessionId) 반환 Number 변환", async () => {
    const { sql, calls } = createMockSql(() => [{ event_count: "123" }]);
    const n = await new SessionDB(sql).countEvents("sess-1");
    expect(n).toBe(123);
    expect(calls[0].values).toEqual(["sess-1"]);
  });

  it("countEvents → 빈 결과 시 0", async () => {
    const { sql } = createMockSql(() => []);
    expect(await new SessionDB(sql).countEvents("missing")).toBe(0);
  });

  it("readEvents → event_read(sessionId, afterId, limit, types)", async () => {
    const { sql, calls } = createMockSql(() => [
      {
        id: 1,
        session_id: "s1",
        event_type: "user_message",
        payload: { text: "hi" },
        searchable_text: "hi",
        created_at: new Date("2026-05-18T00:00:00Z"),
      },
    ]);
    const events = await new SessionDB(sql).readEvents("s1", 0, 50, [
      "user_message",
    ]);
    expect(calls[0].values).toEqual(["s1", 0, 50, ["user_message"]]);
    expect(events).toHaveLength(1);
    expect(events[0].payload).toEqual({ text: "hi" });
  });

  it("readEvents 빈 eventTypes → null로 변환", async () => {
    const { sql, calls } = createMockSql(() => []);
    await new SessionDB(sql).readEvents("s1", 0, 50, []);
    expect(calls[0].values).toEqual(["s1", 0, 50, null]);
  });

  it("readOneEvent → 부재 시 null", async () => {
    const { sql } = createMockSql(() => []);
    expect(await new SessionDB(sql).readOneEvent("s1", 99)).toBeNull();
  });

  it("readOneEvent → 존재 시 payload 정규화", async () => {
    const { sql, calls } = createMockSql(() => [
      {
        id: 5,
        session_id: "s1",
        event_type: "user_message",
        payload: { text: "x" },
        searchable_text: "x",
        created_at: new Date("2026-05-18T00:00:00Z"),
      },
    ]);
    const ev = await new SessionDB(sql).readOneEvent("s1", 5);
    expect(ev?.id).toBe(5);
    expect(ev?.payload).toEqual({ text: "x" });
    expect(calls[0].values).toEqual(["s1", 5]);
  });

  it("streamEventsRaw → 인자 (sessionId, afterId=0 default)", async () => {
    const { sql, calls } = createMockSql(() => [
      { id: 1, event_type: "user_message", payload_text: "{\"x\":1}" },
    ]);
    const rows = await new SessionDB(sql).streamEventsRaw("s1");
    expect(calls[0].values).toEqual(["s1", 0]);
    expect(rows).toHaveLength(1);
    expect(rows[0].payload_text).toBe('{"x":1}');
  });

  it("searchEvents → event_search(query, sessionIds, limit, eventTypes) + score Number 변환", async () => {
    const { sql, calls } = createMockSql(() => [
      {
        id: 1,
        session_id: "s1",
        event_type: "user_message",
        payload: { text: "hi" },
        searchable_text: "hi",
        created_at: new Date("2026-05-18T00:00:00Z"),
        score: "0.123",
      },
    ]);
    const results = await new SessionDB(sql).searchEvents("hi", ["s1"], 10, ["user_message"]);
    expect(calls[0].values).toEqual(["hi", ["s1"], 10, ["user_message"]]);
    expect(results).toHaveLength(1);
    expect(results[0].score).toBeCloseTo(0.123);
  });

  it("searchEvents — 빈 sessionIds → null로 변환", async () => {
    const { sql, calls } = createMockSql(() => []);
    await new SessionDB(sql).searchEvents("hi", [], 10);
    expect(calls[0].values).toEqual(["hi", null, 10, null]);
  });

  it("searchEventsBySessionId → session_id_search(query, eventTypes, limit)", async () => {
    const { sql, calls } = createMockSql(() => [
      {
        id: 2,
        session_id: "sess-hi",
        event_type: "user_message",
        payload: { text: "hi" },
        searchable_text: "hi",
        created_at: new Date("2026-05-18T00:00:00Z"),
        score: "0.5",
      },
    ]);
    const results = await new SessionDB(sql).searchEventsBySessionId(
      "sess",
      ["user_message"],
      5,
    );
    expect(calls[0].values).toEqual(["sess", ["user_message"], 5]);
    expect(results[0].score).toBeCloseTo(0.5);
  });
});

describe("SessionDB lifecycle", () => {
  let sql: SqlClient;
  let endSpy: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    const mock = createMockSql();
    sql = mock.sql;
    endSpy = (mock.sql as unknown as { end: ReturnType<typeof vi.fn> }).end;
  });

  it("외부 주입 sql은 close 시 end 호출 안 함", async () => {
    const db = new SessionDB(sql);
    await db.close();
    expect(endSpy).not.toHaveBeenCalled();
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
  it("serializes board_items writes and ignores every unique conflict", () => {
    const schema = readFileSync(
      new URL("../../../packages/db-schema/sql/schema.sql", import.meta.url),
      "utf8",
    );
    const migration = readFileSync(
      new URL("../../../packages/db-schema/sql/migrations/018_board_file_assets.sql", import.meta.url),
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

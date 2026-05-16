/**
 * SessionDB 단위 테스트 — mock sql tagged-template 함수로 호출 인자 검증.
 *
 * 통합 동작(stored proc 실행)은 별도 e2e 또는 testcontainers — 본 PR 범위 외.
 * 본 테스트는 *SessionDB의 책임* (인자 직렬화, 화이트리스트 가드, 반환 파싱)만 검증.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

import { SessionDB, type SqlClient } from "../../src/db/session_db.js";

interface MockCall {
  fragments: string[];
  values: unknown[];
}

/** postgres.js의 tagged template 함수를 흉내내는 mock. */
function createMockSql(resultFor?: (call: MockCall) => unknown[]) {
  const calls: MockCall[] = [];

  const fn = ((strings: TemplateStringsArray, ...values: unknown[]) => {
    const call: MockCall = { fragments: Array.from(strings), values };
    calls.push(call);
    const result = resultFor ? resultFor(call) : [];
    // postgres.js의 query는 Promise<row[]>를 반환
    return Promise.resolve(result);
  }) as unknown as SqlClient & {
    array: (a: unknown[]) => unknown[];
    end: () => Promise<void>;
  };

  fn.array = (a: unknown[]) => a;
  fn.end = vi.fn().mockResolvedValue(undefined);

  return { sql: fn as unknown as SqlClient, calls };
}

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
    const { sql } = createMockSql(() => [{ event_append: 7 }]);
    const db = new SessionDB(sql);
    const id = await db.appendEvent({
      sessionId: "sess-1",
      eventType: "text_delta",
      payload: '{"type":"text_delta"}',
      searchableText: "hi",
      createdAt: new Date(),
    });
    expect(id).toBe(7);
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

describe("SessionDB.getSession", () => {
  it("rows[0] 반환, 비어있으면 null", async () => {
    const { sql: emptySql } = createMockSql(() => []);
    expect(await new SessionDB(emptySql).getSession("x")).toBeNull();

    const row = { session_id: "x", status: "running" };
    const { sql: rowSql } = createMockSql(() => [row]);
    expect(await new SessionDB(rowSql).getSession("x")).toEqual(row);
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

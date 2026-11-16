import { expect, it, vi } from "vitest";
import { SessionDeletionRepository } from "../src/session/session_deletion_repository.js";
import type { LivePostgresSql } from "../src/runtime/live_db_sql.js";

it("calls session_delete in a transaction", async () => {
  const query = vi.fn(async (_strings: TemplateStringsArray, ..._args: unknown[]) => []);
  const sql = Object.assign(query, {
    array: (values: readonly unknown[]) => values, json: (value: unknown) => value,
    begin: async (callback: (tx: LivePostgresSql) => Promise<void>) => callback(sql as unknown as LivePostgresSql),
  }) as unknown as LivePostgresSql;
  await new SessionDeletionRepository({ resolveSql: async () => sql, close: async () => {} }).deleteSession({ sessionId: "session-a" });
  expect(query).toHaveBeenCalledTimes(2);
  expect(query.mock.calls[0]?.[0].join("?")).toMatch(/FROM cards[\s\S]*limit_resume_session_id/);
  expect(query.mock.calls[0]?.[1]).toBe("session-a");
  expect(query.mock.calls[1]?.[0].join("?")).toContain("SELECT session_delete(");
  expect(query.mock.calls[1]?.[1]).toBe("session-a");
});

it("calls onCardsUpdated only after the transaction commits, once per released card", async () => {
  const order: string[] = [];
  const sql = fakeSql((text) => {
    if (text.includes("FROM cards")) {
      return [
        { id: "card-a", folder_id: "folder-a" },
        { id: "card-b", folder_id: "folder-b" },
      ];
    }
    if (text.includes("INSERT INTO folder_operations")) return [{}];
    return [];
  }, order);
  const onCardsUpdated = vi.fn((update: { cardId: string; folderId: string }) => {
    order.push(`callback:${update.cardId}:${update.folderId}`);
  });
  await new SessionDeletionRepository(
    { resolveSql: async () => sql, close: async () => {} },
    { onCardsUpdated },
  ).deleteSession({ sessionId: "session-a" });

  expect(onCardsUpdated.mock.calls).toEqual([
    [{ cardId: "card-a", folderId: "folder-a" }],
    [{ cardId: "card-b", folderId: "folder-b" }],
  ]);
  expect(order).toEqual([
    "begin",
    "commit",
    "callback:card-a:folder-a",
    "callback:card-b:folder-b",
  ]);
});

it("does not call onCardsUpdated when no card reserved the deleted session", async () => {
  const sql = fakeSql(() => []);
  const onCardsUpdated = vi.fn();
  await new SessionDeletionRepository(
    { resolveSql: async () => sql, close: async () => {} },
    { onCardsUpdated },
  ).deleteSession({ sessionId: "session-a" });
  expect(onCardsUpdated).not.toHaveBeenCalled();
});

/**
 * `sql(writes)` 조각 호출은 문자열 배열이 아니므로 문장 판별에서 비운다.
 * 커밋 순서를 재기 위해 begin/commit을 기록한다.
 */
function fakeSql(
  execute: (text: string) => readonly Record<string, unknown>[],
  order: string[] = [],
): LivePostgresSql {
  const query = vi.fn(async (strings: TemplateStringsArray | Record<string, unknown>, ..._args: unknown[]) => {
    const text = Array.isArray(strings) ? strings.join("?") : "";
    return execute(text);
  });
  return Object.assign(query, {
    array: (values: readonly unknown[]) => values,
    json: (value: unknown) => value,
    begin: async (callback: (tx: LivePostgresSql) => Promise<void>) => {
      order.push("begin");
      const result = await callback(query as unknown as LivePostgresSql);
      order.push("commit");
      return result;
    },
  }) as unknown as LivePostgresSql;
}

import { expect, it, vi } from "vitest";
import { SessionDeletionRepository } from "../src/session/session_deletion_repository.js";
import type { LivePostgresSql } from "../src/runtime/live_db_sql.js";

it("calls session_delete in a transaction", async () => {
  const query = vi.fn(async (..._args: unknown[]) => []);
  const sql = Object.assign(query, {
    array: (values: readonly unknown[]) => values, json: (value: unknown) => value,
    begin: async (callback: (tx: LivePostgresSql) => Promise<void>) => callback(sql as unknown as LivePostgresSql),
  }) as unknown as LivePostgresSql;
  await new SessionDeletionRepository({ resolveSql: async () => sql, close: async () => {} }).deleteSession({ sessionId: "session-a" });
  expect(query).toHaveBeenCalledOnce();
  expect(query.mock.calls[0]?.[1]).toBe("session-a");
});

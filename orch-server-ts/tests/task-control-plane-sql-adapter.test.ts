import { describe, expect, it } from "vitest";

import { createBoardYjsSqlAdapter } from "../src/board-yjs/board_yjs_sql.js";
import { createPostgresQueryAdapter } from "../src/runtime/postgres_query_adapter.js";
import type { LivePostgresSql } from "../src/runtime/live_db_sql.js";
import { TaskRepository } from "../src/tasks/control_plane/task_repository.js";

type SqlCall = {
  query: string;
  values: unknown[];
};

function createSqlHarness() {
  const calls: SqlCall[] = [];
  const helpers: Array<{ first: Record<string, unknown>; columns: unknown[] }> = [];
  const rawSql = Object.assign(
    (first: TemplateStringsArray | Record<string, unknown>, ...values: unknown[]) => {
      if (Array.isArray(first) && Object.prototype.hasOwnProperty.call(first, "raw")) {
        const query = Array.from(first).join("?");
        calls.push({ query, values });
        if (query.includes("SELECT version")) return Promise.resolve([{ version: 7 }]);
        return Promise.resolve([{ id: "updated", version: 8 }]);
      }
      const helper = {
        first: first as Record<string, unknown>,
        columns: values,
      };
      helpers.push(helper);
      return helper;
    },
    {
      array: (values: readonly unknown[]) => values,
      json: (value: unknown) => value,
      begin: async <T>(callback: (sql: LivePostgresSql) => Promise<T>) =>
        await callback(rawSql as unknown as LivePostgresSql),
    },
  ) as unknown as LivePostgresSql;
  return { calls, helpers, rawSql };
}

function expectSynchronousHelper(
  calls: SqlCall[],
  helpers: Array<{ first: Record<string, unknown>; columns: unknown[] }>,
  updateTable: string,
  expectedPatch: Record<string, unknown>,
): void {
  const update = calls.find((call) => call.query.includes(`UPDATE ${updateTable}`));
  expect(update).toBeDefined();
  expect(helpers).toEqual([{ first: expectedPatch, columns: [] }]);
  expect(update?.values[0]).toBe(helpers[0]);
  expect(update?.values[0]).not.toBeInstanceOf(Promise);
}

describe("task control-plane postgres.js adapter", () => {
  it("returns object helpers synchronously instead of wrapping them in Promise", () => {
    const { rawSql } = createSqlHarness();
    const sql = createBoardYjsSqlAdapter(rawSql);

    const helper = sql({ title: "renamed" });

    expect(helper).toEqual({ first: { title: "renamed" }, columns: [] });
    expect(helper).not.toBeInstanceOf(Promise);
  });

  it("hands back the driver's own query object so it can still be a fragment", async () => {
    // postgres.js returns a `Query`: awaitable, and interpolatable into another
    // query as a fragment. The adapter used to run every template through
    // `Promise.resolve`, which adopted the thenable — firing the fragment off as
    // its own statement — and returned a plain promise the driver no longer
    // recognised, so the parent bound it as a parameter and emitted `SET $1`.
    // Every `deliveryRetryOrDeadLetterSet` caller broke that way on 260820.
    let thenCalls = 0;
    const driverResult = {
      marker: "driver-query",
      then(onFulfilled?: (value: unknown) => unknown) {
        thenCalls += 1;
        return Promise.resolve([{ id: "row" }]).then(onFulfilled);
      },
    };
    const rawSql = Object.assign(
      (first: TemplateStringsArray | Record<string, unknown>) => (
        Array.isArray(first) && Object.prototype.hasOwnProperty.call(first, "raw")
          ? driverResult
          : { first }
      ),
      { array: (values: readonly unknown[]) => values, json: (value: unknown) => value },
    ) as unknown as LivePostgresSql;

    const sql = createPostgresQueryAdapter(
      rawSql as unknown as Parameters<typeof createPostgresQueryAdapter>[0],
    );
    const fragment = sql`COALESCE(last_error, ${"lease expired"})`;

    expect(fragment).toBe(driverResult);
    expect(thenCalls).toBe(0);

    // Still awaitable once the caller actually wants rows.
    await expect(fragment).resolves.toEqual([{ id: "row" }]);
    expect(thenCalls).toBe(1);
  });

  it("still normalises a test double's synchronous rows into a promise", async () => {
    const rows = [{ id: "sync" }];
    const rawSql = Object.assign(
      () => rows,
      { array: (values: readonly unknown[]) => values, json: (value: unknown) => value },
    ) as unknown as LivePostgresSql;

    const sql = createPostgresQueryAdapter(
      rawSql as unknown as Parameters<typeof createPostgresQueryAdapter>[0],
    );
    const result = sql`SELECT 1`;

    expect(result).toBeInstanceOf(Promise);
    await expect(result).resolves.toBe(rows);
  });

  it("executes patchTaskTx with a synchronous SET helper", async () => {
    const { calls, helpers, rawSql } = createSqlHarness();
    const sql = createBoardYjsSqlAdapter(rawSql);
    const repository = new TaskRepository(sql);

    await sql.begin((transaction) =>
      repository.patchTaskTx(transaction, "task-1", { title: "renamed" }, 7)
    );

    expectSynchronousHelper(calls, helpers, "tasks", { title: "renamed" });
  });

  it("executes patchSectionTx with a synchronous SET helper", async () => {
    const { calls, helpers, rawSql } = createSqlHarness();
    const sql = createBoardYjsSqlAdapter(rawSql);
    const repository = new TaskRepository(sql);

    await sql.begin((transaction) =>
      repository.patchSectionTx(
        transaction,
        "section-1",
        { title: "renamed" },
        7,
        "session-1",
        9,
      )
    );

    expectSynchronousHelper(calls, helpers, "task_sections", { title: "renamed" });
  });

  it("executes patchItemTx with a synchronous SET helper", async () => {
    const { calls, helpers, rawSql } = createSqlHarness();
    const sql = createBoardYjsSqlAdapter(rawSql);
    const repository = new TaskRepository(sql);

    await sql.begin((transaction) =>
      repository.patchItemTx(
        transaction,
        "item-1",
        { how_to: "new steps" },
        7,
        "session-1",
        9,
      )
    );

    expectSynchronousHelper(calls, helpers, "task_items", { how_to: "new steps" });
  });
});

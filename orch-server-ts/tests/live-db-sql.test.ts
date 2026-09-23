import { describe, expect, it, vi } from "vitest";

import {
  cancelLiveSearchQuerySafely,
  createLiveDbSqlResolver,
  createLiveSearchDbConnectionFactory,
  SEARCH_DB_STATEMENT_TIMEOUT_MS,
  type LivePostgresSql,
  type LiveSearchSql,
} from "../src/index.js";
import { createLiveDbCatalogRepository } from "../src/runtime/live_db_catalog_repository.js";

describe("live Postgres SQL resolver", () => {
  it("captures the pinned postgres.js query canceller rejection", async () => {
    const cancellationError = new Error("CancelRequest socket failed");
    let report!: (error: unknown) => void;
    const reported = new Promise<unknown>((resolve) => { report = resolve; });
    const canceller = vi.fn(async () => { throw cancellationError; });
    const query = Object.assign(Promise.resolve([]), {
      cancel: vi.fn(),
      canceller,
    }) as unknown as Parameters<typeof cancelLiveSearchQuerySafely>[0];

    expect(cancelLiveSearchQuerySafely(query, report)).toBe(true);
    await expect(reported).resolves.toBe(cancellationError);
    expect(canceller).toHaveBeenCalledWith(query);
    expect(query.canceller).toBeUndefined();
  });

  it("uses a transaction-local statement timeout only for search access folder reads", async () => {
    const calls: Array<{ text: string; values: unknown[] }> = [];
    const transaction = ((strings: TemplateStringsArray, ...values: unknown[]) => {
      const text = strings.join("?");
      calls.push({ text, values });
      return Promise.resolve(text.includes("FROM folders")
        ? [{ id: "folder-a", parent_folder_id: null, settings: null }]
        : []);
    }) as unknown as LivePostgresSql;
    const begin = vi.fn(async (callback: (sql: LivePostgresSql) => unknown) =>
      await callback(transaction));
    const sql = Object.assign(transaction, { begin }) as unknown as LivePostgresSql;
    const repository = createLiveDbCatalogRepository({ sql });

    await expect(repository.sessionResourceAccessRepository.listFoldersForSearchAccess?.(500))
      .resolves.toEqual([{ id: "folder-a", parentFolderId: null, settings: null }]);

    expect(begin).toHaveBeenCalledOnce();
    expect(calls).toEqual([
      { text: "SELECT set_config(\n            'statement_timeout', ?, true\n          )", values: ["500ms"] },
      { text: "SELECT id, parent_folder_id, settings FROM folders", values: [] },
    ]);
  });

  it("matches the production pool ceiling and 30 second command timeout meaning", async () => {
    const end = vi.fn(async () => undefined);
    const sql = Object.assign(
      () => Promise.resolve([]),
      { end },
    ) as unknown as LivePostgresSql;
    const postgresFactory = vi.fn(() => sql);
    const resolver = createLiveDbSqlResolver({
      databaseUrl: "postgres://orch@localhost/orch",
      postgresFactory,
    });

    await expect(resolver.resolveSql()).resolves.toBe(sql);
    await expect(resolver.resolveSql()).resolves.toBe(sql);

    expect(postgresFactory).toHaveBeenCalledTimes(1);
    expect(postgresFactory).toHaveBeenCalledWith(
      "postgres://orch@localhost/orch",
      {
        max: 10,
        connection: { statement_timeout: 30_000 },
      },
    );

    await resolver.close();
    expect(end).toHaveBeenCalledWith({ timeout: 5 });
  });

  it("opens one non-pipelined, request-owned search connection at a time", async () => {
    const endFirst = vi.fn(async () => undefined);
    const endSecond = vi.fn(async () => undefined);
    const firstCalls: Array<{ text: string; values: unknown[] }> = [];
    const makeSql = (
      end: typeof endFirst,
      calls: Array<{ text: string; values: unknown[] }>,
    ) => Object.assign(
      ((strings: TemplateStringsArray, ...values: unknown[]) => {
        calls.push({ text: strings.join("?"), values });
        return Object.assign(Promise.resolve([]), { cancel: vi.fn() });
      }),
      { end },
    ) as unknown as LiveSearchSql;
    const first = makeSql(endFirst, firstCalls);
    const second = makeSql(endSecond, []);
    const postgresFactory = vi.fn()
      .mockReturnValueOnce(first)
      .mockReturnValueOnce(second);
    const factory = createLiveSearchDbConnectionFactory({
      databaseUrl: "postgres://orch@localhost/orch_test",
      postgresFactory,
    });

    const one = await factory.open(5_000);
    const two = await factory.open(2_500);

    expect(one.sql).not.toBe(two.sql);
    expect(postgresFactory).toHaveBeenNthCalledWith(1,
      "postgres://orch@localhost/orch_test",
      {
        max: 1,
        pipeline: false,
        connect_timeout: 1,
        connection: { statement_timeout: SEARCH_DB_STATEMENT_TIMEOUT_MS },
      },
    );
    expect(postgresFactory).toHaveBeenNthCalledWith(2,
      "postgres://orch@localhost/orch_test",
      {
        max: 1,
        pipeline: false,
        connect_timeout: 1,
        connection: { statement_timeout: 1_500 },
      },
    );

    await one.sql.setStatementTimeout?.(240);
    expect(firstCalls).toEqual([{
      text: "SELECT set_config('statement_timeout', ?, false)",
      values: ["240ms"],
    }]);

    await one.close();
    await two.close();
    expect(endFirst).toHaveBeenCalledWith({ timeout: 1 });
    expect(endSecond).toHaveBeenCalledWith({ timeout: 1 });
  });

  it("uses immediate teardown when the request connection is discarded", async () => {
    const end = vi.fn(async () => undefined);
    const sql = Object.assign(
      (() => Object.assign(Promise.resolve([]), { cancel: vi.fn() })),
      { end },
    ) as unknown as LiveSearchSql;
    const factory = createLiveSearchDbConnectionFactory({
      databaseUrl: "postgres://orch@localhost/orch_test",
      postgresFactory: () => sql,
    });
    const connection = await factory.open(5_000);

    await connection.discard?.();
    await connection.close();

    expect(end).toHaveBeenCalledOnce();
    expect(end).toHaveBeenCalledWith({ timeout: 0 });
  });
});

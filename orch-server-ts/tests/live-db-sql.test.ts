import { describe, expect, it, vi } from "vitest";

import {
  cancelLiveSearchQuerySafely,
  createLiveDbSqlResolver,
  createLiveSearchDbConnectionFactory,
  SEARCH_DB_STATEMENT_TIMEOUT_MS,
  withLiveSearchDbConnection,
  type LiveSearchDbConnectionFactory,
  type LiveSearchPendingQuery,
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

  it("does not dispatch another source or reject an idle abort race between queries", async () => {
    const controller = new AbortController();
    const query = Object.assign(Promise.resolve([{ value: 1 }]), {
      cancel: vi.fn(),
      canceller: null,
    }) as unknown as LiveSearchPendingQuery<readonly Record<string, unknown>[]>;
    const createQuery = vi.fn(() => query);
    const close = vi.fn(async () => undefined);
    const discard = vi.fn(async () => undefined);
    const factory = {
      open: vi.fn(async () => ({
        sql: (() => query) as unknown as LiveSearchSql,
        close,
        discard,
      })),
    } as LiveSearchDbConnectionFactory;

    await expect(withLiveSearchDbConnection(
      factory,
      controller.signal,
      vi.fn(),
      async (runQuery) => {
        await runQuery(createQuery);
        controller.abort(new Error("request cancelled between search sources"));
        await runQuery(createQuery);
      },
    )).rejects.toThrow("request cancelled between search sources");

    expect(createQuery).toHaveBeenCalledOnce();
    expect(factory.open).toHaveBeenCalledOnce();
    expect(discard).toHaveBeenCalledOnce();
    expect(close).not.toHaveBeenCalled();
  });

  it("reduces each source statement timeout to the remaining request deadline", async () => {
    let now = 1_000;
    const dateNow = vi.spyOn(Date, "now").mockImplementation(() => now);
    const pendingQuery = Object.assign(Promise.resolve([{ value: 1 }]), {
      cancel: vi.fn(),
      canceller: null,
    });
    const setStatementTimeout = vi.fn(async () => undefined);
    const sql = Object.assign(vi.fn(() => pendingQuery), { setStatementTimeout }) as unknown as LiveSearchSql;
    const close = vi.fn(async () => undefined);
    const factory: LiveSearchDbConnectionFactory = {
      open: vi.fn(async () => ({ sql, close })),
    };

    try {
      await withLiveSearchDbConnection(factory, undefined, vi.fn(), async (runQuery) => {
        await runQuery(() => sql``);
        now = 3_250;
        await runQuery(() => sql``);
      });

      expect(setStatementTimeout.mock.calls).toEqual([[3_000], [1_750]]);
      expect(factory.open).toHaveBeenCalledOnce();
      expect(close).toHaveBeenCalledOnce();
    } finally {
      dateNow.mockRestore();
    }
  });

  it("does not dispatch a source when cancellation interrupts statement-timeout setup", async () => {
    const controller = new AbortController();
    const query = vi.fn(() => Object.assign(Promise.resolve([]), { cancel: vi.fn() }));
    const close = vi.fn(async () => undefined);
    const discard = vi.fn(async () => undefined);
    const sql = Object.assign(query, {
      setStatementTimeout: vi.fn(() => {
        controller.abort(new Error("host request expired"));
        return new Promise<void>(() => undefined);
      }),
    }) as unknown as LiveSearchSql;
    const factory: LiveSearchDbConnectionFactory = {
      open: vi.fn(async () => ({ sql, close, discard })),
    };

    await expect(withLiveSearchDbConnection(
      factory,
      controller.signal,
      vi.fn(),
      (runQuery) => runQuery(() => sql``),
    )).rejects.toThrow("host request expired");

    expect(query).not.toHaveBeenCalled();
    expect(discard).toHaveBeenCalledOnce();
    expect(close).not.toHaveBeenCalled();
  });

  it("discards a connection that finishes opening after request cancellation", async () => {
    const controller = new AbortController();
    type OpenConnection = Awaited<ReturnType<LiveSearchDbConnectionFactory["open"]>>;
    let resolveOpen!: (value: OpenConnection) => void;
    const opening = new Promise<OpenConnection>((resolve) => { resolveOpen = resolve; });
    const close = vi.fn(async () => undefined);
    const discard = vi.fn(async () => undefined);
    const factory: LiveSearchDbConnectionFactory = {
      open: vi.fn(() => opening),
    };
    const search = withLiveSearchDbConnection(
      factory,
      controller.signal,
      vi.fn(),
      async () => "unreachable",
    );

    controller.abort(new Error("caller disconnected during database startup"));
    await expect(search).rejects.toThrow("caller disconnected during database startup");
    resolveOpen({
      sql: (() => Object.assign(Promise.resolve([]), { cancel: vi.fn() })) as unknown as LiveSearchSql,
      close,
      discard,
    });
    await opening;
    await Promise.resolve();

    expect(discard).toHaveBeenCalledOnce();
    expect(close).not.toHaveBeenCalled();
  });
});

import type {
  LiveDbSqlResolver,
  LivePostgresSql,
} from "../runtime/live_db_sql.js";

export type BoardYjsQuerySql = {
  <T extends readonly Record<string, unknown>[] = readonly Record<string, unknown>[]>(
    strings: TemplateStringsArray,
    ...values: unknown[]
  ): Promise<T>;
  readonly json: (value: unknown) => unknown;
  readonly array: (values: readonly unknown[]) => unknown;
};

export type BoardYjsSql = BoardYjsQuerySql & {
  readonly begin: <T>(callback: (sql: BoardYjsQuerySql) => Promise<T>) => Promise<T>;
};

type BoardYjsCapableLivePostgresSql = LivePostgresSql & {
  readonly array: (values: readonly unknown[]) => unknown;
};

type TransactionCapableLivePostgresSql = BoardYjsCapableLivePostgresSql & {
  readonly begin: <T>(
    callback: (sql: BoardYjsCapableLivePostgresSql) => Promise<T>,
  ) => Promise<T>;
};

export class BoardYjsSqlResolver {
  private resolved?: Promise<BoardYjsSql>;

  constructor(private readonly resolver: LiveDbSqlResolver) {}

  resolveSql(): Promise<BoardYjsSql> {
    this.resolved ??= this.resolver.resolveSql().then(createBoardYjsSqlAdapter);
    return this.resolved;
  }
}

export function createBoardYjsSqlAdapter(sql: LivePostgresSql): BoardYjsSql {
  assertTransactionSql(sql);
  const query = createBoardYjsQueryAdapter(sql);
  return Object.assign(query, {
    begin: <T>(callback: (transaction: BoardYjsQuerySql) => Promise<T>) =>
      sql.begin((transactionSql) => callback(createBoardYjsQueryAdapter(transactionSql))),
  }) as BoardYjsSql;
}

function createBoardYjsQueryAdapter(sql: LivePostgresSql): BoardYjsQuerySql {
  assertBoardYjsQuerySql(sql);
  const query = async <T extends readonly Record<string, unknown>[]>(
    strings: TemplateStringsArray,
    ...values: unknown[]
  ): Promise<T> => await sql(strings, ...values) as T;
  return Object.assign(query, {
    json: (value: unknown) => sql.json(value),
    array: (values: readonly unknown[]) => sql.array(values),
  }) as BoardYjsQuerySql;
}

function assertTransactionSql(
  sql: LivePostgresSql,
): asserts sql is TransactionCapableLivePostgresSql {
  assertBoardYjsQuerySql(sql);
  const candidate = sql as Partial<TransactionCapableLivePostgresSql>;
  if (typeof candidate.begin !== "function") {
    throw new Error("board Yjs SQL requires postgres.js begin()");
  }
}

function assertBoardYjsQuerySql(
  sql: LivePostgresSql,
): asserts sql is BoardYjsCapableLivePostgresSql {
  const candidate = sql as Partial<BoardYjsCapableLivePostgresSql>;
  if (typeof candidate.array !== "function") {
    throw new Error("board Yjs SQL requires postgres.js array()");
  }
}

import type {
  LiveDbSqlResolver,
  LivePostgresSql,
} from "../runtime/live_db_sql.js";
import {
  createPostgresQueryAdapter,
  type PostgresQuerySql,
} from "../runtime/postgres_query_adapter.js";

export type BoardYjsQuerySql = PostgresQuerySql;

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
  });
}

function createBoardYjsQueryAdapter(sql: LivePostgresSql): BoardYjsQuerySql {
  assertBoardYjsQuerySql(sql);
  return createPostgresQueryAdapter(sql);
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

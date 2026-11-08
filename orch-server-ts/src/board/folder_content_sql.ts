import type {
  LiveDbSqlResolver,
  LivePostgresSql,
} from "../runtime/live_db_sql.js";
import {
  createPostgresQueryAdapter,
  type PostgresQuerySql,
} from "../runtime/postgres_query_adapter.js";

export type FolderContentQuerySql = PostgresQuerySql;

export type FolderContentSql = FolderContentQuerySql & {
  readonly begin: <T>(callback: (sql: FolderContentQuerySql) => Promise<T>) => Promise<T>;
};

type FolderContentCapableLivePostgresSql = LivePostgresSql & {
  readonly array: (values: readonly unknown[]) => unknown;
};

type TransactionCapableLivePostgresSql = FolderContentCapableLivePostgresSql & {
  readonly begin: <T>(
    callback: (sql: FolderContentCapableLivePostgresSql) => Promise<T>,
  ) => Promise<T>;
};

export class FolderContentSqlResolver {
  private resolved?: Promise<FolderContentSql>;

  constructor(private readonly resolver: LiveDbSqlResolver) {}

  resolveSql(): Promise<FolderContentSql> {
    this.resolved ??= this.resolver.resolveSql().then(createFolderContentSqlAdapter);
    return this.resolved;
  }
}

export function createFolderContentSqlAdapter(sql: LivePostgresSql): FolderContentSql {
  assertTransactionSql(sql);
  const query = createFolderContentQueryAdapter(sql);
  return Object.assign(query, {
    begin: <T>(callback: (transaction: FolderContentQuerySql) => Promise<T>) =>
      sql.begin((transactionSql) => callback(createFolderContentQueryAdapter(transactionSql))),
  });
}

function createFolderContentQueryAdapter(sql: LivePostgresSql): FolderContentQuerySql {
  assertFolderContentQuerySql(sql);
  return createPostgresQueryAdapter(sql);
}

function assertTransactionSql(
  sql: LivePostgresSql,
): asserts sql is TransactionCapableLivePostgresSql {
  assertFolderContentQuerySql(sql);
  const candidate = sql as Partial<TransactionCapableLivePostgresSql>;
  if (typeof candidate.begin !== "function") {
    throw new Error("folder content SQL requires postgres.js begin()");
  }
}

function assertFolderContentQuerySql(
  sql: LivePostgresSql,
): asserts sql is FolderContentCapableLivePostgresSql {
  const candidate = sql as Partial<FolderContentCapableLivePostgresSql>;
  if (typeof candidate.array !== "function") {
    throw new Error("folder content SQL requires postgres.js array()");
  }
}

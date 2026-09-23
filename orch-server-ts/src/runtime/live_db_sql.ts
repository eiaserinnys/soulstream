import postgres from "postgres";

import type { LiveConfigProviderBoundary } from "./live_provider_dependencies.js";

export type LivePostgresSql = {
  <T extends readonly Record<string, unknown>[] = readonly Record<string, unknown>[]>(
    strings: TemplateStringsArray,
    ...values: unknown[]
  ): T | Promise<T>;
  <T extends Record<string, unknown>>(
    value: T,
    ...columns: Array<Extract<keyof T, string>>
  ): unknown;
  readonly json: (value: unknown) => unknown;
  readonly listen?: (
    channel: string,
    onnotify: (value: string) => void,
    onlisten?: () => void,
  ) => Promise<{ readonly unlisten: () => Promise<void> }>;
  readonly end?: (options?: { readonly timeout?: number }) => Promise<void>;
  readonly begin?: <T>(
    callback: (transaction: LivePostgresSql) => Promise<T>,
  ) => Promise<T>;
};

export type LivePostgresFactory = (
  databaseUrl: string,
  options: LivePostgresOptions,
) => LivePostgresSql;

export type LivePostgresOptions = {
  readonly max: number;
  readonly pipeline?: boolean;
  readonly connect_timeout?: number;
  readonly connection: {
    readonly statement_timeout: number;
  };
};

export type LiveSearchPendingQuery<T extends readonly Record<string, unknown>[]> =
  Promise<T> & {
    readonly cancel: () => void;
    // postgres.js 3.4.9 exposes cancel() as void even though its internal
    // canceller returns a Promise that may reject on CancelRequest failure.
    canceller?: ((query: LiveSearchPendingQuery<T>) => Promise<void> | void) | null;
  };

export type LiveSearchSql = {
  <T extends readonly Record<string, unknown>[] = readonly Record<string, unknown>[]>(
    strings: TemplateStringsArray,
    ...values: unknown[]
  ): LiveSearchPendingQuery<T>;
  readonly setStatementTimeout?: (timeoutMs: number) => Promise<void>;
  readonly end?: (options?: { readonly timeout?: number }) => Promise<void>;
};

export type LiveSearchDbConnection = {
  readonly sql: LiveSearchSql;
  readonly close: () => Promise<void>;
  readonly discard?: () => Promise<void>;
};

export type LiveSearchDbConnectionFactory = {
  readonly open: (remainingBudgetMs: number) => Promise<LiveSearchDbConnection>;
};

export type LiveSearchPostgresFactory = (
  databaseUrl: string,
  options: LivePostgresOptions & { readonly pipeline: false },
) => LiveSearchSql;

export type LiveDbSqlResolver = {
  readonly resolveSql: () => Promise<LivePostgresSql>;
  readonly close: () => Promise<void>;
};

export type CreateLiveDbSqlResolverOptions = {
  readonly sql?: LivePostgresSql;
  readonly postgresFactory?: LivePostgresFactory;
  readonly databaseUrl?: string;
  readonly configProvider?: LiveConfigProviderBoundary;
  readonly maxConnections?: number;
  readonly statementTimeoutMs?: number;
  readonly closeTimeoutSeconds?: number;
};

// postgres.js creates a separate max: 1 client for sql.listen(), so this keeps
// ten request-query connections available while LISTEN raises the total ceiling to eleven.
const DEFAULT_POSTGRES_MAX_CONNECTIONS = 10;
// postgres.js has no asyncpg-style command_timeout; PostgreSQL statement_timeout
// is the explicit server-side equivalent for executable commands.
const DEFAULT_POSTGRES_STATEMENT_TIMEOUT_MS = 30_000;
const DEFAULT_POSTGRES_CLOSE_TIMEOUT_SECONDS = 5;
export const SEARCH_DB_STATEMENT_TIMEOUT_MS = 3_000;
const SEARCH_DB_CLOSE_TIMEOUT_SECONDS = 1;

export function cancelLiveSearchQuerySafely<T extends readonly Record<string, unknown>[]>(
  query: LiveSearchPendingQuery<T>,
  onError: (error: unknown) => void,
): boolean {
  const canceller = query.canceller;
  if (canceller == null) return false;
  query.canceller = undefined;
  try {
    const result = canceller(query);
    if (result !== undefined) void result.catch(onError);
    return true;
  } catch (error) {
    onError(error);
    return false;
  }
}

export function createLiveDbSqlResolver(
  options: CreateLiveDbSqlResolverOptions,
): LiveDbSqlResolver {
  let sql = options.sql;
  let ownsSql = false;
  const maxConnections =
    options.maxConnections ?? DEFAULT_POSTGRES_MAX_CONNECTIONS;
  const statementTimeoutMs =
    options.statementTimeoutMs ?? DEFAULT_POSTGRES_STATEMENT_TIMEOUT_MS;
  const closeTimeoutSeconds =
    options.closeTimeoutSeconds ?? DEFAULT_POSTGRES_CLOSE_TIMEOUT_SECONDS;

  return {
    async resolveSql() {
      if (sql !== undefined) return sql;
      const databaseUrl =
        options.databaseUrl ?? await requireLiveDatabaseUrl(options.configProvider);
      const factory = options.postgresFactory ?? defaultLivePostgresFactory;
      sql = factory(databaseUrl, {
        max: maxConnections,
        connection: { statement_timeout: statementTimeoutMs },
      });
      ownsSql = true;
      return sql;
    },
    async close() {
      if (!ownsSql) return;
      await sql?.end?.({ timeout: closeTimeoutSeconds });
      sql = undefined;
      ownsSql = false;
    },
  };
}

export function createLiveSearchDbConnectionFactory(
  options: {
    readonly databaseUrl?: string;
    readonly configProvider?: LiveConfigProviderBoundary;
    readonly postgresFactory?: LiveSearchPostgresFactory;
    readonly statementTimeoutMs?: number;
  },
): LiveSearchDbConnectionFactory {
  const maxStatementTimeoutMs =
    options.statementTimeoutMs ?? SEARCH_DB_STATEMENT_TIMEOUT_MS;
  return {
    async open(remainingBudgetMs) {
      const databaseUrl = options.databaseUrl ??
        await requireLiveDatabaseUrl(options.configProvider);
      const factory = options.postgresFactory ?? defaultLiveSearchPostgresFactory;
      const connectTimeoutSeconds = 1;
      const statementTimeoutMs = Math.min(
        maxStatementTimeoutMs,
        Math.max(1, Math.floor(remainingBudgetMs - connectTimeoutSeconds * 1_000)),
      );
      const sql = factory(databaseUrl, {
        max: 1,
        pipeline: false,
        connect_timeout: connectTimeoutSeconds,
        connection: { statement_timeout: statementTimeoutMs },
      });
      let closePromise: Promise<void> | undefined;
      const close = (timeoutSeconds: number) => {
        closePromise ??= sql.end?.({ timeout: timeoutSeconds }) ?? Promise.resolve();
        return closePromise;
      };
      const searchSql = Object.assign(sql, {
        setStatementTimeout: async (timeoutMs: number) => {
          await sql`SELECT set_config('statement_timeout', ${`${timeoutMs}ms`}, false)`;
        },
      });
      return {
        sql: searchSql,
        close: () => close(SEARCH_DB_CLOSE_TIMEOUT_SECONDS),
        discard: () => close(0),
      };
    },
  };
}

export async function requireLiveDatabaseUrl(
  configProvider: LiveConfigProviderBoundary | undefined,
): Promise<string> {
  if (configProvider === undefined) {
    throw new Error("databaseUrl is required");
  }
  let value: unknown;
  try {
    value = await configProvider.requireConfig("databaseUrl");
  } catch {
    throw new Error("databaseUrl is required");
  }
  if (typeof value !== "string") throw new Error("databaseUrl must be a string");
  if (value.length === 0) throw new Error("databaseUrl must be configured");
  return value;
}

function defaultLivePostgresFactory(
  databaseUrl: string,
  options: LivePostgresOptions,
): LivePostgresSql {
  return postgres(databaseUrl, options) as unknown as LivePostgresSql;
}

function defaultLiveSearchPostgresFactory(
  databaseUrl: string,
  options: LivePostgresOptions & { readonly pipeline: false },
): LiveSearchSql {
  return postgres(databaseUrl, options) as unknown as LiveSearchSql;
}

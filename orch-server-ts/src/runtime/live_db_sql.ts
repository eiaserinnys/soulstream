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
  readonly unsafe?: (
    query: string,
    parameters?: unknown[],
  ) => LiveSearchPendingQuery<readonly Record<string, unknown>[]>;
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

export type LiveSearchQueryRunner = <T extends readonly Record<string, unknown>[]>(
  createQuery: (sql: LiveSearchSql) => LiveSearchPendingQuery<T>,
) => Promise<T>;

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
const LIVE_SEARCH_REQUEST_BUDGET_MS = 4_000;

export class LiveSearchDeadlineError extends Error {
  readonly statusCode = 504;

  constructor() {
    super("live database search exceeded its request deadline");
    this.name = "LiveSearchDeadlineError";
  }
}

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

export async function withLiveSearchDbConnection<T>(
  factory: LiveSearchDbConnectionFactory,
  signal: AbortSignal | undefined,
  onCancelError: (error: unknown) => void,
  run: (query: LiveSearchQueryRunner) => Promise<T>,
): Promise<T> {
  if (signal?.aborted) throw searchAbortReason(signal);
  const deadlineAt = Date.now() + LIVE_SEARCH_REQUEST_BUDGET_MS;
  const requestController = new AbortController();
  const onCallerAbort = () => {
    if (signal !== undefined) requestController.abort(searchAbortReason(signal));
  };
  signal?.addEventListener("abort", onCallerAbort, { once: true });
  const deadlineTimer = setTimeout(() => {
    requestController.abort(new LiveSearchDeadlineError());
  }, LIVE_SEARCH_REQUEST_BUDGET_MS);
  const requestSignal = requestController.signal;
  let connection: LiveSearchDbConnection | undefined;
  let activeQuery: LiveSearchPendingQuery<readonly Record<string, unknown>[]> | undefined;
  let disposePromise: Promise<void> | undefined;
  const dispose = () => {
    if (!connection) return Promise.resolve();
    disposePromise ??= connection.discard?.() ?? connection.close();
    return disposePromise;
  };
  const reportCancelError = (error: unknown) => {
    try {
      onCancelError(error);
    } catch {
      // Cancellation reporting must not hide the caller's cancellation error.
    }
  };
  const onAbort = () => {
    if (activeQuery !== undefined) {
      cancelLiveSearchQuerySafely(
        activeQuery as unknown as LiveSearchPendingQuery<readonly Record<string, unknown>[]>,
        reportCancelError,
      );
    }
    try {
      void dispose().catch(reportCancelError);
    } catch (error) {
      reportCancelError(error);
    }
  };
  requestSignal.addEventListener("abort", onAbort, { once: true });
  try {
    const openBudgetMs = deadlineAt - Date.now();
    if (openBudgetMs <= 0) {
      requestController.abort(new LiveSearchDeadlineError());
      throw searchAbortReason(requestSignal);
    }
    const opening = factory.open(Math.max(1, Math.floor(openBudgetMs)));
    void opening.then((opened) => {
      if (requestSignal.aborted && connection === undefined) {
        connection = opened;
        void dispose().catch(reportCancelError);
      }
    }, () => undefined);
    connection = await raceWithSearchAbort(opening, requestSignal);
    if (requestSignal.aborted) throw searchAbortReason(requestSignal);

    const query: LiveSearchQueryRunner = async (createQuery) => {
      if (requestSignal.aborted) throw searchAbortReason(requestSignal);
      let remainingBudgetMs = deadlineAt - Date.now();
      if (remainingBudgetMs <= 0) {
        requestController.abort(new LiveSearchDeadlineError());
        throw searchAbortReason(requestSignal);
      }
      const timeoutUpdate = connection!.sql.setStatementTimeout?.(
        Math.min(SEARCH_DB_STATEMENT_TIMEOUT_MS, Math.max(1, Math.floor(remainingBudgetMs))),
      );
      if (timeoutUpdate !== undefined) {
        await raceWithSearchAbort(timeoutUpdate, requestSignal);
      }
      if (requestSignal.aborted) throw searchAbortReason(requestSignal);
      remainingBudgetMs = deadlineAt - Date.now();
      if (remainingBudgetMs <= 0) {
        requestController.abort(new LiveSearchDeadlineError());
        throw searchAbortReason(requestSignal);
      }
      const pending = createQuery(connection!.sql);
      activeQuery = pending as unknown as LiveSearchPendingQuery<readonly Record<string, unknown>[]>;
      if (requestSignal.aborted) {
        cancelLiveSearchQuerySafely(
          activeQuery as unknown as LiveSearchPendingQuery<readonly Record<string, unknown>[]>,
          reportCancelError,
        );
        await dispose();
        throw searchAbortReason(requestSignal);
      }
      try {
        return await raceWithSearchAbort(pending, requestSignal);
      } finally {
        activeQuery = undefined;
      }
    };

    return await run(query);
  } finally {
    try {
      if (requestSignal.aborted) await dispose();
      else await connection?.close();
      if (requestSignal.aborted) {
        await dispose();
        throw searchAbortReason(requestSignal);
      }
    } finally {
      clearTimeout(deadlineTimer);
      signal?.removeEventListener("abort", onCallerAbort);
      requestSignal.removeEventListener("abort", onAbort);
    }
  }
}

function raceWithSearchAbort<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(searchAbortReason(signal));
  let onAbort: (() => void) | undefined;
  const aborted = new Promise<never>((_resolve, reject) => {
    onAbort = () => reject(searchAbortReason(signal));
    signal.addEventListener("abort", onAbort, { once: true });
  });
  return Promise.race([operation, aborted]).finally(() => {
    if (onAbort !== undefined) signal.removeEventListener("abort", onAbort);
  });
}

function searchAbortReason(signal: AbortSignal): Error {
  return signal.reason instanceof Error
    ? signal.reason
    : new Error("session search was cancelled");
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
      const unsafeQuery = sql.unsafe?.bind(sql);
      const searchSql = Object.assign(sql, {
        setStatementTimeout: async (timeoutMs: number) => {
          await sql`SELECT set_config('statement_timeout', ${`${timeoutMs}ms`}, false)`;
        },
        ...(unsafeQuery === undefined
          ? {}
          : { unsafe: unsafeQuery }),
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

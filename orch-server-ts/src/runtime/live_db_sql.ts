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
  // Runtime option omitted from the postgres.js 3.4.9 types.
  readonly max_pipeline?: number;
  readonly pipeline?: boolean;
  readonly connect_timeout?: number;
  readonly connection: {
    readonly statement_timeout: number;
    readonly idle_in_transaction_session_timeout?: number;
    readonly jit?: "off";
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
  readonly unsafe: (
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
  readonly idleInTransactionTimeoutMs?: number;
  readonly closeTimeoutSeconds?: number;
};

// postgres.js creates a separate max: 1 client for sql.listen(), so this keeps
// twenty request-query connections available while LISTEN raises the total ceiling to twenty-one.
const DEFAULT_POSTGRES_MAX_CONNECTIONS = 20;
// postgres.js has no asyncpg-style command_timeout; PostgreSQL statement_timeout
// is the explicit server-side equivalent for executable commands.
const DEFAULT_POSTGRES_STATEMENT_TIMEOUT_MS = 30_000;
// 트랜잭션을 열어 둔 채 멈춘 연결을 서버가 끊는다. 0은 postgres.js가 시작
// 메시지에서 빼므로 기본값으로 쓰지 않는다.
const DEFAULT_POSTGRES_IDLE_IN_TRANSACTION_TIMEOUT_MS = 60_000;
const DEFAULT_POSTGRES_CLOSE_TIMEOUT_SECONDS = 5;
export const SEARCH_DB_STATEMENT_TIMEOUT_MS = 8_000;
const SEARCH_DB_CLOSE_TIMEOUT_SECONDS = 1;
// Twice the measured 3.9 s history search, leaving 2 s of the 10 s handler deadline for metadata reads.
const LIVE_SEARCH_REQUEST_BUDGET_MS = 8_000;

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
  callerDeadlineAt?: number,
): Promise<T> {
  if (signal?.aborted) throw searchAbortReason(signal);
  const deadlineAt = callerDeadlineAt ?? Date.now() + LIVE_SEARCH_REQUEST_BUDGET_MS;
  const timeoutMs = callerDeadlineAt === undefined
    ? LIVE_SEARCH_REQUEST_BUDGET_MS
    : Math.max(1, deadlineAt - Date.now());
  const requestController = new AbortController();
  const onCallerAbort = () => {
    if (signal !== undefined) requestController.abort(searchAbortReason(signal));
  };
  signal?.addEventListener("abort", onCallerAbort, { once: true });
  const deadlineTimer = setTimeout(() => {
    requestController.abort(new LiveSearchDeadlineError());
  }, timeoutMs);
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

/**
 * 중단 신호의 이유를 취소 오류로 바꾼다. 검색 연결과 공유 풀 질의 취소가
 * 같은 규칙을 쓴다. 이미 중단된 신호에는 질의를 내지 않고 이 오류로 끝낸다.
 */
export function abortReasonFromSignal(
  signal: AbortSignal,
  fallbackMessage: string,
): Error {
  return signal.reason instanceof Error
    ? signal.reason
    : new Error(fallbackMessage);
}

function searchAbortReason(signal: AbortSignal): Error {
  return abortReasonFromSignal(signal, "session search was cancelled");
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
  const idleInTransactionTimeoutMs =
    options.idleInTransactionTimeoutMs
      ?? DEFAULT_POSTGRES_IDLE_IN_TRANSACTION_TIMEOUT_MS;
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
        // Wait for the first free connection instead of queuing behind a slow
        // query on a busy connection when the pool is full (card #1628).
        max_pipeline: 1,
        connection: {
          statement_timeout: statementTimeoutMs,
          idle_in_transaction_session_timeout: idleInTransactionTimeoutMs,
        },
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
        // Search requests have a short deadline. Compiling the BM25 plan can
        // cost more than executing it, and each request owns a fresh connection.
        connection: { statement_timeout: statementTimeoutMs, jit: "off" },
      });
      let closePromise: Promise<void> | undefined;
      const close = (timeoutSeconds: number) => {
        closePromise ??= sql.end?.({ timeout: timeoutSeconds }) ?? Promise.resolve();
        return closePromise;
      };
      const unsafeQuery = sql.unsafe.bind(sql);
      const searchSql = Object.assign(sql, {
        setStatementTimeout: async (timeoutMs: number) => {
          await sql`SELECT set_config('statement_timeout', ${`${timeoutMs}ms`}, false)`;
        },
        unsafe: unsafeQuery,
      });
      return {
        sql: searchSql,
        close: () => close(SEARCH_DB_CLOSE_TIMEOUT_SECONDS),
        discard: () => close(0),
      };
    },
  };
}

export function postgresErrorCode(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null || !("code" in error)) {
    return undefined;
  }
  return typeof error.code === "string" ? error.code : undefined;
}

export async function optionalRead(
  read: () => Promise<readonly Record<string, unknown>[]>,
): Promise<readonly Record<string, unknown>[]> {
  try {
    return await read();
  } catch (error) {
    if (isUndefinedTable(error)) return [];
    throw error;
  }
}

function isUndefinedTable(error: unknown): boolean {
  return typeof error === "object" && error !== null
    && (error as { code?: unknown }).code === "42P01";
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

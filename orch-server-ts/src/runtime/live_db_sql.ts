import postgres from "postgres";

import type { LiveConfigProviderBoundary } from "./live_provider_dependencies.js";

export type LivePostgresSql = {
  (
    strings: TemplateStringsArray,
    ...values: unknown[]
  ): readonly Record<string, unknown>[] | Promise<readonly Record<string, unknown>[]>;
  readonly end?: (options?: { readonly timeout?: number }) => Promise<void>;
};

export type LivePostgresFactory = (
  databaseUrl: string,
  options: { readonly max: number },
) => LivePostgresSql;

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
  readonly closeTimeoutSeconds?: number;
};

const DEFAULT_POSTGRES_MAX_CONNECTIONS = 5;
const DEFAULT_POSTGRES_CLOSE_TIMEOUT_SECONDS = 5;

export function createLiveDbSqlResolver(
  options: CreateLiveDbSqlResolverOptions,
): LiveDbSqlResolver {
  let sql = options.sql;
  let ownsSql = false;
  const maxConnections =
    options.maxConnections ?? DEFAULT_POSTGRES_MAX_CONNECTIONS;
  const closeTimeoutSeconds =
    options.closeTimeoutSeconds ?? DEFAULT_POSTGRES_CLOSE_TIMEOUT_SECONDS;

  return {
    async resolveSql() {
      if (sql !== undefined) return sql;
      const databaseUrl =
        options.databaseUrl ?? await requireLiveDatabaseUrl(options.configProvider);
      const factory = options.postgresFactory ?? defaultLivePostgresFactory;
      sql = factory(databaseUrl, { max: maxConnections });
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
  options: { readonly max: number },
): LivePostgresSql {
  return postgres(databaseUrl, options) as unknown as LivePostgresSql;
}

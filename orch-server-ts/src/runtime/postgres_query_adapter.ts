import type { LivePostgresSql } from "./live_db_sql.js";

export type PostgresQuerySql = {
  <T extends readonly Record<string, unknown>[] = readonly Record<string, unknown>[]>(
    strings: TemplateStringsArray,
    ...values: unknown[]
  ): Promise<T>;
  <T extends Record<string, unknown>>(
    value: T,
    ...columns: Array<Extract<keyof T, string>>
  ): unknown;
  readonly json: (value: unknown) => unknown;
  readonly array: (values: readonly unknown[]) => unknown;
};

type PostgresQueryCapableLiveSql = LivePostgresSql & {
  readonly array: (values: readonly unknown[]) => unknown;
};

export function createPostgresQueryAdapter(
  sql: PostgresQueryCapableLiveSql,
): PostgresQuerySql {
  function query<T extends readonly Record<string, unknown>[]>(
    strings: TemplateStringsArray,
    ...values: unknown[]
  ): Promise<T>;
  function query<T extends Record<string, unknown>>(
    value: T,
    ...columns: Array<Extract<keyof T, string>>
  ): unknown;
  function query(
    first: TemplateStringsArray | Record<string, unknown>,
    ...values: unknown[]
  ): Promise<readonly Record<string, unknown>[]> | unknown {
    if (isTemplateStringsArray(first)) {
      return Promise.resolve(sql(first, ...values));
    }
    return sql(
      first,
      ...(values as Array<Extract<keyof typeof first, string>>),
    );
  }

  return Object.assign(query, {
    json: (value: unknown) => sql.json(value),
    array: (values: readonly unknown[]) => sql.array(values),
  });
}

function isTemplateStringsArray(value: unknown): value is TemplateStringsArray {
  return Array.isArray(value) && Object.prototype.hasOwnProperty.call(value, "raw");
}

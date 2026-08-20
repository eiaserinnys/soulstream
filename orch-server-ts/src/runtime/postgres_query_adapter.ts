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
      const result = sql(first, ...values);
      // Never adopt the driver's result. postgres.js returns a `Query`, and a
      // `Query` is two things at once: a promise you can await, and a fragment
      // you can interpolate into another query. `Promise.resolve` would destroy
      // both halves — adopting a thenable calls `.then()`, which fires the
      // fragment off as a statement of its own, and the plain promise it hands
      // back no longer passes the driver's `instanceof Query` check, so the
      // parent binds it as a parameter and emits `SET $1`. Only a value that is
      // not already thenable — the synchronous rows a test double returns —
      // needs wrapping.
      return isThenable(result) ? result : Promise.resolve(result);
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

function isThenable(
  value: unknown,
): value is Promise<readonly Record<string, unknown>[]> {
  return typeof (value as { then?: unknown } | null | undefined)?.then === "function";
}

function isTemplateStringsArray(value: unknown): value is TemplateStringsArray {
  return Array.isArray(value) && Object.prototype.hasOwnProperty.call(value, "raw");
}

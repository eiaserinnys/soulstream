import type postgres from "postgres";

import type { SqlClient } from "./control_plane_types.js";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type RepositorySql = SqlClient | postgres.TransactionSql<any>;
type PostgresJsonValue = Parameters<RepositorySql["json"]>[0];

export function asPostgresJsonValue(value: unknown): PostgresJsonValue {
  return value as PostgresJsonValue;
}

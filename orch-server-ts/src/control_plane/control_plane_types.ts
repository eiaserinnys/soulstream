import type postgres from "postgres";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type SqlClient = postgres.Sql<any>;

import type postgres from "postgres";

import type { ClaudeTranscriptEntry, SqlClient } from "./control_plane_types.js";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type RepositorySql = SqlClient | postgres.TransactionSql<any>;
type PostgresJsonValue = Parameters<RepositorySql["json"]>[0];

export function asPostgresJsonValue(value: unknown): PostgresJsonValue {
  return value as PostgresJsonValue;
}

export function numberFromDb(
  value: string | number | null | undefined,
  field: string,
): number {
  if (value === null || value === undefined) throw new Error(`${field} returned null`);
  return Number(value);
}

export function recordFromDb(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" ? value as Record<string, unknown> : {};
}

export function normalizeTranscriptSubpath(value: string | null | undefined): string | null {
  return value && value.length > 0 ? value : null;
}

export function isClaudeTranscriptEntry(value: unknown): value is ClaudeTranscriptEntry {
  return value !== null && typeof value === "object" && !Array.isArray(value) &&
    typeof (value as Record<string, unknown>).type === "string";
}

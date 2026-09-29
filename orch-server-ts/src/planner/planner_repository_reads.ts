import { Buffer } from "node:buffer";
import type { PlannerPageDto, PlannerBlockDto, PlannerPageSlice } from "./planner_contract.js";

export class PlannerCursorError extends Error {
  readonly code = "PLANNER_CURSOR_INVALID";
}
export function decodeStarredFolderCursor(value?: string) {
  if (!value) return null;
  const cursor = decodeCursor(value, "starred-folder");
  if (!/^(0|[1-9]\d*)$/.test(cursor.first)) throw new PlannerCursorError("invalid planner cursor");
  return { position: cursor.first, second: cursor.second };
}
export function sliceRows<T, R>(
  rows: readonly T[], limit: number, scope: string,
  key: (row: T) => [string, string], map: (row: T) => R,
): PlannerPageSlice<R> {
  const visible = rows.slice(0, limit);
  const last = visible.at(-1);
  return { items: visible.map(map), nextCursor: rows.length > limit && last
    ? encodeCursor(scope, ...key(last)) : null };
}
export function pageDto(row: Record<string, unknown>): PlannerPageDto {
  return { id: String(row.id), title: String(row.title), daily_date: row.daily_date == null ? null : String(row.daily_date).slice(0, 10),
    version: Number(row.version), archived: Boolean(row.archived), metadata: row.metadata as Record<string, unknown>,
    created_at: timestamp(row.created_at), updated_at: timestamp(row.updated_at) };
}
export function blockDto(row: Record<string, unknown>): PlannerBlockDto {
  return { id: String(row.id), page_id: String(row.page_id), parent_id: row.parent_id as string | null,
    position_key: String(row.position_key), block_type: String(row.block_type), text: String(row.text_plain),
    properties: row.properties as Record<string, unknown>, collapsed: Boolean(row.collapsed) };
}
function timestamp(value: unknown): string { return value instanceof Date ? value.toISOString() : String(value); }

export function encodeCursor(scope: string, first: string, second: string): string {
  return Buffer.from(JSON.stringify([scope, first, second]), "utf8").toString("base64url");
}

export function decodeCursor(
  value: string,
  expectedScope: string,
): { first: string; second: string } {
  try {
    const parsed = JSON.parse(Buffer.from(value, "base64url").toString("utf8")) as unknown;
    if (
      !Array.isArray(parsed)
      || parsed.length !== 3
      || parsed[0] !== expectedScope
      || typeof parsed[1] !== "string"
      || parsed[1].length === 0
      || typeof parsed[2] !== "string"
      || parsed[2].length === 0
    ) {
      throw new Error("shape");
    }
    return { first: parsed[1], second: parsed[2] };
  } catch {
    throw new PlannerCursorError("invalid planner cursor");
  }
}

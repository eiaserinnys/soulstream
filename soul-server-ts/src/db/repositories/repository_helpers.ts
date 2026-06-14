import type postgres from "postgres";

import { normalizeMarkdownVersion } from "../markdown_document_version.js";
import type {
  BoardItemType,
  CatalogBoardItemRow,
  ClaudeTranscriptEntry,
  MarkdownDocumentRow,
  SqlClient,
} from "../session_db_types.js";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type TransactionSql = postgres.TransactionSql<any>;
export type RepositorySql = SqlClient | TransactionSql;
export type PostgresJsonValue = Parameters<RepositorySql["json"]>[0];

export function asPostgresJsonValue(value: unknown): PostgresJsonValue {
  return value as PostgresJsonValue;
}

export function numberFromDb(
  value: string | number | null | undefined,
  field: string,
): number {
  if (value === null || value === undefined) {
    throw new Error(`${field} returned null`);
  }
  return Number(value);
}

export function recordFromDb(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : {};
}

export function toIsoString(value: Date | string | null | undefined): string | undefined {
  if (!value) return undefined;
  if (value instanceof Date) return value.toISOString();
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? new Date(ms).toISOString() : undefined;
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function toCatalogBoardItemRow(row: {
  id: string;
  folder_id: string;
  item_type: BoardItemType;
  item_id: string;
  x: string | number;
  y: string | number;
  metadata: unknown;
  created_at: Date | string | null;
  updated_at: Date | string | null;
}): CatalogBoardItemRow {
  return {
    id: row.id,
    folderId: row.folder_id,
    itemType: row.item_type,
    itemId: row.item_id,
    x: Number(row.x),
    y: Number(row.y),
    metadata: isRecord(row.metadata) ? row.metadata : {},
    ...(toIsoString(row.created_at) ? { createdAt: toIsoString(row.created_at) } : {}),
    ...(toIsoString(row.updated_at) ? { updatedAt: toIsoString(row.updated_at) } : {}),
  };
}

export function parseCatalogBoardItems(value: unknown): CatalogBoardItemRow[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    if (!isRecord(item)) return [];
    const id = typeof item.id === "string" ? item.id : null;
    const folderId = typeof item.folderId === "string" ? item.folderId : null;
    const itemType = isBoardItemType(item.itemType) ? item.itemType : null;
    const itemId = typeof item.itemId === "string" ? item.itemId : null;
    if (!id || !folderId || !itemType || !itemId) return [];

    const x = Number(item.x);
    const y = Number(item.y);
    return [{
      id,
      folderId,
      itemType,
      itemId,
      x: Number.isFinite(x) ? x : 0,
      y: Number.isFinite(y) ? y : 0,
      metadata: isRecord(item.metadata) ? item.metadata : {},
      ...(toIsoString(typeof item.createdAt === "string" ? item.createdAt : null)
        ? { createdAt: toIsoString(typeof item.createdAt === "string" ? item.createdAt : null) }
        : {}),
      ...(toIsoString(typeof item.updatedAt === "string" ? item.updatedAt : null)
        ? { updatedAt: toIsoString(typeof item.updatedAt === "string" ? item.updatedAt : null) }
        : {}),
    }];
  });
}

export function isBoardItemType(value: unknown): value is BoardItemType {
  return value === "session" ||
    value === "markdown" ||
    value === "subfolder" ||
    value === "asset" ||
    value === "frame";
}

export function toMarkdownDocumentRow(row: {
  id: string;
  title: string;
  body: string;
  version?: string | number | null;
  created_at: Date | string | null;
  updated_at: Date | string | null;
}): MarkdownDocumentRow {
  return {
    id: row.id,
    title: row.title,
    body: row.body,
    version: normalizeMarkdownVersion(row.version),
    ...(toIsoString(row.created_at) ? { createdAt: toIsoString(row.created_at) } : {}),
    ...(toIsoString(row.updated_at) ? { updatedAt: toIsoString(row.updated_at) } : {}),
  };
}

export function normalizeTranscriptSubpath(value: string | null | undefined): string | null {
  return value && value.length > 0 ? value : null;
}

export function isClaudeTranscriptEntry(value: unknown): value is ClaudeTranscriptEntry {
  return (
    value !== null &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    typeof (value as Record<string, unknown>).type === "string"
  );
}

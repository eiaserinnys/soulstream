import { randomUUID } from "node:crypto";

import {
  FolderRouteError,
  type FolderRecord,
  type FolderReorderInput,
  type FolderRouteProvider,
  type FolderUpdateInput,
  type SessionAssignmentRecord,
} from "../folders/folder_routes.js";
import type { PublicStatusFolderCountsProvider } from "../public/public_status_routes.js";
import type { LiveDbSqlResolver, LivePostgresSql } from "./live_db_sql.js";

export type LiveFolderProvider = FolderRouteProvider &
  Pick<PublicStatusFolderCountsProvider, "getFolderCounts" | "listFolders"> & {
    findSessionFolderId: (sessionId: string) => Promise<string | null | undefined>;
    listSessionAssignmentsByIds: (
      sessionIds: readonly string[],
    ) => Promise<Record<string, SessionAssignmentRecord>>;
    listBoardItemIdsForSessionDeletion: (sessionId: string) => Promise<string[]>;
  };

export function createLiveFolderProvider(
  sqlResolver: LiveDbSqlResolver,
): LiveFolderProvider {
  return {
    async listFolders() {
      const sql = await sqlResolver.resolveSql();
      const rows = await sql`
        SELECT * FROM folder_get_all()
      `;
      return rows.flatMap(serializeFolderRow);
    },
    async listSessionAssignments(includeSessions = true) {
      if (!includeSessions) return {};
      const sql = await sqlResolver.resolveSql();
      const rows = await sql`
        SELECT session_id, folder_id, display_name FROM sessions
      `;
      return Object.fromEntries(rows.flatMap(sessionAssignmentEntry));
    },
    async findSessionFolderId(sessionId) {
      const sql = await sqlResolver.resolveSql();
      const rows = await sql`
        SELECT folder_id FROM sessions
        WHERE session_id = ${sessionId}
        LIMIT 1
      `;
      if (rows.length === 0) return undefined;
      return stringOrNull(rows[0]?.folder_id ?? rows[0]?.folderId);
    },
    async listSessionAssignmentsByIds(sessionIds) {
      if (sessionIds.length === 0) return {};
      const sql = await sqlResolver.resolveSql();
      const rows = await sql`
        SELECT session_id, folder_id, display_name
        FROM sessions
        WHERE session_id = ANY(${[...sessionIds]}::text[])
      `;
      return Object.fromEntries(rows.flatMap(sessionAssignmentEntry));
    },
    async listBoardItemIdsForSessionDeletion(sessionId) {
      const sql = await sqlResolver.resolveSql();
      const rows = await sql`
        SELECT id
        FROM board_items
        WHERE item_type = 'session' AND item_id = ${sessionId}
      `;
      return rows.flatMap((row) => {
        const id = stringOrNull(row.id);
        return id === null ? [] : [id];
      });
    },
    async getFolderCounts() {
      const sql = await sqlResolver.resolveSql();
      const rows = await sql`
        SELECT folder_id, COUNT(*)::int AS count
        FROM sessions
        GROUP BY folder_id
      `;
      return new Map(
        rows.map((row) => [
          stringOrNull(row.folder_id ?? row.folderId),
          numberValue(row.count) ?? 0,
        ]),
      );
    },
  };
}

function serializeFolderRow(row: Record<string, unknown>): FolderRecord[] {
  const id = stringOrNull(row.id);
  if (id === null) return [];
  const folder: FolderRecord = {
    id,
    name: String(row.name ?? ""),
    sortOrder: numberValue(row.sort_order ?? row.sortOrder) ?? 0,
    parentFolderId: stringOrNull(row.parent_folder_id ?? row.parentFolderId),
    projectPageId: stringOrNull(row.project_page_id ?? row.projectPageId),
    settings: objectValue(row.settings),
    archived: Boolean(row.archived),
    status: row.status, version: Number(row.version),
  };
  const createdAt = timestampString(row.created_at ?? row.createdAt);
  if (createdAt !== undefined) folder.createdAt = createdAt;
  const updatedAt = timestampString(row.updated_at ?? row.updatedAt);
  if (updatedAt !== undefined) folder.updatedAt = updatedAt;
  return [folder];
}

function sessionAssignmentEntry(
  row: Record<string, unknown>,
): Array<[string, SessionAssignmentRecord]> {
  const sessionId = stringOrNull(row.session_id ?? row.sessionId);
  if (sessionId === null) return [];
  return [[sessionId, {
    folderId: stringOrNull(row.folder_id ?? row.folderId),
    displayName: stringOrNull(row.display_name ?? row.displayName),
  }]];
}

function stringOrNull(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function numberValue(value: unknown): number | undefined {
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function objectValue(value: unknown): Record<string, unknown> {
  if (value === null || value === undefined) return {};
  if (typeof value === "string") {
    try {
      const parsed: unknown = JSON.parse(value);
      return objectValue(parsed);
    } catch {
      return {};
    }
  }
  if (typeof value === "object" && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  return {};
}

function timestampString(value: unknown): string | undefined {
  if (value instanceof Date) return value.toISOString();
  return typeof value === "string" ? value : undefined;
}

function hasOwn(object: object, key: PropertyKey): boolean {
  return Object.prototype.hasOwnProperty.call(object, key);
}

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
    deleteFolderWithCatalogDelta: (folderId: string) => Promise<{
      sessionsDelta: Record<string, SessionAssignmentRecord>;
      deletedBoardItemIds: string[];
    }>;
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
    async listSessionAssignments() {
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
    async deleteFolderWithCatalogDelta(folderId) {
      return await deleteFolderAndCollectCatalogDelta(sqlResolver, folderId);
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
    async createFolder(name, sortOrder, options) {
      const folderId = randomUUID();
      await validateFolderParentUpdates(sqlResolver, new Map([
        [folderId, options.parentFolderId],
      ]));
      const sql = await sqlResolver.resolveSql();
      await sql`
        SELECT folder_create(${folderId}, ${name}, ${sortOrder}, ${options.parentFolderId})
      `;
      return {
        id: folderId,
        name,
        sortOrder,
        parentFolderId: options.parentFolderId,
        settings: {},
      };
    },
    async updateFolder(folderId, update) {
      const patch = folderUpdatePatch(update);
      if (patch === null) return;
      if (hasOwn(update, "parentFolderId")) {
        await validateFolderParentUpdates(sqlResolver, new Map([
          [folderId, update.parentFolderId ?? null],
        ]));
      }
      const sql = await sqlResolver.resolveSql();
      await sql`
        SELECT folder_update(${folderId}, ${patch.columns}, ${patch.values})
      `;
    },
    async deleteFolder(folderId) {
      await deleteFolderAndCollectCatalogDelta(sqlResolver, folderId);
    },
    async reorderFolders(items) {
      const parentUpdates = folderReorderParentUpdates(items);
      if (parentUpdates.size > 0) {
        await validateFolderParentUpdates(sqlResolver, parentUpdates);
      }
      const sql = await sqlResolver.resolveSql();
      for (const item of items) {
        const patch = folderReorderPatch(item);
        await sql`
          SELECT folder_update(${item.id}, ${patch.columns}, ${patch.values})
        `;
      }
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

type TransactionCapableLivePostgresSql = LivePostgresSql & {
  readonly begin: <T>(
    callback: (sql: LivePostgresSql) => Promise<T>,
  ) => Promise<T>;
};

async function deleteFolderAndCollectCatalogDelta(
  sqlResolver: LiveDbSqlResolver,
  folderId: string,
): Promise<{
  sessionsDelta: Record<string, SessionAssignmentRecord>;
  deletedBoardItemIds: string[];
}> {
  const sql = await sqlResolver.resolveSql();
  assertTransactionSql(sql);
  return await sql.begin(async (transaction) => {
    const sessionRows = await transaction`
      UPDATE sessions
      SET folder_id = NULL
      WHERE folder_id = ${folderId}
      RETURNING session_id, display_name
    `;
    await transaction`
      UPDATE folders
      SET parent_folder_id = NULL
      WHERE parent_folder_id = ${folderId}
    `;
    const boardItemRows = await transaction`
      DELETE FROM board_items
      WHERE folder_id = ${folderId}
         OR (item_type = 'subfolder' AND item_id = ${folderId})
      RETURNING id
    `;
    await transaction`
      UPDATE folders
      SET archived = TRUE
      WHERE id = ${folderId}
    `;
    return {
      sessionsDelta: Object.fromEntries(sessionRows.flatMap((row) => {
        const sessionId = stringOrNull(row.session_id ?? row.sessionId);
        if (sessionId === null) return [];
        return [[sessionId, {
          folderId: null,
          displayName: stringOrNull(row.display_name ?? row.displayName),
        }]];
      })),
      deletedBoardItemIds: boardItemRows.flatMap((row) => {
        const id = stringOrNull(row.id);
        return id === null ? [] : [id];
      }),
    };
  });
}

function assertTransactionSql(
  sql: LivePostgresSql,
): asserts sql is TransactionCapableLivePostgresSql {
  if (typeof (sql as Partial<TransactionCapableLivePostgresSql>).begin !== "function") {
    throw new Error("folder deletion requires postgres.js begin()");
  }
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

type FolderUpdatePatch = {
  readonly columns: string[];
  readonly values: Array<string | null>;
};

function folderUpdatePatch(update: FolderUpdateInput): FolderUpdatePatch | null {
  const columns: string[] = [];
  const values: Array<string | null> = [];
  if (typeof update.name === "string") {
    columns.push("name");
    values.push(update.name);
  }
  if (typeof update.sortOrder === "number") {
    columns.push("sort_order");
    values.push(String(update.sortOrder));
  }
  if (update.settings !== undefined && update.settings !== null) {
    columns.push("settings");
    values.push(JSON.stringify(update.settings));
  }
  if (hasOwn(update, "parentFolderId")) {
    columns.push("parent_folder_id");
    values.push(update.parentFolderId ?? null);
  }
  return columns.length === 0 ? null : { columns, values };
}

function folderReorderParentUpdates(
  items: readonly FolderReorderInput[],
): Map<string, string | null> {
  const parentUpdates = new Map<string, string | null>();
  for (const item of items) {
    if (hasOwn(item, "parentFolderId")) {
      parentUpdates.set(item.id, item.parentFolderId ?? null);
    }
  }
  return parentUpdates;
}

function folderReorderPatch(item: FolderReorderInput): FolderUpdatePatch {
  const columns = ["sort_order"];
  const values: Array<string | null> = [String(item.sortOrder)];
  if (hasOwn(item, "parentFolderId")) {
    columns.push("parent_folder_id");
    values.push(item.parentFolderId ?? null);
  }
  return { columns, values };
}

async function validateFolderParentUpdates(
  sqlResolver: LiveDbSqlResolver,
  parentUpdates: ReadonlyMap<string, string | null>,
): Promise<void> {
  if ([...parentUpdates.values()].every((parentId) => parentId === null)) return;
  const sql = await sqlResolver.resolveSql();
  const rows = await sql`
    SELECT id, parent_folder_id FROM folders WHERE archived = FALSE
  `;
  const existingParents = new Map<string, string | null>();
  for (const row of rows) {
    const id = stringOrNull(row.id);
    if (id !== null) {
      existingParents.set(id, stringOrNull(row.parent_folder_id ?? row.parentFolderId));
    }
  }
  for (const [folderId, parentFolderId] of parentUpdates) {
    assertFolderParent(folderId, parentFolderId, parentUpdates, existingParents);
  }
}

function assertFolderParent(
  folderId: string,
  parentFolderId: string | null,
  parentUpdates: ReadonlyMap<string, string | null>,
  existingParents: ReadonlyMap<string, string | null>,
): void {
  if (parentFolderId !== null && !existingParents.has(parentFolderId)) {
    throw new FolderRouteError(
      "FOLDER_PARENT_NOT_FOUND",
      "Parent folder not found",
      400,
    );
  }
  const seen = new Set<string>([folderId]);
  let current: string | null = parentFolderId;
  while (current !== null) {
    if (current === folderId || seen.has(current)) {
      throw new FolderRouteError(
        "FOLDER_PARENT_CYCLE",
        "folder parent cycle",
        400,
      );
    }
    seen.add(current);
    current = parentUpdates.has(current)
      ? parentUpdates.get(current) ?? null
      : existingParents.get(current) ?? null;
  }
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

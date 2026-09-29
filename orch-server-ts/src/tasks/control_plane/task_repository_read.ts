import type {
  ChecklistAssigneeFields,
  ChecklistItemRow,
  ChecklistItemStatus,
  FolderListRow,
  FolderMyTurnItemRow,
  FolderOperationRow,
  FolderOperationTargetKind,
  FolderRow,
  ChecklistSectionRow,
  FolderSnapshot,
  FolderStatus,
  SqlClient,
} from "./task_types.js";
import {
  asPostgresJsonValue,
  recordFromDb,
  type RepositorySql,
} from "./repository_helpers.js";
import type { FolderOperationActorKind } from "./task_types.js";
import {
  type AppendFolderOperationTxParams,
  cleanPatch,
  normalizeOperation,
  requireOne,
  ChecklistVersionConflict,
} from "./task_models.js";

type FolderPatch = Partial<Pick<FolderRow, "name" | "archived" | "checklist_enabled">>;
type SectionPatch = Partial<
  Pick<ChecklistSectionRow, "title" | "archived" | "position_key"> &
    ChecklistAssigneeFields
>;
type ItemPatch = Partial<
  Pick<ChecklistItemRow, "title" | "how_to" | "archived" | "position_key" | "section_id"> &
    ChecklistAssigneeFields
>;

export class ChecklistRepositoryRead {
  constructor(protected readonly sql: SqlClient) {}

  async transaction<T>(callback: (sql: RepositorySql) => Promise<T>): Promise<T> {
    return (await this.sql.begin(callback)) as T;
  }

  async getFolder(folderId: string): Promise<FolderRow | null> {
    const rows = await this.sql<FolderRow[]>`
      SELECT * FROM folders WHERE id = ${folderId}
    `;
    return rows[0] ?? null;
  }

  async getFolderForUpdateTx(
    sql: RepositorySql,
    folderId: string,
  ): Promise<FolderRow> {
    const rows = await sql<FolderRow[]>`
      SELECT * FROM folders WHERE id = ${folderId} FOR UPDATE
    `;
    return requireOne(rows, "getFolderForUpdateTx");
  }

  async getSection(sectionId: string): Promise<ChecklistSectionRow | null> {
    const rows = await this.sql<ChecklistSectionRow[]>`
      SELECT * FROM checklist_sections WHERE id = ${sectionId}
    `;
    return rows[0] ?? null;
  }

  async getItem(itemId: string): Promise<ChecklistItemRow | null> {
    const rows = await this.sql<ChecklistItemRow[]>`
      SELECT * FROM checklist_items WHERE id = ${itemId}
    `;
    return rows[0] ?? null;
  }

  async getItemForUpdateTx(
    sql: RepositorySql,
    itemId: string,
  ): Promise<ChecklistItemRow> {
    const rows = await sql<ChecklistItemRow[]>`
      SELECT * FROM checklist_items WHERE id = ${itemId} FOR UPDATE
    `;
    return requireOne(rows, "getItemForUpdateTx");
  }

  async getFolderIdForItemTx(
    sql: RepositorySql,
    itemId: string,
  ): Promise<string> {
    const rows = await sql<Array<{ folder_id: string }>>`
      SELECT s.folder_id
      FROM checklist_items i
      JOIN checklist_sections s ON s.id = i.section_id
      WHERE i.id = ${itemId}
    `;
    return requireOne(rows, "getFolderIdForItemTx").folder_id;
  }

  async assertSectionBelongsToFolderTx(
    sql: RepositorySql,
    sectionId: string,
    folderId: string,
  ): Promise<void> {
    const rows = await sql<Array<{ id: string }>>`
      SELECT id
      FROM checklist_sections
      WHERE id = ${sectionId}
        AND folder_id = ${folderId}
    `;
    requireOne(rows, "assertSectionBelongsToFolderTx");
  }

  async assertItemBelongsToFolderTx(
    sql: RepositorySql,
    itemId: string,
    folderId: string,
  ): Promise<void> {
    const rows = await sql<Array<{ id: string }>>`
      SELECT i.id
      FROM checklist_items i
      JOIN checklist_sections s ON s.id = i.section_id
      WHERE i.id = ${itemId}
        AND s.folder_id = ${folderId}
    `;
    requireOne(rows, "assertItemBelongsToFolderTx");
  }

  async getSnapshot(folderId: string): Promise<FolderSnapshot | null> {
    const [folder, sections, items] = await Promise.all([
      this.getFolder(folderId),
      this.listSections(folderId, { includeArchived: true }),
      this.listItems(folderId, { includeArchived: true }),
    ]);
    return folder ? { folder, sections, items } : null;
  }

  async listFolders(params: {
    folderId: string | null;
    includeArchived?: boolean;
    limit?: number;
    offset?: number;
  }): Promise<FolderListRow[]> {
    const limit = Math.min(Math.max(params.limit ?? 100, 1), 500);
    return await this.sql<FolderListRow[]>`
      SELECT * FROM folders
      WHERE parent_folder_id IS NOT DISTINCT FROM ${params.folderId}
        AND (${params.includeArchived ?? false} OR archived = FALSE)
        AND id NOT IN ('claude', 'llm')
      ORDER BY sort_order, name, id
      LIMIT ${limit}
      OFFSET ${params.offset ?? 0}
    `;
  }

  async listSections(
    folderId: string,
    params: { includeArchived?: boolean } = {},
  ): Promise<ChecklistSectionRow[]> {
    return await this.sql<ChecklistSectionRow[]>`
      SELECT *
      FROM checklist_sections
      WHERE folder_id = ${folderId}
        AND (${params.includeArchived ?? false} OR archived = FALSE)
      ORDER BY position_key ASC, created_at ASC
    `;
  }

  async listItems(
    folderId: string,
    params: { includeArchived?: boolean } = {},
  ): Promise<ChecklistItemRow[]> {
    return await this.sql<ChecklistItemRow[]>`
      SELECT i.*
      FROM checklist_items i
      JOIN checklist_sections s ON s.id = i.section_id
      WHERE s.folder_id = ${folderId}
        AND (${params.includeArchived ?? false} OR i.archived = FALSE)
      ORDER BY s.position_key ASC, i.position_key ASC, i.created_at ASC
    `;
  }

  async listMyTurnItems(params: {
    userId?: string | null;
    limit?: number;
  } = {}): Promise<FolderMyTurnItemRow[]> {
    const limit = Math.min(Math.max(params.limit ?? 100, 1), 500);
    return await this.sql<FolderMyTurnItemRow[]>`
      SELECT
        r.id AS folder_id,
        r.name AS folder_name,
        r.status AS folder_status,
        r.completed_kind AS folder_completed_kind,
        r.completed_session_id AS folder_completed_session_id,
        r.completed_event_id AS folder_completed_event_id,
        r.completed_user_id AS folder_completed_user_id,
        r.completed_at AS folder_completed_at,
        s.id AS section_id,
        s.title AS section_title,
        i.id AS item_id,
        i.title AS item_title,
        i.how_to,
        i.status,
        i.version AS item_version,
        COALESCE(i.assignee_kind, s.assignee_kind) AS effective_assignee_kind,
        CASE WHEN i.assignee_kind IS NULL THEN s.assignee_agent_id ELSE i.assignee_agent_id END AS effective_assignee_agent_id,
        CASE WHEN i.assignee_kind IS NULL THEN s.assignee_session_id ELSE i.assignee_session_id END AS effective_assignee_session_id,
        CASE WHEN i.assignee_kind IS NULL THEN s.assignee_user_id ELSE i.assignee_user_id END AS effective_assignee_user_id
      FROM checklist_items i
      JOIN checklist_sections s ON s.id = i.section_id
      JOIN folders r ON r.id = s.folder_id
      WHERE r.archived = FALSE
        AND r.checklist_enabled = TRUE
        AND r.id NOT IN ('claude', 'llm')
        AND r.status <> 'completed'
        AND s.archived = FALSE
        AND i.archived = FALSE
        AND (
          i.status = 'review'
          OR (
            i.status NOT IN ('completed', 'cancelled')
            AND COALESCE(i.assignee_kind, s.assignee_kind) = 'human'
            AND (
              ${params.userId ?? null}::text IS NULL
              OR (CASE WHEN i.assignee_kind IS NULL THEN s.assignee_user_id ELSE i.assignee_user_id END) IS NULL
              OR (CASE WHEN i.assignee_kind IS NULL THEN s.assignee_user_id ELSE i.assignee_user_id END) = ${params.userId ?? null}
            )
          )
        )
      ORDER BY
        CASE
          WHEN i.status = 'review' THEN 0
          WHEN i.status = 'in_progress' THEN 1
          ELSE 2
        END,
        r.updated_at DESC,
        s.position_key ASC,
        i.position_key ASC
      LIMIT ${limit}
    `;
  }

  async getOperationByIdempotencyKey(
    idempotencyKey: string,
  ): Promise<FolderOperationRow | null> {
    const rows = await this.sql<FolderOperationRow[]>`
      SELECT *
      FROM folder_operations
      WHERE idempotency_key = ${idempotencyKey}
      LIMIT 1
    `;
    return rows[0] ? normalizeOperation(rows[0]) : null;
  }

  async listOperations(folderId: string, limit = 50, offset = 0): Promise<FolderOperationRow[]> {
    return (
      await this.sql<FolderOperationRow[]>`
        SELECT *
        FROM folder_operations
        WHERE folder_id = ${folderId}
        ORDER BY created_at DESC, id DESC
        LIMIT ${Math.min(Math.max(limit, 1), 201)}
        OFFSET ${offset}
      `
    ).map(normalizeOperation);
  }

  async listAgentSubscriberSessionIds(folderId: string): Promise<string[]> {
    const rows = await this.sql<Array<{ actor_session_id: string }>>`
      SELECT DISTINCT actor_session_id
      FROM folder_operations
      WHERE folder_id = ${folderId}
        AND actor_kind = 'agent'
        AND actor_session_id IS NOT NULL
      ORDER BY actor_session_id ASC
    `;
    return rows.map((row) => row.actor_session_id);
  }

}

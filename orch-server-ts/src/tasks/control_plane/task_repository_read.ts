import type {
  TaskAssigneeFields,
  TaskItemRow,
  TaskItemStatus,
  TaskListRow,
  TaskMyTurnItemRow,
  TaskOperationRow,
  TaskOperationTargetKind,
  TaskRow,
  TaskSectionRow,
  TaskSnapshot,
  TaskStatus,
  SqlClient,
} from "./task_types.js";
import {
  asPostgresJsonValue,
  recordFromDb,
  type RepositorySql,
} from "./repository_helpers.js";
import type { TaskOperationActorKind } from "./task_types.js";
import {
  type AppendTaskOperationTxParams,
  cleanPatch,
  normalizeOperation,
  requireOne,
  TaskVersionConflict,
} from "./task_models.js";

type TaskPatch = Partial<Pick<TaskRow, "title" | "archived">>;
type SectionPatch = Partial<
  Pick<TaskSectionRow, "title" | "archived" | "position_key"> &
    TaskAssigneeFields
>;
type ItemPatch = Partial<
  Pick<TaskItemRow, "title" | "how_to" | "archived" | "position_key" | "section_id"> &
    TaskAssigneeFields
>;

export class TaskRepositoryRead {
  constructor(protected readonly sql: SqlClient) {}

  async transaction<T>(callback: (sql: RepositorySql) => Promise<T>): Promise<T> {
    return (await this.sql.begin(callback)) as T;
  }

  async getTask(taskId: string): Promise<TaskRow | null> {
    const rows = await this.sql<TaskRow[]>`
      SELECT * FROM tasks WHERE id = ${taskId}
    `;
    return rows[0] ?? null;
  }

  async getTaskForUpdateTx(
    sql: RepositorySql,
    taskId: string,
  ): Promise<TaskRow> {
    const rows = await sql<TaskRow[]>`
      SELECT * FROM tasks WHERE id = ${taskId} FOR UPDATE
    `;
    return requireOne(rows, "getTaskForUpdateTx");
  }

  async getSection(sectionId: string): Promise<TaskSectionRow | null> {
    const rows = await this.sql<TaskSectionRow[]>`
      SELECT * FROM task_sections WHERE id = ${sectionId}
    `;
    return rows[0] ?? null;
  }

  async getItem(itemId: string): Promise<TaskItemRow | null> {
    const rows = await this.sql<TaskItemRow[]>`
      SELECT * FROM task_items WHERE id = ${itemId}
    `;
    return rows[0] ?? null;
  }

  async getItemForUpdateTx(
    sql: RepositorySql,
    itemId: string,
  ): Promise<TaskItemRow> {
    const rows = await sql<TaskItemRow[]>`
      SELECT * FROM task_items WHERE id = ${itemId} FOR UPDATE
    `;
    return requireOne(rows, "getItemForUpdateTx");
  }

  async getTaskIdForItemTx(
    sql: RepositorySql,
    itemId: string,
  ): Promise<string> {
    const rows = await sql<Array<{ task_id: string }>>`
      SELECT s.task_id
      FROM task_items i
      JOIN task_sections s ON s.id = i.section_id
      WHERE i.id = ${itemId}
    `;
    return requireOne(rows, "getTaskIdForItemTx").task_id;
  }

  async assertSectionBelongsToTaskTx(
    sql: RepositorySql,
    sectionId: string,
    taskId: string,
  ): Promise<void> {
    const rows = await sql<Array<{ id: string }>>`
      SELECT id
      FROM task_sections
      WHERE id = ${sectionId}
        AND task_id = ${taskId}
    `;
    requireOne(rows, "assertSectionBelongsToTaskTx");
  }

  async assertItemBelongsToTaskTx(
    sql: RepositorySql,
    itemId: string,
    taskId: string,
  ): Promise<void> {
    const rows = await sql<Array<{ id: string }>>`
      SELECT i.id
      FROM task_items i
      JOIN task_sections s ON s.id = i.section_id
      WHERE i.id = ${itemId}
        AND s.task_id = ${taskId}
    `;
    requireOne(rows, "assertItemBelongsToTaskTx");
  }

  async getSnapshot(taskId: string): Promise<TaskSnapshot | null> {
    const [task, sections, items] = await Promise.all([
      this.getTask(taskId),
      this.listSections(taskId, { includeArchived: true }),
      this.listItems(taskId, { includeArchived: true }),
    ]);
    return task ? { task, sections, items } : null;
  }

  async listTasks(params: {
    folderId: string;
    includeArchived?: boolean;
    limit?: number;
  }): Promise<TaskListRow[]> {
    const limit = Math.min(Math.max(params.limit ?? 100, 1), 500);
    const rows = await this.sql<Array<{
      id: string;
      board_item_id: string;
      folder_id: string;
      title: string;
      status: TaskStatus;
      archived: boolean;
      version: number;
      x: string | number;
      y: string | number;
      metadata: unknown;
      completed_kind: TaskRow["completed_kind"];
      completed_session_id: string | null;
      completed_event_id: number | null;
      completed_user_id: string | null;
      completed_at: Date | null;
      created_at: Date;
      updated_at: Date;
    }>>`
      SELECT
        r.id,
        r.board_item_id,
        bi.folder_id,
        r.title,
        r.status,
        r.archived,
        r.version,
        bi.x,
        bi.y,
        bi.metadata,
        r.completed_kind,
        r.completed_session_id,
        r.completed_event_id,
        r.completed_user_id,
        r.completed_at,
        r.created_at,
        r.updated_at
      FROM tasks r
      JOIN board_items bi ON bi.id = r.board_item_id
      WHERE bi.folder_id = ${params.folderId}
        AND bi.item_type = 'task'
        AND (${params.includeArchived ?? false} OR r.archived = FALSE)
      ORDER BY bi.y ASC, bi.x ASC, r.updated_at DESC, r.id ASC
      LIMIT ${limit}
    `;
    return rows.map((row) => ({
      ...row,
      x: Number(row.x),
      y: Number(row.y),
      metadata: recordFromDb(row.metadata),
    }));
  }

  async listSections(
    taskId: string,
    params: { includeArchived?: boolean } = {},
  ): Promise<TaskSectionRow[]> {
    return await this.sql<TaskSectionRow[]>`
      SELECT *
      FROM task_sections
      WHERE task_id = ${taskId}
        AND (${params.includeArchived ?? false} OR archived = FALSE)
      ORDER BY position_key ASC, created_at ASC
    `;
  }

  async listItems(
    taskId: string,
    params: { includeArchived?: boolean } = {},
  ): Promise<TaskItemRow[]> {
    return await this.sql<TaskItemRow[]>`
      SELECT i.*
      FROM task_items i
      JOIN task_sections s ON s.id = i.section_id
      WHERE s.task_id = ${taskId}
        AND (${params.includeArchived ?? false} OR i.archived = FALSE)
      ORDER BY s.position_key ASC, i.position_key ASC, i.created_at ASC
    `;
  }

  async listMyTurnItems(params: {
    userId?: string | null;
    limit?: number;
  } = {}): Promise<TaskMyTurnItemRow[]> {
    const limit = Math.min(Math.max(params.limit ?? 100, 1), 500);
    return await this.sql<TaskMyTurnItemRow[]>`
      SELECT
        r.id AS task_id,
        r.title AS task_title,
        r.status AS task_status,
        r.board_item_id,
        r.completed_kind AS task_completed_kind,
        r.completed_session_id AS task_completed_session_id,
        r.completed_event_id AS task_completed_event_id,
        r.completed_user_id AS task_completed_user_id,
        r.completed_at AS task_completed_at,
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
      FROM task_items i
      JOIN task_sections s ON s.id = i.section_id
      JOIN tasks r ON r.id = s.task_id
      WHERE r.archived = FALSE
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
  ): Promise<TaskOperationRow | null> {
    const rows = await this.sql<TaskOperationRow[]>`
      SELECT *
      FROM task_operations
      WHERE idempotency_key = ${idempotencyKey}
      LIMIT 1
    `;
    return rows[0] ? normalizeOperation(rows[0]) : null;
  }

  async listOperations(taskId: string, limit = 50): Promise<TaskOperationRow[]> {
    return (
      await this.sql<TaskOperationRow[]>`
        SELECT *
        FROM task_operations
        WHERE task_id = ${taskId}
        ORDER BY created_at DESC
        LIMIT ${Math.min(Math.max(limit, 1), 200)}
      `
    ).map(normalizeOperation);
  }

  async listAgentSubscriberSessionIds(taskId: string): Promise<string[]> {
    const rows = await this.sql<Array<{ actor_session_id: string }>>`
      SELECT DISTINCT actor_session_id
      FROM task_operations
      WHERE task_id = ${taskId}
        AND actor_kind = 'agent'
        AND actor_session_id IS NOT NULL
      ORDER BY actor_session_id ASC
    `;
    return rows.map((row) => row.actor_session_id);
  }

  async createTaskTx(
    sql: RepositorySql,
    params: {
      id: string;
      boardItemId: string;
      title: string;
      createdSessionId: string | null;
      createdEventId: number | null;
    },
  ): Promise<TaskRow> {
    const rows = await sql<TaskRow[]>`
      INSERT INTO tasks (id, board_item_id, title, created_session_id, created_event_id)
      VALUES (
        ${params.id},
        ${params.boardItemId},
        ${params.title},
        ${params.createdSessionId},
        ${params.createdEventId}
      )
      RETURNING *
    `;
    return requireOne(rows, "createTaskTx");
  }

  async getTaskBoardItem(taskId: string): Promise<{
    id: string;
    folder_id: string;
    item_id: string;
    x: string | number;
    y: string | number;
    metadata: unknown;
  } | null> {
    const rows = await this.sql<Array<{
      id: string;
      folder_id: string;
      item_id: string;
      x: string | number;
      y: string | number;
      metadata: unknown;
    }>>`
      SELECT bi.id, bi.folder_id, bi.item_id, bi.x, bi.y, bi.metadata
      FROM board_items bi
      JOIN tasks r ON r.board_item_id = bi.id
      WHERE r.id = ${taskId}
        AND bi.item_type = 'task'
    `;
    return rows[0] ?? null;
  }

}

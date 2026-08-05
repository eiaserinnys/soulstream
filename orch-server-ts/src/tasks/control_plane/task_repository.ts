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
import { TaskRepositoryRead } from "./task_repository_read.js";
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

export class TaskRepository extends TaskRepositoryRead {
  async patchTaskTx(
    sql: RepositorySql,
    taskId: string,
    fields: TaskPatch,
    expectedVersion: number,
  ): Promise<TaskRow> {
    await this.assertVersionTx(sql, "task", taskId, expectedVersion);
    const clean = cleanPatch(fields);
    const rows = await sql<TaskRow[]>`
      UPDATE tasks
      SET ${sql(clean)},
          updated_at = NOW(),
          version = version + 1
      WHERE id = ${taskId}
      RETURNING *
    `;
    return requireOne(rows, "patchTaskTx");
  }

  async setTaskStatusTx(
    sql: RepositorySql,
    params: {
      taskId: string;
      status: TaskStatus;
      expectedVersion: number;
      actorKind: TaskOperationActorKind;
      actorSessionId: string | null;
      actorUserId: string | null;
      eventId: number | null;
    },
  ): Promise<TaskRow> {
    await this.assertVersionTx(sql, "task", params.taskId, params.expectedVersion);
    const completedKind =
      params.status === "completed" && params.actorKind !== "system"
        ? params.actorKind
        : null;
    const rows = await sql<TaskRow[]>`
      UPDATE tasks
      SET status = ${params.status},
          completed_kind = ${completedKind},
          completed_session_id = ${params.status === "completed" ? params.actorSessionId : null},
          completed_event_id = ${params.status === "completed" ? params.eventId : null},
          completed_user_id = ${params.status === "completed" ? params.actorUserId : null},
          completed_at = ${params.status === "completed" ? new Date() : null},
          updated_at = NOW(),
          version = version + 1
      WHERE id = ${params.taskId}
      RETURNING *
    `;
    return requireOne(rows, "setTaskStatusTx");
  }

  async createSectionTx(
    sql: RepositorySql,
    params: {
      id: string;
      taskId: string;
      title: string;
      positionKey: string;
      assignee: TaskAssigneeFields;
      actorSessionId: string | null;
      eventId: number | null;
    },
  ): Promise<TaskSectionRow> {
    const rows = await sql<TaskSectionRow[]>`
      INSERT INTO task_sections (
        id, task_id, position_key, title,
        assignee_kind, assignee_agent_id, assignee_session_id, assignee_user_id,
        created_session_id, created_event_id, updated_session_id, updated_event_id
      )
      VALUES (
        ${params.id}, ${params.taskId}, ${params.positionKey}, ${params.title},
        ${params.assignee.assignee_kind}, ${params.assignee.assignee_agent_id},
        ${params.assignee.assignee_session_id}, ${params.assignee.assignee_user_id},
        ${params.actorSessionId}, ${params.eventId}, ${params.actorSessionId}, ${params.eventId}
      )
      RETURNING *
    `;
    return requireOne(rows, "createSectionTx");
  }

  async patchSectionTx(
    sql: RepositorySql,
    sectionId: string,
    fields: SectionPatch,
    expectedVersion: number,
    actorSessionId: string | null,
    eventId: number | null,
  ): Promise<TaskSectionRow> {
    await this.assertVersionTx(sql, "section", sectionId, expectedVersion);
    const clean = cleanPatch(fields);
    const rows = await sql<TaskSectionRow[]>`
      UPDATE task_sections
      SET ${sql(clean)},
          updated_session_id = ${actorSessionId},
          updated_event_id = ${eventId},
          updated_at = NOW(),
          version = version + 1
      WHERE id = ${sectionId}
      RETURNING *
    `;
    return requireOne(rows, "patchSectionTx");
  }

  async createItemTx(
    sql: RepositorySql,
    params: {
      id: string;
      sectionId: string;
      title: string;
      howTo: string;
      positionKey: string;
      assignee: TaskAssigneeFields;
      actorKind: TaskOperationActorKind;
      actorSessionId: string | null;
      actorUserId: string | null;
      eventId: number | null;
    },
  ): Promise<TaskItemRow> {
    const rows = await sql<TaskItemRow[]>`
      INSERT INTO task_items (
        id, section_id, position_key, title, how_to,
        assignee_kind, assignee_agent_id, assignee_session_id, assignee_user_id,
        created_session_id, created_event_id, updated_session_id, updated_event_id
      )
      VALUES (
        ${params.id}, ${params.sectionId}, ${params.positionKey}, ${params.title}, ${params.howTo},
        ${params.assignee.assignee_kind}, ${params.assignee.assignee_agent_id},
        ${params.assignee.assignee_session_id}, ${params.assignee.assignee_user_id},
        ${params.actorSessionId}, ${params.eventId}, ${params.actorSessionId}, ${params.eventId}
      )
      RETURNING *
    `;
    return requireOne(rows, "createItemTx");
  }

  async patchItemTx(
    sql: RepositorySql,
    itemId: string,
    fields: ItemPatch,
    expectedVersion: number,
    actorSessionId: string | null,
    eventId: number | null,
  ): Promise<TaskItemRow> {
    await this.assertVersionTx(sql, "item", itemId, expectedVersion);
    const clean = cleanPatch(fields);
    const rows = await sql<TaskItemRow[]>`
      UPDATE task_items
      SET ${sql(clean)},
          updated_session_id = ${actorSessionId},
          updated_event_id = ${eventId},
          updated_at = NOW(),
          version = version + 1
      WHERE id = ${itemId}
      RETURNING *
    `;
    return requireOne(rows, "patchItemTx");
  }

  async setItemStatusTx(
    sql: RepositorySql,
    params: {
      itemId: string;
      status: TaskItemStatus;
      expectedVersion: number;
      actorKind: TaskOperationActorKind;
      actorSessionId: string | null;
      actorUserId: string | null;
      eventId: number | null;
    },
  ): Promise<TaskItemRow> {
    await this.assertVersionTx(sql, "item", params.itemId, params.expectedVersion);
    const completedKind =
      params.status === "completed" && params.actorKind !== "system"
        ? params.actorKind
        : null;
    const rows = await sql<TaskItemRow[]>`
      UPDATE task_items
      SET status = ${params.status},
          updated_session_id = ${params.actorSessionId},
          updated_event_id = ${params.eventId},
          completed_kind = ${completedKind},
          completed_session_id = ${params.status === "completed" ? params.actorSessionId : null},
          completed_event_id = ${params.status === "completed" ? params.eventId : null},
          completed_user_id = ${params.status === "completed" ? params.actorUserId : null},
          completed_at = ${params.status === "completed" ? new Date() : null},
          updated_at = NOW(),
          version = version + 1
      WHERE id = ${params.itemId}
      RETURNING *
    `;
    return requireOne(rows, "setItemStatusTx");
  }

  async appendOperationTx(
    sql: RepositorySql,
    params: AppendTaskOperationTxParams,
  ): Promise<TaskOperationRow> {
    const rows = await sql<TaskOperationRow[]>`
      INSERT INTO task_operations (
        id, task_id, target_kind, target_id, operation_type,
        actor_kind, actor_session_id, actor_event_id, actor_user_id,
        idempotency_key, payload_json, reason
      )
      VALUES (
        ${params.id}, ${params.taskId}, ${params.targetKind}, ${params.targetId},
        ${params.operationType}, ${params.actorKind}, ${params.actorSessionId ?? null},
        ${params.actorEventId}, ${params.actorUserId ?? null}, ${params.idempotencyKey ?? null},
        ${sql.json(asPostgresJsonValue(params.payload))}::jsonb, ${params.reason ?? null}
      )
      RETURNING *
    `;
    return normalizeOperation(requireOne(rows, "appendOperationTx"));
  }

  async assertTaskVersionTx(
    sql: RepositorySql,
    taskId: string,
    expectedVersion: number,
  ): Promise<void> {
    await this.assertVersionTx(sql, "task", taskId, expectedVersion);
  }

  async assertSectionVersionTx(
    sql: RepositorySql,
    sectionId: string,
    expectedVersion: number,
  ): Promise<void> {
    await this.assertVersionTx(sql, "section", sectionId, expectedVersion);
  }

  async assertItemVersionTx(
    sql: RepositorySql,
    itemId: string,
    expectedVersion: number,
  ): Promise<void> {
    await this.assertVersionTx(sql, "item", itemId, expectedVersion);
  }

  private async assertVersionTx(
    sql: RepositorySql,
    targetKind: TaskOperationTargetKind,
    targetId: string,
    expectedVersion: number,
  ): Promise<void> {
    const actualVersion = await this.lockVersionTx(sql, targetKind, targetId);
    if (actualVersion !== expectedVersion) {
      throw new TaskVersionConflict(
        targetKind,
        targetId,
        expectedVersion,
        actualVersion,
      );
    }
  }

  private async lockVersionTx(
    sql: RepositorySql,
    targetKind: TaskOperationTargetKind,
    targetId: string,
  ): Promise<number> {
    const rows =
      targetKind === "task"
        ? await sql<Array<{ version: string | number }>>`
            SELECT version FROM tasks WHERE id = ${targetId} FOR UPDATE
          `
        : targetKind === "section"
          ? await sql<Array<{ version: string | number }>>`
              SELECT version FROM task_sections WHERE id = ${targetId} FOR UPDATE
            `
          : await sql<Array<{ version: string | number }>>`
              SELECT version FROM task_items WHERE id = ${targetId} FOR UPDATE
            `;
    const version = rows[0]?.version;
    if (version === undefined) {
      throw new Error(`task ${targetKind} not found: ${targetId}`);
    }
    return Number(version);
  }

}

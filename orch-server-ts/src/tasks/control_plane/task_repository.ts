import { appendFolderOperation } from "../../folders/folder_operation_store.js";
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
import { ChecklistRepositoryRead } from "./task_repository_read.js";
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

export class ChecklistRepository extends ChecklistRepositoryRead {
  async patchFolderTx(
    sql: RepositorySql,
    folderId: string,
    fields: FolderPatch,
    expectedVersion: number,
  ): Promise<FolderRow> {
    await this.assertVersionTx(sql, "folder", folderId, expectedVersion);
    const clean = cleanPatch(fields);
    const rows = await sql<FolderRow[]>`
      UPDATE folders
      SET ${sql(clean)},
          updated_at = NOW(),
          version = version + 1
      WHERE id = ${folderId}
      RETURNING *
    `;
    return requireOne(rows, "patchFolderTx");
  }

  async setFolderStatusTx(
    sql: RepositorySql,
    params: {
      folderId: string;
      status: FolderStatus;
      expectedVersion: number;
      actorKind: FolderOperationActorKind;
      actorSessionId: string | null;
      actorUserId: string | null;
      eventId: number | null;
    },
  ): Promise<FolderRow> {
    await this.assertVersionTx(sql, "folder", params.folderId, params.expectedVersion);
    const completedKind =
      params.status === "completed" && params.actorKind !== "system"
        ? params.actorKind
        : null;
    const rows = await sql<FolderRow[]>`
      UPDATE folders
      SET status = ${params.status},
          completed_kind = ${completedKind},
          completed_session_id = ${params.status === "completed" ? params.actorSessionId : null},
          completed_event_id = ${params.status === "completed" ? params.eventId : null},
          completed_user_id = ${params.status === "completed" ? params.actorUserId : null},
          completed_at = ${params.status === "completed" ? new Date() : null},
          updated_at = NOW(),
          version = version + 1
      WHERE id = ${params.folderId}
      RETURNING *
    `;
    return requireOne(rows, "setFolderStatusTx");
  }

  async createSectionTx(
    sql: RepositorySql,
    params: {
      id: string;
      folderId: string;
      title: string;
      positionKey: string;
      assignee: ChecklistAssigneeFields;
      actorSessionId: string | null;
      eventId: number | null;
    },
  ): Promise<ChecklistSectionRow> {
    const rows = await sql<ChecklistSectionRow[]>`
      INSERT INTO checklist_sections (
        id, folder_id, position_key, title,
        assignee_kind, assignee_agent_id, assignee_session_id, assignee_user_id,
        created_session_id, created_event_id, updated_session_id, updated_event_id
      )
      VALUES (
        ${params.id}, ${params.folderId}, ${params.positionKey}, ${params.title},
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
  ): Promise<ChecklistSectionRow> {
    await this.assertVersionTx(sql, "section", sectionId, expectedVersion);
    const clean = cleanPatch(fields);
    const rows = await sql<ChecklistSectionRow[]>`
      UPDATE checklist_sections
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
      assignee: ChecklistAssigneeFields;
      actorKind: FolderOperationActorKind;
      actorSessionId: string | null;
      actorUserId: string | null;
      eventId: number | null;
    },
  ): Promise<ChecklistItemRow> {
    const rows = await sql<ChecklistItemRow[]>`
      INSERT INTO checklist_items (
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
  ): Promise<ChecklistItemRow> {
    await this.assertVersionTx(sql, "item", itemId, expectedVersion);
    const clean = cleanPatch(fields);
    const rows = await sql<ChecklistItemRow[]>`
      UPDATE checklist_items
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
      status: ChecklistItemStatus;
      expectedVersion: number;
      actorKind: FolderOperationActorKind;
      actorSessionId: string | null;
      actorUserId: string | null;
      eventId: number | null;
    },
  ): Promise<ChecklistItemRow> {
    await this.assertVersionTx(sql, "item", params.itemId, params.expectedVersion);
    const completedKind =
      params.status === "completed" && params.actorKind !== "system"
        ? params.actorKind
        : null;
    const rows = await sql<ChecklistItemRow[]>`
      UPDATE checklist_items
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
    params: AppendFolderOperationTxParams,
  ): Promise<FolderOperationRow> {
    return appendFolderOperation(sql, params);
  }

  async assertFolderVersionTx(
    sql: RepositorySql,
    folderId: string,
    expectedVersion: number,
  ): Promise<void> {
    await this.assertVersionTx(sql, "folder", folderId, expectedVersion);
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
    targetKind: FolderOperationTargetKind,
    targetId: string,
    expectedVersion: number,
  ): Promise<void> {
    const actualVersion = await this.lockVersionTx(sql, targetKind, targetId);
    if (actualVersion !== expectedVersion) {
      throw new ChecklistVersionConflict(
        targetKind,
        targetId,
        expectedVersion,
        actualVersion,
      );
    }
  }

  private async lockVersionTx(
    sql: RepositorySql,
    targetKind: FolderOperationTargetKind,
    targetId: string,
  ): Promise<number> {
    const rows =
      targetKind === "folder"
        ? await sql<Array<{ version: string | number }>>`
            SELECT version FROM folders WHERE id = ${targetId} FOR UPDATE
          `
        : targetKind === "section"
          ? await sql<Array<{ version: string | number }>>`
              SELECT version FROM checklist_sections WHERE id = ${targetId} FOR UPDATE
            `
          : await sql<Array<{ version: string | number }>>`
              SELECT version FROM checklist_items WHERE id = ${targetId} FOR UPDATE
            `;
    const version = rows[0]?.version;
    if (version === undefined) {
      throw new Error(`folder ${targetKind} not found: ${targetId}`);
    }
    return Number(version);
  }

}

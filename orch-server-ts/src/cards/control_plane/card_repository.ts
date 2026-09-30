import { appendFolderOperation } from "../../folders/folder_operation_store.js";
import type {
  CardAssigneeFields,
  CardRow,
  CardStatus,
  FolderListRow,
  FolderOperationRow,
  FolderOperationTargetKind,
  FolderRow,
  FolderSnapshot,
  FolderStatus,
  SqlClient,
} from "./card_types.js";
import {
  asPostgresJsonValue,
  recordFromDb,
  type RepositorySql,
} from "./repository_helpers.js";
import type { FolderOperationActorKind } from "./card_types.js";
import { CardRepositoryRead } from "./card_repository_read.js";
import {
  type AppendFolderOperationTxParams,
  cleanPatch,
  normalizeOperation,
  requireOne,
  CardVersionConflict,
} from "./card_models.js";

type FolderPatch = Partial<Pick<FolderRow, "name" | "archived" | "checklist_enabled">>;
export class CardRepository extends CardRepositoryRead {
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

  private async assertVersionTx(
    sql: RepositorySql,
    targetKind: FolderOperationTargetKind,
    targetId: string,
    expectedVersion: number,
  ): Promise<void> {
    const actualVersion = await this.lockVersionTx(sql, targetKind, targetId);
    if (actualVersion !== expectedVersion) {
      throw new CardVersionConflict(
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
        : await sql<Array<{ version: string | number }>>`
              SELECT version FROM cards WHERE id = ${targetId} FOR UPDATE
            `;
    const version = rows[0]?.version;
    if (version === undefined) {
      throw new Error(`folder ${targetKind} not found: ${targetId}`);
    }
    return Number(version);
  }

}

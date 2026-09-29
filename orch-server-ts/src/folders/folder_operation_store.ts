import type { RepositorySql, FolderOperationRow } from "../tasks/control_plane/task_types.js";
import type { AppendFolderOperationTxParams } from "../tasks/control_plane/task_models.js";
import { normalizeOperation, requireOne } from "../tasks/control_plane/task_models.js";
import { asPostgresJsonValue } from "../tasks/control_plane/repository_helpers.js";

export async function appendFolderOperation(sql: RepositorySql, params: AppendFolderOperationTxParams): Promise<FolderOperationRow> {
    const rows = await sql<FolderOperationRow[]>`
      INSERT INTO folder_operations (
        id, folder_id, target_kind, target_id, operation_type,
        actor_kind, actor_session_id, actor_event_id, actor_user_id,
        idempotency_key, payload_json, reason
      )
      VALUES (
        ${params.id}, ${params.folderId}, ${params.targetKind}, ${params.targetId},
        ${params.operationType}, ${params.actorKind}, ${params.actorSessionId ?? null},
        ${params.actorEventId}, ${params.actorUserId ?? null}, ${params.idempotencyKey ?? null},
        ${sql.json(asPostgresJsonValue(params.payload))}::jsonb, ${params.reason ?? null}
      )
      RETURNING *
    `;
    return normalizeOperation(requireOne(rows, "appendOperationTx"));
}

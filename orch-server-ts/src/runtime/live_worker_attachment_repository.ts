import type { AttachmentReadRepository } from "../attachments/attachment_read_service.js";
import {
  type WorkerAttachmentDelivery,
  type WorkerAttachmentSession,
} from "../attachments/worker_attachment_access.js";
import type { LiveDbSqlResolver } from "./live_db_sql.js";
import { createLiveAttachmentReadRepository } from "./live_attachment_read_repository.js";

export type LiveWorkerAttachmentRepository = AttachmentReadRepository & {
  readonly findSession: (id: string) => Promise<WorkerAttachmentSession | null>;
  readonly findDelivery: (id: string) => Promise<WorkerAttachmentDelivery | null>;
};

export function createLiveWorkerAttachmentRepository(
  sqlResolver: LiveDbSqlResolver,
): LiveWorkerAttachmentRepository {
  const attachments = createLiveAttachmentReadRepository(sqlResolver);
  return {
    ...attachments,
    async findSession(id) {
      const sql = await sqlResolver.resolveSql();
      const rows = await sql`
        SELECT s.node_id, s.card_id, c.id AS assignee_card_id
        FROM sessions s
        LEFT JOIN cards c ON c.assignee_session_id = s.session_id
        WHERE s.session_id = ${id}
      `;
      if (rows.length === 0) return null;
      const first = rows[0]!;
      return {
        nodeId: requiredString(first.node_id),
        cardId: nullableString(first.card_id),
        assigneeCardIds: rows.flatMap((row) => {
          const cardId = nullableString(row.assignee_card_id);
          return cardId === null ? [] : [cardId];
        }),
      };
    },
    async findDelivery(id) {
      const sql = await sqlResolver.resolveSql();
      const rows = await sql`
        SELECT target_session_id, payload
        FROM session_deliveries
        WHERE delivery_id = ${id}
        LIMIT 1
      `;
      if (rows.length === 0) return null;
      return {
        targetSessionId: nullableString(rows[0]!.target_session_id),
        attachmentIds: attachmentIdsFromPayload(rows[0]!.payload),
      };
    },
  };
}

function attachmentIdsFromPayload(value: unknown): readonly string[] {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return [];
  const attachmentIds = (value as Record<string, unknown>).attachment_ids;
  return Array.isArray(attachmentIds) && attachmentIds.every((id) => typeof id === "string")
    ? attachmentIds
    : [];
}

function requiredString(value: unknown): string {
  if (typeof value !== "string") throw new Error("Invalid worker attachment database row");
  return value;
}

function nullableString(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

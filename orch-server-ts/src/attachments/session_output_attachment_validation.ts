import type { TrustedAttachmentProducer } from "../cards/card_attachment_policy.js";
import type { RepositorySql } from "../cards/control_plane/card_types.js";

type SessionOutputAttachmentRow = {
  readonly id: string;
  readonly owner_kind: string | null;
  readonly owner_key: string | null;
  readonly source_session_id: string | null;
  readonly source_node_id: string | null;
  readonly output_command_id: string | null;
  readonly storage_purpose: string;
  readonly upload_status: string;
  readonly garbage_collected_at: Date | string | null;
};

export function createSessionOutputAttachmentValidation(input: {
  readonly sql: RepositorySql;
}): (input: {
  readonly producer: TrustedAttachmentProducer;
  readonly attachmentIds: readonly string[];
}) => Promise<{ readonly attachment_ids: string[] }> {
  const { sql } = input;

  return async ({ producer, attachmentIds }) => {
    if (
      attachmentIds.length === 0
      || attachmentIds.some((attachmentId) => typeof attachmentId !== "string" || attachmentId.length === 0)
      || producer.outputCommandId.length === 0
    ) {
      throw validationError(422, "ATTACHMENT_INVALID_OUTPUT", "출력 첨부 ID가 필요합니다.");
    }

    const uniqueIds = [...new Set(attachmentIds)];
    const sessions = await sql<Array<{ readonly node_id: string | null }>>`
      SELECT node_id
      FROM sessions
      WHERE session_id = ${producer.sessionId}
      LIMIT 1
    `;
    if (sessions[0] === undefined || sessions[0].node_id !== producer.nodeId) {
      throw validationError(403, "ATTACHMENT_PRODUCER_MISMATCH", "첨부 생산 세션을 확인할 수 없습니다.");
    }

    const assets = await sql<SessionOutputAttachmentRow[]>`
      SELECT id, owner_kind, owner_key, source_session_id, source_node_id,
             output_command_id, storage_purpose, upload_status, garbage_collected_at
      FROM file_assets
      WHERE id = ANY(${sql.array(uniqueIds)}::text[])
    `;
    const byId = new Map(assets.map((asset) => [asset.id, asset]));

    for (const attachmentId of uniqueIds) {
      const asset = byId.get(attachmentId);
      if (
        asset === undefined
        || asset.garbage_collected_at !== null
        || asset.storage_purpose !== "attachment"
      ) {
        throw validationError(404, "ATTACHMENT_NOT_FOUND", "세션 출력 첨부를 찾을 수 없습니다.");
      }
      if (asset.upload_status !== "committed") {
        throw validationError(409, "ATTACHMENT_NOT_COMMITTED", "세션 출력 첨부가 아직 커밋되지 않았습니다.");
      }
      if (
        asset.owner_kind !== "agent_session"
        || asset.owner_key !== producer.sessionId
        || asset.source_session_id !== producer.sessionId
        || asset.source_node_id !== producer.nodeId
        || asset.output_command_id !== producer.outputCommandId
      ) {
        throw validationError(403, "ATTACHMENT_PRODUCER_MISMATCH", "첨부 생산 정보가 현재 출력과 일치하지 않습니다.");
      }
    }

    return { attachment_ids: uniqueIds };
  };
}

function validationError(statusCode: number, code: string, message: string): Error {
  return Object.assign(new Error(message), { statusCode, code });
}

import type { AttachmentAssetRow } from "../attachments/attachment_read_service.js";
import { attachmentScopeFromRegistrationScope } from "../attachments/attachment_read_service.js";
import { normalizedMimeType, previewInfo } from "../attachments/attachment_read_http.js";
import type { RepositorySql } from "./control_plane/card_types.js";

export type TrustedAttachmentProducer = { sessionId: string; nodeId: string; outputCommandId: string };
export type AttachmentLinkActor = { sessionId: string };

export async function assertAttachmentProducerTx(
  sql: RepositorySql,
  producer: TrustedAttachmentProducer,
  scope: { type: "card"; id: string } | null,
): Promise<void> {
  const sessions = await sql`
    SELECT node_id, card_id, execution_command_id
    FROM sessions
    WHERE session_id = ${producer.sessionId}
    LIMIT 1
  `;
  const session = sessions[0];
  if (
    session === undefined ||
    session.node_id !== producer.nodeId ||
    typeof session.execution_command_id !== "string" ||
    session.execution_command_id.length === 0 ||
    producer.outputCommandId.length === 0
  ) {
    throw attachmentError(403, "ATTACHMENT_PRODUCER_MISMATCH", "첨부를 등록한 실행 세션을 확인할 수 없습니다.");
  }
  if (scope === null) return;

  const cards = await sql`SELECT id, assignee_session_id FROM cards WHERE id = ${scope.id} LIMIT 1`;
  const card = cards[0];
  if (card === undefined) {
    throw attachmentError(404, "CARD_NOT_FOUND", "카드를 찾을 수 없습니다.");
  }
  if (card.assignee_session_id !== producer.sessionId && session.card_id !== scope.id) {
    throw attachmentError(403, "ATTACHMENT_CARD_SCOPE_DENIED", "이 카드에 첨부를 등록할 권한이 없습니다.");
  }
}

export async function requireCardAttachmentTx(
  sql: RepositorySql,
  card: { id: string; assignee_session_id: string | null },
  actor: AttachmentLinkActor,
  id: string,
  type: "image" | "link",
): Promise<AttachmentAssetRow> {
  if (typeof actor.sessionId !== "string" || actor.sessionId.length === 0) {
    throw attachmentError(401, "ATTACHMENT_UNAUTHENTICATED", "첨부를 연결할 호출 세션이 없습니다.");
  }

  const rows = await sql`
    SELECT id, storage_key, storage_purpose, storage_endpoint, storage_bucket,
           owner_kind, owner_key, registration_scope, source_session_id,
           original_name, mime_type, byte_size, width, height,
           checksum_sha256, upload_status
    FROM file_assets
    WHERE id = ${id} AND storage_purpose = 'attachment' AND garbage_collected_at IS NULL
    LIMIT 1
  `;
  const row = rows[0];
  if (row === undefined) {
    throw attachmentError(404, "ATTACHMENT_NOT_FOUND", "첨부를 찾을 수 없습니다.");
  }
  if (row.upload_status !== "committed") {
    throw attachmentError(409, "ATTACHMENT_NOT_COMMITTED", "아직 커밋되지 않은 첨부입니다.");
  }

  const ownerKind = nullableString(row.owner_kind);
  const ownerKey = nullableString(row.owner_key);
  const sourceSessionId = nullableString(row.source_session_id);
  if (ownerKind !== "agent_session" || ownerKey === null) {
    throw attachmentError(403, "ATTACHMENT_LINK_DENIED", "이 첨부를 카드에 연결할 수 없습니다.");
  }
  if (sourceSessionId !== null && sourceSessionId !== ownerKey) {
    throw attachmentError(403, "ATTACHMENT_LINK_DENIED", "첨부 생산자 정보가 일치하지 않습니다.");
  }

  const scope = attachmentScopeFromRegistrationScope(row.registration_scope);
  if (scope === null) {
    if (ownerKey !== card.assignee_session_id) {
      throw attachmentError(403, "ATTACHMENT_LINK_DENIED", "이 첨부를 카드에 연결할 수 없습니다.");
    }
  } else if (scope.type === "card" && scope.id === card.id) {
    if (ownerKey !== card.assignee_session_id) {
      const ownerSessions = await sql`
        SELECT session_id FROM sessions WHERE session_id = ${ownerKey} AND card_id = ${card.id} LIMIT 1
      `;
      if (ownerSessions.length === 0) {
        throw attachmentError(403, "ATTACHMENT_LINK_DENIED", "이 첨부를 카드에 연결할 수 없습니다.");
      }
    }
  } else {
    throw attachmentError(403, "ATTACHMENT_CARD_SCOPE_DENIED", "다른 범위에 등록된 첨부입니다.");
  }

  const assetId = requiredString(row.id);
  const mimeType = requiredString(row.mime_type);
  if (type === "image" && previewInfo(normalizedMimeType(mimeType)).kind !== "image") {
    throw attachmentError(422, "ATTACHMENT_IMAGE_REQUIRED", "이미지 첨부가 아닙니다.");
  }

  return {
    id: assetId,
    storageKey: requiredString(row.storage_key),
    storagePurpose: requiredString(row.storage_purpose),
    storageEndpoint: nullableString(row.storage_endpoint),
    storageBucket: nullableString(row.storage_bucket),
    ownerKind,
    ownerKey,
    registrationScope: row.registration_scope,
    sourceSessionId,
    originalName: requiredString(row.original_name),
    mimeType,
    byteSize: Number(row.byte_size),
    width: nullableNumber(row.width),
    height: nullableNumber(row.height),
    checksumSha256: nullableString(row.checksum_sha256),
    uploadStatus: "committed",
  };
}

function attachmentError(statusCode: number, code: string, message: string): Error {
  return Object.assign(new Error(message), { statusCode, code });
}

function requiredString(value: unknown): string {
  if (typeof value !== "string") throw new Error("Invalid attachment database row");
  return value;
}

function nullableString(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function nullableNumber(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  const number = Number(value);
  return Number.isSafeInteger(number) ? number : null;
}

import { randomUUID } from "node:crypto";

import type { MultipartFile } from "../http/multipart_form.js";
import { AttachmentUploadHttpError } from "../attachments/attachment_upload_http.js";
import { legacyOwnedUploadCache, type AttachmentRouteOptions } from "../attachments/attachment_routes.js";
import { finishLegacyUpload } from "../attachments/attachment_upload_legacy.js";
import type { CardCommentAttachmentUploader } from "../folders/folder_routes.js";

// 카드 커멘트에 붙인 인라인 첨부를 저장하고 카드 첨부 파이프라인이 해석하는 legacy
// 파일 URL을 돌려준다. 인증된 사용자의 첨부는 R2에 소유자로 커밋한 뒤 노드 캐시와
// 별칭을 채우고, 인증 주체가 없는 호출은 기존 노드 캐시 경로만 쓴다.
export function createCardCommentAttachmentUploader(
  attachments: AttachmentRouteOptions,
): CardCommentAttachmentUploader {
  return async (request, input) => {
    const content = Buffer.from(input.file.data_base64, "base64");
    const file: MultipartFile = {
      filename: input.file.name.replace(/[\\/]/g, "_"),
      contentType: input.file.mime || "application/octet-stream",
      content,
    };
    const nodeId = input.nodeId ?? "eiaserinnys";
    const uploads = attachments.assetUpload;
    const actor = uploads === undefined ? null : await uploads.resolveActor(request);
    if (uploads === undefined || actor === null) {
      const sessionId = input.sessionId ?? input.cardId;
      const cached = await legacyOwnedUploadCache(attachments, nodeId, sessionId, file);
      return { url: legacyAttachmentUrl(nodeId, readCachedPath(cached)), name: input.file.name, mime: file.contentType };
    }
    const sessionId = input.sessionId !== null && input.sessionId.trim() !== "" ? input.sessionId : randomUUID();
    const registration = await uploads.requireRegistration(request, {
      actor, sessionId, folderId: input.folderId, mode: "legacy", small: true,
    });
    const committed = await uploads.commits.putSmall({
      spec: {
        attachmentId: input.uploadId,
        owner: { kind: "user_email", key: actor.email },
        registration,
        originalName: input.file.name,
        mimeType: file.contentType,
        byteSize: content.length,
      },
      body: content,
    });
    const legacy = await finishLegacyUpload({
      committed,
      nodeId,
      repository: uploads.repository,
      cache: () => legacyOwnedUploadCache(attachments, nodeId, sessionId, file),
    });
    return { url: legacyAttachmentUrl(nodeId, legacy.path), name: input.file.name, mime: file.contentType };
  };
}

function legacyAttachmentUrl(nodeId: string, path: string): string {
  const params = new URLSearchParams();
  params.set("nodeId", nodeId);
  params.set("path", path);
  return "/api/attachments/files?" + params.toString();
}

function readCachedPath(value: unknown): string {
  if (typeof value === "object" && value !== null && !Array.isArray(value)) {
    const path = (value as Record<string, unknown>).path;
    if (typeof path === "string" && path.length > 0) return path;
  }
  throw new AttachmentUploadHttpError(502, "malformed_upload_response", "첨부 노드가 올바른 업로드 응답을 주지 않았습니다");
}

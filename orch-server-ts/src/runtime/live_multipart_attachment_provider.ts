import type { MultipartAttachmentOptions } from "../attachments/multipart_attachment_routes.js";
import type { SessionResourceAccessProvider, SessionResourceAccessRepository } from "../session/session_resource_access.js";
import type { LiveConfigProviderBoundary } from "./live_provider_dependencies.js";
import { sendAttachmentCommand, type LiveAttachmentCommandRegistry, type LiveAttachmentCommandBridge } from "./live_attachment_route_provider.js";

export function createLiveMultipartAttachmentOptions(input: {
  resolveStorage: MultipartAttachmentOptions["resolveStorage"];
  resolveEmail: MultipartAttachmentOptions["resolveEmail"];
  configProvider: LiveConfigProviderBoundary;
  repository: SessionResourceAccessRepository;
  access: SessionResourceAccessProvider;
  registry: LiveAttachmentCommandRegistry;
  bridge: LiveAttachmentCommandBridge;
}): MultipartAttachmentOptions {
  function node(nodeId: string) {
    const snapshot = input.registry.getConnectedNode(nodeId);
    if (!snapshot) throw new Error("첨부 대상 노드가 연결되지 않았습니다");
    return snapshot;
  }
  return {
    resolveStorage: input.resolveStorage,
    resolveEmail: input.resolveEmail,
    async resolveSecret() {
      const secret = await input.configProvider.requireConfig("jwt_secret");
      if (typeof secret !== "string" || !secret) throw new Error("jwt_secret must be configured");
      return secret;
    },
    async requireAccess(request, sessionId, folderId) {
      const existing = await input.repository.getSessionAccessRecord(sessionId);
      if (existing) {
        await input.access.requireSessionAccess({ request, sessionId });
      } else {
        // Pre-session uploads belong to the authenticated ticket subject and
        // the currently selected folder, never caller_info supplied by a client.
        if (!/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(sessionId) || !folderId) {
          throw Object.assign(new Error("새 세션 첨부에는 임시 UUID와 폴더가 필요합니다"), { statusCode: 400 });
        }
        await input.access.requireFolderAccess({ request, folderId });
      }
    },
    async getNode(nodeId) { return input.registry.getConnectedNode(nodeId) ?? null; },
    async abortImport(nodeId, uploadId) {
      return sendAttachmentCommand(input, node(nodeId), { type: "upload_attachment_abort", upload_id: uploadId }, 5_000);
    },
    async importAttachment(nodeId, params, signal) {
      signal.throwIfAborted();
      const snapshot = node(nodeId);
      const abort = () => {
        void sendAttachmentCommand(input, snapshot, { type: "upload_attachment_abort", upload_id: params.uploadId }, 5_000).catch(() => undefined);
      };
      signal.addEventListener("abort", abort, { once: true });
      try {
        return await sendAttachmentCommand(input, snapshot, {
          type: "import_attachment_from_url", upload_id: params.uploadId,
          session_id: params.sessionId, filename: params.filename, content_type: params.contentType,
          expected_size: params.expectedSize, download_url: params.downloadUrl,
        }, 300_000);
      } catch (error) {
        abort();
        throw error;
      } finally { signal.removeEventListener("abort", abort); }
    },
  };
}

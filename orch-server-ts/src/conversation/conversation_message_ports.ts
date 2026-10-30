import path from "node:path";
import { ConversationError } from "./conversation_types.js";
import type { SqlClient } from "../control_plane/control_plane_types.js";
import { legacyOwnedUploadCache, type AttachmentRouteOptions } from "../attachments/attachment_routes.js";
import { finishLegacyUpload } from "../attachments/attachment_upload_legacy.js";
import { normalizeAttachmentLegacyPath } from "../attachments/attachment_read_service.js";
import { executeSessionIntervention, type SessionActionCommandRouteOptions } from "../session/session_action_command_routes.js";
import type { MessagePorts } from "./conversation_messages.js";

export function createConversationMessagePorts(sql:SqlClient, attachments:AttachmentRouteOptions, commands:SessionActionCommandRouteOptions):MessagePorts {
  async function node(session:string):Promise<string> {
    const [row] = await sql<Array<{node_id:string|null}>>`SELECT node_id FROM sessions WHERE session_id=${session}`;
    if (!row?.node_id) throw new Error("Session node unavailable");
    return row.node_id;
  }
  return {
    async caller(request,session) {
      if (!commands.resolveCallerInfo) throw new Error("Caller identity unavailable");
      return await commands.resolveCallerInfo(request,undefined,session);
    },
    async upload(request,session,file,uploadId) {
      const options = attachments.assetUpload;
      if (!options) throw new Error("Attachment upload unavailable");
      const actor = await options.resolveActor(request);
      if (!actor) throw new Error("Attachment actor unavailable");
      const nodeId = await node(session);
      const registration = await options.requireRegistration(request,{actor,sessionId:session,folderId:null,mode:"legacy",small:true});
      const content = Buffer.from(file.data_base64,"base64");
      const filename = file.name.replace(/[\\/]/g,"_");
      const mime = file.mime || "application/octet-stream";
      const committed = await options.commits.putSmall({spec:{attachmentId:uploadId,owner:{kind:"user_email",key:actor.email},registration,
        originalName:file.name,mimeType:mime,byteSize:content.length},body:content});
      const legacy = await finishLegacyUpload({committed,nodeId,repository:options.repository,
        cache:() => legacyOwnedUploadCache(attachments,nodeId,session,{filename,contentType:mime,content})});
      return {path:legacy.path,name:file.name,mime,assetId:committed.attachmentId};
    },
    intervene:(request,session,body,caller) => executeSessionIntervention({...commands,resolveCallerInfo:() => caller},request,session,body),
    async read(request,session,attachment) {
      const read = attachments.assetRead;
      if (!read) throw new Error("Attachment read unavailable");
      const actor = await read.resolveActor(request);
      const context = {type:"session" as const,id:session};
      if (attachment.assetId) return await read.service.content(actor,attachment.assetId,context,{method:"GET"});
      if (!attachment.path) throw new Error("Attachment missing");
      const nodeId = await node(session);
      try {
        const result = await read.service.legacy(async () => actor,nodeId,normalizeAttachmentLegacyPath(attachment.path),context,{method:"GET"});
        if (result.kind === "response") return result.response;
      } catch (error) {
        // Old path-only events have no asset-id evidence for the generic reader.
        // The facade has already verified this exact path belongs to an accessible item.
        if (typeof error !== "object" || error === null || !("statusCode" in error) || error.statusCode !== 403) throw error;
      }
      // Match the legacy route's session directory check before asking the node.
      const normalized = normalizeAttachmentLegacyPath(attachment.path);
      if (path.posix.basename(path.posix.dirname(normalized)) !== session) {
        throw new ConversationError(404,"not_found","Attachment not found");
      }
      const target = await attachments.provider.getNode(nodeId);
      if (!target) throw new Error("Attachment node unavailable");
      const raw = await attachments.transport.downloadAttachment(target,attachment.path);
      if (!raw || typeof raw !== "object" || typeof (raw as {content_b64?:unknown}).content_b64 !== "string") throw new Error("Attachment unavailable");
      return new Response(Buffer.from((raw as {content_b64:string}).content_b64,"base64"));
    },
  };
}

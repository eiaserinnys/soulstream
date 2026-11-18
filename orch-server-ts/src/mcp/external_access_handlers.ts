import { errorResult, jsonResult } from "@soulstream/mcp-contract";
import { writeExternalReply } from "../external_access/external_reply_service.js";
import type { McpToolHandler } from "./types.js";

/** Reply tool for external requests (design 2.3). The caller is the authenticated context. */
export const externalAccessHandlers = {
  reply_to_external_request: async (options, args, context) => {
    if (context.principal !== "internal") return errorResult("internal_principal_required");
    const callerSessionId = context.callerSessionId;
    if (!callerSessionId) return errorResult("authenticated_sender_session_required");
    if (!options.externalAccess) return errorResult("external_access_unavailable");
    const result = await writeExternalReply(
      options.externalAccess.sql,
      {
        callerSessionId,
        requestHandle: args.request_handle as string,
        text: args.text as string | undefined,
        final: args.final as boolean,
      },
      options.cluster.logger,
    );
    if (!result.ok) return errorResult(result.reason);
    return jsonResult({
      reply_id: result.reply_id,
      request_handle: result.request_handle,
      final: result.final,
      at: result.at,
    });
  },
} satisfies Record<string, McpToolHandler>;

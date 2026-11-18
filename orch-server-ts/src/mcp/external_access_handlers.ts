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
    // A reply may be what a pending status long poll is waiting for. The
    // signal is in-process and optional; the reply is already stored either way.
    const separator = result.request_handle.indexOf(":");
    if (separator > 0) {
      options.externalAccess.replySignal?.notify(
        result.request_handle.slice(0, separator),
        result.request_handle.slice(separator + 1),
      );
    }
    return jsonResult({
      reply_id: result.reply_id,
      request_handle: result.request_handle,
      final: result.final,
      at: result.at,
    });
  },
} satisfies Record<string, McpToolHandler>;

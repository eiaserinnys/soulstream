import { jsonResult, errorResult } from "@soulstream/mcp-contract";
import type { McpToolHandler } from "./types.js";

export const externalLlmHandlers = {
  list_external_llm_recipients: async (options, _args, context) => {
    if (context.principal !== "internal") return errorResult("internal_principal_required");
    return jsonResult({ recipients: options.externalLlm?.service?.allRecipients() ?? [] });
  },
  send_to_external_llm: async (options, args, context) => {
    if (context.principal !== "internal") return errorResult("internal_principal_required");
    const sender = context.callerSessionId;
    if (!sender || !(await options.externalLlm?.getSession(sender))) return errorResult("authenticated_sender_session_required");
    if (!options.externalLlm?.service) return jsonResult({ ok: false, status: "not_sent", reason: "no_active_recipient" });
    try { return jsonResult(await options.externalLlm.service.sendToRecipient(args.recipient_id as string, args.text as string, sender, args.title as string | undefined)); }
    catch { return errorResult("external_events_state_save_failed"); }
  },
} satisfies Record<string, McpToolHandler>;

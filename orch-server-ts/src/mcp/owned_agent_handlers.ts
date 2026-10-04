import { OwnedAgentError } from "../owned-agents/types.js";
import { errorResult, jsonResult } from "@soulstream/mcp-contract";
import type { McpToolHandler } from "./types.js";
export const ownedAgentHandlers = {
  register_existing_mcp_agent: async (options, args, context) => {
    if (context.principal !== "internal") return errorResult("internal_principal_required");
    const explicit = typeof args.caller_session_id === "string" ? args.caller_session_id.trim() : "";
    if (explicit && context.callerSessionId && explicit !== context.callerSessionId) return errorResult("caller_session_id does not match authenticated session");
    const id = context.callerSessionId || explicit;
    if (!id || !options.resolveSessionOwner || !options.ownedAgents) return errorResult("Durable caller identity and owned-agent management are required");
    try {
      const owner = await options.resolveSessionOwner(id);
      if (!owner) return errorResult("Verified session owner required");
      return jsonResult(await options.ownedAgents.registerExisting(owner.ownerEmail, args.name as string | undefined));
    } catch (error) { return errorResult(error instanceof OwnedAgentError ? `${error.statusCode}: ${error.message}` : "Existing connection registration temporarily unavailable"); }
  },
} satisfies Record<string, McpToolHandler>;

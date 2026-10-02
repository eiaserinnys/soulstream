import { STATUS_CODES } from "node:http";
import { cardOrchestrationTools, errorResult, jsonResult, readOrchErrorEnvelopeText, type CallToolResult } from "@soulstream/mcp-contract";
import { parseOrchestrationPolicy } from "@soulstream/wire-schema/card-orchestration";
import { executeCardOrchestrationHostOperation } from "../cards/card_orchestration_routes.js";
import type { McpCallContext, McpHostOptions } from "./types.js";

type Args = Record<string, unknown>;
type Handler = (options: McpHostOptions, args: Args, context: McpCallContext) => Promise<CallToolResult>;
const invoke = (operation: "get" | "update"): Handler => async (options, args, context) => {
  const body = operation === "update" ? { expectedVersion: args.expectedVersion, policy: parseOrchestrationPolicy(args.policy) } : {};
  if (context.principal === "external") return errorResult("Untrusted external callers cannot access card orchestration settings");
  const explicit = typeof args.caller_session_id === "string" ? args.caller_session_id.trim() : "";
  if (context.callerSessionId && explicit && explicit !== context.callerSessionId)
    return errorResult("caller_session_id must match the authenticated request session header");
  const callerSessionId = context.callerSessionId ?? (explicit || undefined);
  if (!callerSessionId) return errorResult("A trusted persisted caller session is required");
  try {
    const response = await executeCardOrchestrationHostOperation(options.cardOrchestration, operation, { ...body, callerSessionId });
    const serialized = JSON.parse(JSON.stringify(response.body));
    if (response.status !== 200) {
      const detail = readOrchErrorEnvelopeText({ status: response.status, statusText: STATUS_CODES[response.status] ?? "" }, JSON.stringify(serialized));
      return errorResult(`${detail.code ?? response.status}: ${detail.message}`);
    }
    return jsonResult(serialized);
  } catch (error) { return errorResult(error instanceof Error ? error.message : String(error)); }
};
export const cardOrchestrationHandlers = {
  get_card_orchestration_settings: invoke("get"),
  update_card_orchestration_settings: invoke("update"),
} satisfies Record<keyof typeof cardOrchestrationTools, Handler>;

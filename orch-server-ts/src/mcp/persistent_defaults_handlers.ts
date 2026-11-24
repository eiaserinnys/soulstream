import { ORCHESTRATION_DECISION_PURPOSE } from "@soulstream/wire-schema/card-orchestration";
import { errorResult, jsonResult, persistentDefaultsTools } from "@soulstream/mcp-contract";
import type { McpCallContext, McpHostOptions, McpToolHandler } from "./types.js";

const invoke = (operation: "get" | "update"): McpToolHandler => async (options: McpHostOptions, args: Record<string, unknown>, context: McpCallContext) => {
  if (context.principal !== "internal") return errorResult("Untrusted external callers cannot access persistent defaults");
  const callerId = context.callerSessionId?.trim();
  if (!callerId || !options.persistentDefaults) return errorResult("A trusted persisted caller session is required");
  try {
    const caller = await options.persistentDefaults.resolveCaller(callerId);
    const email = caller?.ownerEmail?.trim().toLowerCase();
    if (!email || caller?.purpose === ORCHESTRATION_DECISION_PURPOSE || !(await options.persistentDefaults.isAdminEmail(email)))
      return errorResult("Verified administrator session required");
    const result = operation === "get" ? await options.persistentDefaults.service.get()
      : await options.persistentDefaults.service.put({ value: args.value, expectedVersion: args.expectedVersion as number, updatedBy: email });
    return jsonResult(result);
  } catch (error) { return errorResult(error instanceof Error ? error.message : String(error)); }
};
export const persistentDefaultsHandlers = {
  get_persistent_session_defaults: invoke("get"),
  update_persistent_session_defaults: invoke("update"),
} satisfies Record<keyof typeof persistentDefaultsTools, McpToolHandler>;

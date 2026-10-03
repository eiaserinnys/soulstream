import { cardOrchestrationTools } from "@soulstream/mcp-contract";
import { registerOrchestratorTools } from "../orchestrator_tools.js";
export function registerCardOrchestrationTools(server: McpServer, runtime: McpRuntime): void {
  registerOrchestratorTools(server, runtime, Object.values(cardOrchestrationTools), Object.fromEntries(Object.keys(cardOrchestrationTools).map(name => [name,
    (args: Record<string, unknown>) => {
      if (runtime.orch) return {};
      const caller = resolveSettingsCaller(runtime, args.caller_session_id as string | undefined);
      return errorResult(caller.error ?? "Orchestrator is not configured");
    },
  ])));
}
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  isCurrentMcpCallerExternal,
  getCurrentMcpCallerSessionId,
} from "../request_context.js";
import { errorResult } from "../result.js";
import type { McpRuntime } from "../runtime.js";
import { resolveMcpCallerAttribution } from "./caller_session.js";
function resolveSettingsCaller(runtime: McpRuntime, explicitSessionId: string | undefined): { error?: string; callerSessionId?: string } {
  if (isCurrentMcpCallerExternal()) return { error: "Untrusted external callers cannot access card orchestration settings" };
  const headerSessionId = getCurrentMcpCallerSessionId();
  if (
    headerSessionId &&
    explicitSessionId?.trim() &&
    explicitSessionId.trim() !== headerSessionId
  ) {
    return { error: "caller_session_id must match the authenticated request session header" };
  }
  const attribution = resolveMcpCallerAttribution(
    runtime,
    headerSessionId ?? explicitSessionId,
  );
  if (!attribution.callerSessionId)
    return { error: "A trusted persisted caller session is required" };
  return { callerSessionId: attribution.callerSessionId };
}

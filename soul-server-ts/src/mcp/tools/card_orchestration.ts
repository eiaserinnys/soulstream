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
import { parseOrchestrationPolicy } from "@soulstream/wire-schema/card-orchestration";
import {
  PersistenceHostTransport,
  readOrchErrorEnvelope,
} from "../../control_plane/persistence_host_transport.js";
import {
  isCurrentMcpCallerExternal,
  getCurrentMcpCallerSessionId,
} from "../request_context.js";
import { errorResult, jsonResult } from "../result.js";
import type { McpRuntime } from "../runtime.js";
import { resolveMcpCallerAttribution } from "./caller_session.js";
export function registerCardOrchestrationToolsLegacy(
  server: McpServer,
  runtime: McpRuntime,
): void {
  server.registerTool(
    "get_card_orchestration_settings",
    cardOrchestrationTools.get_card_orchestration_settings.config,
    async ({ caller_session_id }) =>
      call(runtime, caller_session_id, "get", {}),
  );
  server.registerTool(
    "update_card_orchestration_settings",
    cardOrchestrationTools.update_card_orchestration_settings.config,
    async ({ caller_session_id, expectedVersion, policy }) =>
      call(runtime, caller_session_id, "update", {
        expectedVersion,
        policy: parseOrchestrationPolicy(policy),
      }),
  );
}
async function call(
  runtime: McpRuntime,
  explicitSessionId: string | undefined,
  operation: "get" | "update",
  body: Record<string, unknown>,
) {
  const caller = resolveSettingsCaller(runtime, explicitSessionId);
  if (caller.error) return errorResult(caller.error);
  if (!runtime.orch) return errorResult("Orchestrator is not configured");
  try {
    const response = await new PersistenceHostTransport({
      orch: runtime.orch,
      logger: runtime.logger,
    }).send("POST", `/api/card-orchestration/host/${operation}`, {
      ...body,
      callerSessionId: caller.callerSessionId,
    });
    if (!response.ok) {
      const error = await readOrchErrorEnvelope(response);
      return errorResult(`${error.code ?? response.status}: ${error.message}`);
    }
    return jsonResult(await response.json());
  } catch (error) {
    return errorResult(error instanceof Error ? error.message : String(error));
  }
}
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

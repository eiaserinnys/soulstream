import { cardOrchestrationTools } from "@soulstream/mcp-contract";
import { registerOrchestratorTools } from "../orchestrator_tools.js";
export function registerCardOrchestrationTools(server: McpServer, runtime: McpRuntime): void {
  registerOrchestratorTools(server, runtime, Object.values(cardOrchestrationTools), {});
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
  if (isCurrentMcpCallerExternal())
    return errorResult(
      "Untrusted external callers cannot access card orchestration settings",
    );
  const headerSessionId = getCurrentMcpCallerSessionId();
  if (
    headerSessionId &&
    explicitSessionId?.trim() &&
    explicitSessionId.trim() !== headerSessionId
  ) {
    return errorResult(
      "caller_session_id must match the authenticated request session header",
    );
  }
  const attribution = resolveMcpCallerAttribution(
    runtime,
    headerSessionId ?? explicitSessionId,
  );
  if (!attribution.callerSessionId)
    return errorResult("A trusted persisted caller session is required");
  if (!runtime.orch) return errorResult("Orchestrator is not configured");
  try {
    const response = await new PersistenceHostTransport({
      orch: runtime.orch,
      logger: runtime.logger,
    }).send("POST", `/api/card-orchestration/host/${operation}`, {
      ...body,
      callerSessionId: attribution.callerSessionId,
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

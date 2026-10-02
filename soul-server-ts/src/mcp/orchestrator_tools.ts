import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { errorResult, type CallToolResult, type McpToolDefinition } from "@soulstream/mcp-contract";
import { fetchOrchResponse, readOrchErrorEnvelope } from "../control_plane/persistence_host_transport.js";
import { getCurrentMcpCallerPrincipal, getCurrentMcpCallerSessionId } from "./request_context.js";
import type { McpRuntime } from "./runtime.js";

export function registerOrchestratorTools(
  server: McpServer,
  runtime: McpRuntime,
  definitions: readonly McpToolDefinition[],
): void {
  for (const definition of definitions) {
    server.registerTool(definition.name, definition.config, async (args) => {
      if (!runtime.orch) return errorResult("orchestrator is not configured");
      try {
        const response = await fetchOrchResponse(runtime.orch, "POST", `/api/mcp/host/${definition.name}`, {
          args,
          context: {
            principal: getCurrentMcpCallerPrincipal()?.authority === "external" ? "external" : "internal",
            caller_session_id: getCurrentMcpCallerSessionId() ?? null,
            node_id: runtime.nodeId,
          },
        });
        if (response.status !== 200) return errorResult((await readOrchErrorEnvelope(response)).message);
        return await response.json() as CallToolResult;
      } catch (error) {
        return errorResult(error instanceof Error ? error.message : String(error));
      }
    });
  }
}

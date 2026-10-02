import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { errorResult, errorResultFromError, type CallToolResult, type McpToolDefinition } from "@soulstream/mcp-contract";
import { fetchOrchResponse, readOrchErrorEnvelope } from "../control_plane/persistence_host_transport.js";
import { getCurrentMcpCallerPrincipal, getCurrentMcpCallerSessionId, isCurrentMcpCallerExternal } from "./request_context.js";
import type { McpRuntime } from "./runtime.js";

export type McpForwardContext = { execution?: { registrationId: string; executionCommandId: string } };
export type McpForwardPreprocessor = (args: Record<string, unknown>) =>
  McpForwardContext | CallToolResult | Promise<McpForwardContext | CallToolResult>;

export function registerOrchestratorTools(
  server: McpServer,
  runtime: McpRuntime,
  definitions: readonly McpToolDefinition[],
  preprocessors: Readonly<Record<string, McpForwardPreprocessor>> = {},
): void {
  for (const definition of definitions) {
    const config = isCurrentMcpCallerExternal() && definition.externalInputSchema
      ? { ...definition.config, inputSchema: definition.externalInputSchema } : definition.config;
    server.registerTool(definition.name, config, async (args) => {
      try {
        const extra = await preprocessors[definition.name]?.(args);
        if (extra && "content" in extra) return extra;
        if (!runtime.orch) return errorResult("orchestrator is not configured");
        const response = await fetchOrchResponse(runtime.orch, "POST", `/api/mcp/host/${definition.name}`, {
          args,
          context: {
            principal: getCurrentMcpCallerPrincipal()?.authority === "external" ? "external" : "internal",
            caller_session_id: getCurrentMcpCallerSessionId() ?? null,
            node_id: runtime.nodeId,
            ...extra,
          },
        });
        if (response.status !== 200) return errorResult((await readOrchErrorEnvelope(response)).message);
        return await response.json() as CallToolResult;
      } catch (error) {
        return preprocessors[definition.name] ? errorResultFromError(error)
          : errorResult(error instanceof Error ? error.message : String(error));
      }
    });
  }
}

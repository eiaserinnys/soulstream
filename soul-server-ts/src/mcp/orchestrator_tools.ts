import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { errorResult, errorResultFromError, type CallToolResult, type McpToolDefinition } from "@soulstream/mcp-contract";
import { fetchOrchResponse, readOrchErrorEnvelope } from "../control_plane/persistence_host_transport.js";
import { getCurrentMcpCallerSessionId } from "./request_context.js";
import type { McpRuntime } from "./runtime.js";
import { z } from "zod";

export type McpForwardContext = { callerInfo?: Record<string, unknown>; execution?: { registrationId: string; executionCommandId: string } };
export type McpForwardPreprocessor = (args: Record<string, unknown>) =>
  McpForwardContext | CallToolResult | Promise<McpForwardContext | CallToolResult>;

export function registerOrchestratorTools(
  server: McpServer,
  runtime: McpRuntime,
  definitions: readonly McpToolDefinition[],
  preprocessors: Readonly<Record<string, McpForwardPreprocessor>> = {},
): void {
  for (const definition of definitions) {
    const handler = async (args: Record<string, unknown>, request: { signal?: AbortSignal }) => {
      try {
        const extra = await preprocessors[definition.name]?.(args);
        if (extra && "content" in extra) return extra;
        return await forwardOrchestratorTool(runtime, definition, args, extra, request.signal);
      } catch (error) {
        return preprocessors[definition.name] ? errorResultFromError(error)
          : errorResult(error instanceof Error ? error.message : String(error));
      }
    };
    if ("strictInputSchema" in definition && definition.strictInputSchema) {
      server.registerTool(definition.name, {
        ...definition.config,
        inputSchema: z.object(definition.config.inputSchema).strict(),
      }, handler);
    } else {
      server.registerTool(definition.name, definition.config, handler);
    }
  }
}

/** Shared by forwarding registrations and the local delete tool's ownership relay. */
export async function forwardOrchestratorTool(
  runtime: McpRuntime,
  definition: McpToolDefinition,
  args: Record<string, unknown>,
  extra?: McpForwardContext,
  signal?: AbortSignal,
): Promise<CallToolResult> {
  if (!runtime.orch) return errorResult("orchestrator is not configured");
  const response = await fetchOrchResponse(runtime.orch, "POST", `/api/mcp/host/${definition.name}`, {
    args,
    context: {
      principal: "internal",
      caller_session_id: getCurrentMcpCallerSessionId() ?? null,
      node_id: runtime.nodeId,
      ...extra,
    },
  }, { timeoutMs: definition.timeoutMs, signal });
  if (response.status !== 200) {
    const detail = await readOrchErrorEnvelope(response);
    return errorResult(detail.message);
  }
  return await response.json() as CallToolResult;
}

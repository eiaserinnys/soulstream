import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { mcpToolDefinitions, LIVE_CARD_RESOURCE, errorResult } from "@soulstream/mcp-contract";
import { widgetHtml } from "../../../plugins/chatgpt-card-renderer/src/widget-html.js";
import { executeMcpTool } from "./tool_executor.js";
import type { McpCallContext, McpHostOptions } from "./types.js";

/** Same raw argument guard as the worker, before SDK schema validation. */
export function guardExternalToolCall(name: string, args: unknown) {
  if (name === "batch_page_operations" && args && typeof args === "object"
    && "operations" in args && Array.isArray(args.operations)
    && args.operations.some(op => op && typeof op === "object" && op.op === "delete_block_subtree")) {
    return errorResult(`MCP tool "${name}" is not available to external LLM callers`);
  }
  return undefined;
}

export function buildExternalMcpServer(options: McpHostOptions, context: McpCallContext) {
  const server = new McpServer({ name: "soul-server-ts", version: "0.0.1" });
  for (const definition of mcpToolDefinitions) {
    if (definition.audience !== "all") continue;
    const externalInputSchema = "externalInputSchema" in definition ? definition.externalInputSchema : undefined;
    const config = externalInputSchema ? { ...definition.config, inputSchema: externalInputSchema } : definition.config;
    server.registerTool(definition.name, config, args => executeMcpTool(options, definition.name, args, context));
  }
  server.registerResource("soulstream-live-cards", LIVE_CARD_RESOURCE, {}, async () => ({ contents: [{
    uri: LIVE_CARD_RESOURCE, mimeType: "text/html;profile=mcp-app", text: widgetHtml,
    _meta: { ui: { prefersBorder: true, csp: { connectDomains: [], resourceDomains: [] } } },
  }] }));
  return server;
}

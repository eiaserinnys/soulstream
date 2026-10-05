import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { mcpToolDefinitions, recurringJobTools, LIVE_CARD_RESOURCE, errorResult, callWithReferenceTranslation } from "@soulstream/mcp-contract";
import { isFolderAllowed, normalizeAccess } from "../folders/folder_route_access.js";
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

/** Card numbers resolve only inside the folders this credential may see; any other card answers as "no such number". */
async function resolveReferencesForExternal(options: McpHostOptions, refs: string[]) {
  const [service, access, folders] = await Promise.all([
    options.cards.cardServiceProvider!(), options.cards.resolveAccess(), options.cards.provider.listFolders(),
  ]);
  const normalized = normalizeAccess(access);
  return service.resolveReferences(refs, folderId => isFolderAllowed(normalized, folders, folderId));
}

export function buildExternalMcpServer(options: McpHostOptions, context: McpCallContext) {
  const server = new McpServer({ name: "soul-server-ts", version: "0.0.1" });
  for (const definition of mcpToolDefinitions) {
    if (definition.audience !== "all" && !(context.ownedAgent && definition.name in recurringJobTools)) continue;
    const externalInputSchema = "externalInputSchema" in definition ? definition.externalInputSchema : undefined;
    const inputSchema = externalInputSchema ?? definition.config.inputSchema;
    const config = definition.name in recurringJobTools
      ? { ...definition.config, inputSchema: Object.fromEntries(Object.entries(inputSchema).filter(([key]) => key !== "caller_session_id")) }
      : externalInputSchema ? { ...definition.config, inputSchema: externalInputSchema } : definition.config;
    server.registerTool(definition.name, config, args => callWithReferenceTranslation(args, refs => resolveReferencesForExternal(options, refs),
      translated => executeMcpTool(options, definition.name, translated, context)));
  }
  server.registerResource("soulstream-live-cards", LIVE_CARD_RESOURCE, {}, async () => ({ contents: [{
    uri: LIVE_CARD_RESOURCE, mimeType: "text/html;profile=mcp-app", text: widgetHtml,
    _meta: { ui: { prefersBorder: true, csp: { connectDomains: [], resourceDomains: [] } } },
  }] }));
  return server;
}

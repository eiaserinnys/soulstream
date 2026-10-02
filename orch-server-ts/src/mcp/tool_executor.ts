import { z } from "zod";
import { mcpToolDefinitions, errorResult, type McpToolName } from "@soulstream/mcp-contract";
import type { McpCallContext, McpHostOptions, McpToolHandler } from "./types.js";
import { folderObjectHandlers } from "./folder_object_handlers.js";
import { cardHandlers } from "./card_handlers.js";

export const mcpToolHandlers = {
  ...folderObjectHandlers,
  ...cardHandlers,
} satisfies Record<McpToolName, McpToolHandler>;

export function findMcpTool(name: string) {
  return mcpToolDefinitions.find(definition => definition.name === name);
}

export async function executeMcpTool(options: McpHostOptions, name: McpToolName, args: Record<string, unknown>, context: McpCallContext) {
  const definition = findMcpTool(name)!;
  try {
    const schema: z.ZodRawShape = definition.config.inputSchema;
    const input = z.object(schema).parse(args);
    return await mcpToolHandlers[name](options, input, context);
  } catch (error) { return errorResult(error instanceof Error ? error.message : String(error)); }
}

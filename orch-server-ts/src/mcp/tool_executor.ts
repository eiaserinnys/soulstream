import { sessionMessageHandlers } from "./session_message_handlers.js";
import { externalLlmHandlers } from "./external_llm_handlers.js";
import { clusterHandlers } from "./cluster_handlers.js";
import { cardOrchestrationHandlers } from "./card_orchestration_handlers.js";
import { ownedAgentHandlers } from "./owned_agent_handlers.js";
import { recurringJobHandlers } from "./recurring_job_handlers.js";
import { z } from "zod";
import { mcpToolDefinitions, errorResult, type McpToolName } from "@soulstream/mcp-contract";
import type { McpCallContext, McpHostOptions, McpToolHandler } from "./types.js";
import { folderObjectHandlers } from "./folder_object_handlers.js";
import { boardHandlers } from "./board_handlers.js";
import { sessionHandlers } from "./session_handlers.js";
import { cardHandlers } from "./card_handlers.js";
import { pageHandlers } from "./page_handlers.js";
import { liveCardHandlers } from "./live_card_handlers.js";
import { skillHandlers } from "./skill_handlers.js";
import { persistentSessionSettingsHandlers } from "./persistent_session_settings_handlers.js";

export const mcpToolHandlers = {
  ...sessionMessageHandlers,
  ...externalLlmHandlers,
  ...clusterHandlers,
  ...cardOrchestrationHandlers,
  ...recurringJobHandlers,
  ...ownedAgentHandlers,
  ...folderObjectHandlers,
  ...cardHandlers,
  ...boardHandlers,
  ...pageHandlers,
  ...liveCardHandlers,
  ...skillHandlers,
  ...sessionHandlers,
  ...persistentSessionSettingsHandlers,
} satisfies Record<McpToolName, McpToolHandler>;

export function findMcpTool(name: string) {
  return mcpToolDefinitions.find(definition => definition.name === name);
}

export async function executeMcpTool(options: McpHostOptions, name: McpToolName, args: Record<string, unknown>, context: McpCallContext) {
  const definition = findMcpTool(name)!;
  try {
    const externalSchema = "externalInputSchema" in definition ? definition.externalInputSchema : undefined;
    const schema = context.principal === "external" && externalSchema
      ? externalSchema : definition.config.inputSchema;
    const objectSchema = z.object(schema);
    const input = "strictInputSchema" in definition && definition.strictInputSchema
      ? objectSchema.strict().parse(args)
      : objectSchema.parse(args);
    return await mcpToolHandlers[name](options, input, context);
  } catch (error) { return errorResult(error instanceof Error ? error.message : String(error)); }
}

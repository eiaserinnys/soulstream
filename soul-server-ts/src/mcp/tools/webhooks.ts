import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { webhookTools } from "@soulstream/mcp-contract";
import { registerOrchestratorTools } from "../orchestrator_tools.js";
import type { McpRuntime } from "../runtime.js";

/** Webhook management tools: the node forwards them to the orchestrator unchanged. */
export function registerWebhookTools(server: McpServer, runtime: McpRuntime): void {
  registerOrchestratorTools(server, runtime, Object.values(webhookTools));
}

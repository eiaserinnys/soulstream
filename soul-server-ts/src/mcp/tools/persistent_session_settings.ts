import { persistentSessionSettingsTools } from "@soulstream/mcp-contract";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerOrchestratorTools } from "../orchestrator_tools.js";
import type { McpRuntime } from "../runtime.js";

export function registerPersistentSessionSettingsTools(server: McpServer, runtime: McpRuntime): void {
  registerOrchestratorTools(server, runtime, Object.values(persistentSessionSettingsTools));
}

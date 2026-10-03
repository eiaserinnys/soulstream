import { registerOrchestratorTools } from "../orchestrator_tools.js";
import { sessionTools } from "@soulstream/mcp-contract";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import type { McpRuntime } from "../runtime.js";

export function registerSearchSessionsTool(server: McpServer, runtime: McpRuntime): void {
  registerOrchestratorTools(server, runtime, [sessionTools.search_sessions]);
}

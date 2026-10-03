import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { pageTools } from "@soulstream/mcp-contract";
import { registerOrchestratorTools } from "../orchestrator_tools.js";

import type { McpRuntime } from "../runtime.js";

export function registerPageTools(server: McpServer, runtime: McpRuntime): void {
  registerOrchestratorTools(server, runtime, Object.values(pageTools));
}

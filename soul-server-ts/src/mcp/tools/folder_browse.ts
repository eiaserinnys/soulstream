import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { boardTools } from "@soulstream/mcp-contract";
import { registerOrchestratorTools } from "../orchestrator_tools.js";

import type { McpRuntime } from "../runtime.js";

export function registerFolderSearchTools(server: McpServer, runtime: McpRuntime): void {
  registerOrchestratorTools(server, runtime, [boardTools.search_folder_items]);
}

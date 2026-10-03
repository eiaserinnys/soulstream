import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { folderObjectTools } from "@soulstream/mcp-contract";
import { registerOrchestratorTools } from "../orchestrator_tools.js";

import type { McpRuntime } from "../runtime.js";

export function registerFolderObjectTools(server: McpServer, runtime: McpRuntime): void {
  registerOrchestratorTools(server, runtime, Object.values(folderObjectTools));
}

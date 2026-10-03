import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { boardTools } from "@soulstream/mcp-contract";
import { registerOrchestratorTools } from "../orchestrator_tools.js";

import type { McpRuntime } from "../runtime.js";

export function registerCustomViewTools(server: McpServer, runtime: McpRuntime): void {
  registerOrchestratorTools(server, runtime, [boardTools.create_custom_view, boardTools.patch_custom_view, boardTools.get_custom_view, boardTools.list_custom_views]);
}

import { registerOrchestratorTools } from "../orchestrator_tools.js";
import { sessionTools } from "@soulstream/mcp-contract";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import type { McpRuntime } from "../runtime.js";

export function registerSessionTurnSummaryTool(server: McpServer, runtime: McpRuntime): void {
  registerOrchestratorTools(server, runtime, [sessionTools.get_session_turn_summaries]);
}

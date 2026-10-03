import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { skillTools } from "@soulstream/mcp-contract";
import { registerOrchestratorTools } from "../orchestrator_tools.js";

import type { McpRuntime } from "../runtime.js";

export function registerSkillsTools(server: McpServer, runtime: McpRuntime): void {
  registerOrchestratorTools(server, runtime, Object.values(skillTools));
}

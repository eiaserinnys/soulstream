import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { externalLlmTools } from "@soulstream/mcp-contract";
import { registerOrchestratorTools } from "../orchestrator_tools.js";
import type { McpRuntime } from "../runtime.js";

export function registerExternalLlmTools(server: McpServer, runtime: McpRuntime) {
  registerOrchestratorTools(server, runtime, Object.values(externalLlmTools));
}

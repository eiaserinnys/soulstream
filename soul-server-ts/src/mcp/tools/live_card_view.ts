import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { liveCardTools } from "@soulstream/mcp-contract";
export { LIVE_CARD_RESOURCE, liveCardOutputSchema, type LiveCardQuery } from "@soulstream/mcp-contract";
import { registerOrchestratorTools } from "../orchestrator_tools.js";
import type { McpRuntime } from "../runtime.js";
import { registerLiveCardResource } from "./live_card_resource.js";

export function registerLiveCardView(server: McpServer, runtime: McpRuntime) {
 registerLiveCardResource(server);
 registerOrchestratorTools(server, runtime, Object.values(liveCardTools));
}

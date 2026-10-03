import { clusterTools } from "@soulstream/mcp-contract";
import { registerOrchestratorTools } from "../orchestrator_tools.js";
import { createCallerInfoPreprocessor } from "./cluster_caller_info.js";
export function registerMultiNodeTools(server: McpServer, runtime: McpRuntime): void {
  const attribution = createCallerInfoPreprocessor(runtime).create_remote_agent_session!;
  registerOrchestratorTools(server, runtime, Object.values(clusterTools), Object.fromEntries(Object.keys(clusterTools).map(name => [name,
    (args: Record<string, unknown>) => !runtime.orch ? errorResult(NOT_CONFIGURED_MSG)
      : name === "create_remote_agent_session" ? attribution(args) : {},
  ])));
}
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import { errorResult } from "../result.js";
import type { McpRuntime } from "../runtime.js";

const NOT_CONFIGURED_MSG = "multi-node not configured";

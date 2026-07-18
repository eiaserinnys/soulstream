import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import type { McpRuntime } from "../runtime.js";

import { registerTaskItemTools } from "./task_item_tools.js";
import { registerTaskLegacyReadCompatibility } from "./task_legacy_read_compat.js";
import { registerTaskObjectTools } from "./task_object_tools.js";
import { registerTaskSectionTools } from "./task_section_tools.js";

export function registerTaskTools(
  server: McpServer,
  runtime: McpRuntime,
): void {
  registerTaskObjectTools(server, runtime);
  registerTaskLegacyReadCompatibility(server, runtime);
  registerTaskSectionTools(server, runtime);
  registerTaskItemTools(server, runtime);
}

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import type { McpRuntime } from "../runtime.js";

import { registerChecklistItemTools } from "./task_item_tools.js";
import { registerFolderObjectTools } from "./task_object_tools.js";
import { registerChecklistSectionTools } from "./task_section_tools.js";

export function registerFolderTools(
  server: McpServer,
  runtime: McpRuntime,
): void {
  registerFolderObjectTools(server, runtime);
  registerChecklistSectionTools(server, runtime);
  registerChecklistItemTools(server, runtime);
}

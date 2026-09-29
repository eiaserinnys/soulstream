import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import type { McpRuntime } from "../runtime.js";

import { registerChecklistItemTools } from "./checklist_item_tools.js";
import { registerFolderObjectTools } from "./folder_object_tools.js";
import { registerChecklistSectionTools } from "./checklist_section_tools.js";

export function registerFolderTools(
  server: McpServer,
  runtime: McpRuntime,
): void {
  registerFolderObjectTools(server, runtime);
  registerChecklistSectionTools(server, runtime);
  registerChecklistItemTools(server, runtime);
}

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import type { McpRuntime } from "../runtime.js";

import { registerRunbookItemTools } from "./runbook_item_tools.js";
import { registerRunbookObjectTools } from "./runbook_object_tools.js";
import { registerRunbookSectionTools } from "./runbook_section_tools.js";

export function registerRunbookTools(
  server: McpServer,
  runtime: McpRuntime,
): void {
  registerRunbookObjectTools(server, runtime);
  registerRunbookSectionTools(server, runtime);
  registerRunbookItemTools(server, runtime);
}

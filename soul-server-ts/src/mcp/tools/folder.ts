import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import type { McpRuntime } from "../runtime.js";

import { registerCardTools } from "./card_tools.js";
import { registerFolderObjectTools } from "./folder_object_tools.js";

export function registerFolderTools(
  server: McpServer,
  runtime: McpRuntime,
): void {
  registerFolderObjectTools(server, runtime);
  registerCardTools(server, runtime);
}

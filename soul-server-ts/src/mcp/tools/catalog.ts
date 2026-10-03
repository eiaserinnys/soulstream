/** Catalog browse/mutation tools. Session deletion is TaskLifecycleRoute-owned. */
import { sessionTools } from "@soulstream/mcp-contract";
import { forwardOrchestratorTool } from "../orchestrator_tools.js";
import { TaskOwnedByAnotherNodeError } from "../../task/task_hydration_errors.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { boardTools } from "@soulstream/mcp-contract";
import { registerOrchestratorTools } from "../orchestrator_tools.js";

import { errorResult, jsonResult } from "../result.js";
import type { McpRuntime } from "../runtime.js";
import { registerFolderSearchTools } from "./folder_browse.js";

export function registerCatalogTools(
  server: McpServer,
  runtime: McpRuntime,
): void {
  registerFolderSearchTools(server, runtime);
  registerOrchestratorTools(server, runtime, Object.values(boardTools).filter(definition =>
    !["search_folder_items", "create_custom_view", "patch_custom_view", "get_custom_view", "list_custom_views"].includes(definition.name)));

  server.registerTool(
    "delete_session",
    sessionTools.delete_session.config,
    async ({ session_id }) => {
      try {
        const deletedBoardItemIds = await runtime.db.getBoardItemIdsForSession(session_id);
        await runtime.taskManager.deleteTask(session_id);
        await runtime.catalogService.broadcastSessionDeletion(
          session_id,
          deletedBoardItemIds,
        );
        return jsonResult({ ok: true, session_id });
      } catch (err) {
        if (err instanceof TaskOwnedByAnotherNodeError) {
          try { return await forwardOrchestratorTool(runtime, sessionTools.delete_session, { session_id }); }
          catch (forwardError) { return errorResult(forwardError instanceof Error ? forwardError.message : String(forwardError)); }
        }
        return errorResult(err instanceof Error ? err.message : String(err));
      }
    },
  );
}

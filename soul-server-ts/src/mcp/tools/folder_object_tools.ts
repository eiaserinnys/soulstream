import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { folderObjectTools } from "@soulstream/mcp-contract";
import { registerOrchestratorTools } from "../orchestrator_tools.js";

import { errorResult, jsonResult } from "../result.js";
import type { McpRuntime } from "../runtime.js";
import {
  errorMessage,
  getFolderService,
  mutation,
} from "./folder_tool_shared.js";

export function registerFolderObjectTools(server: McpServer, runtime: McpRuntime): void {
  registerOrchestratorTools(server, runtime, Object.values(folderObjectTools));
}

// Removed after all MCP groups have completed the migration; parity tests use the old path.
export function registerFolderObjectToolsLegacy(server: McpServer, runtime: McpRuntime): void {
  server.registerTool("create_folder", folderObjectTools.create_folder.config, async (input) => mutation(runtime, input.caller_session_id, (service, actor) => service.createFolder({
    ...actor, parentFolderId: input.parent_folder_id,
    name: input.name, description: input.description,
    initialContext: input.initial_context, sortOrder: input.sort_order,
    idempotencyKey: input.idempotency_key,
  })));

  server.registerTool("list_child_folders", folderObjectTools.list_child_folders.config, async ({ folder_id, include_archived, limit, cursor }) => {
    try { return jsonResult(await getFolderService(runtime).listChildFolders({ folderId: folder_id ?? null, includeArchived: include_archived, limit, ...(cursor !== undefined ? { cursor } : {}) })); }
    catch (err) { return errorResult(errorMessage(err)); }
  });

  server.registerTool("get_folder", folderObjectTools.get_folder.config, async ({ folder_id, view, card_id }) => {
    try { return jsonResult(await getFolderService(runtime).getFolder(folder_id, { view, cardId: card_id })); }
    catch (err) { return errorResult(errorMessage(err)); }
  });

  server.registerTool("rename_folder", folderObjectTools.rename_folder.config, async (input) => mutation(runtime, input.caller_session_id, (service, actor) => service.renameFolder({ ...actor, folderId: input.folder_id, name: input.name, expectedVersion: input.expected_version, reason: input.reason, idempotencyKey: input.idempotency_key })));

  for (const archived of [true, false]) {
    const name = archived ? "archive_folder" : "unarchive_folder";
    server.registerTool(name, folderObjectTools[name].config, async (input) => mutation(runtime, input.caller_session_id, (service, actor) => service.setFolderArchived({ ...actor, folderId: input.folder_id, expectedVersion: input.expected_version, archived, reason: input.reason, idempotencyKey: input.idempotency_key })));
  }

  server.registerTool("set_folder_status", folderObjectTools.set_folder_status.config, async (input) => mutation(runtime, input.caller_session_id, (service, actor) => service.setFolderStatus({ ...actor, folderId: input.folder_id, status: input.status, expectedVersion: input.expected_version, reason: input.reason, idempotencyKey: input.idempotency_key })));


  server.registerTool("list_folder_operations", folderObjectTools.list_folder_operations.config, async ({ folder_id, limit, cursor }) => {
    try { return jsonResult(await getFolderService(runtime).listFolderOperations(folder_id, limit, cursor)); }
    catch (err) { return errorResult(errorMessage(err)); }
  });

}

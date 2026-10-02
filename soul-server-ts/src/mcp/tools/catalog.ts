/** Catalog browse/mutation tools. Session deletion is TaskLifecycleRoute-owned. */
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { boardTools } from "@soulstream/mcp-contract";
import { registerOrchestratorTools } from "../orchestrator_tools.js";

import { errorResult, jsonResult } from "../result.js";
import type { McpRuntime } from "../runtime.js";
import { registerFolderSearchTools, registerFolderSearchToolsLegacy, serializeFolderItem } from "./folder_browse.js";

export function registerCatalogTools(
  server: McpServer,
  runtime: McpRuntime,
): void {
  registerFolderSearchTools(server, runtime);
  registerOrchestratorTools(server, runtime, Object.values(boardTools).filter(definition =>
    !["search_folder_items", "create_custom_view", "patch_custom_view", "get_custom_view", "list_custom_views"].includes(definition.name)));

  server.registerTool(
    "delete_session",
    {
      description: "세션 삭제 (이벤트 cascade 포함).",
      inputSchema: { session_id: z.string() },
    },
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
        return errorResult(err instanceof Error ? err.message : String(err));
      }
    },
  );
}

export function registerCatalogToolsLegacy(server: McpServer, runtime: McpRuntime): void {
  registerFolderSearchToolsLegacy(server, runtime);
  server.registerTool(
    "list_folders",
    boardTools.list_folders.config,
    async () => {
      const folders = await runtime.catalogService.listFolders();
      return jsonResult({ folders });
    },
  );

  server.registerTool(
    "browse_folder",
    boardTools.browse_folder.config,
    async ({ folder_id, session_cursor, session_limit, cursor, limit, include_archived }) => {
      try {
        const result = await runtime.catalogService.browseFolder({
          folderId: folder_id,
          sessionCursor: session_cursor ?? 0,
          sessionLimit: session_limit ?? 20,
          cursor,
          limit,
          includeArchived: include_archived,
        });
        return jsonResult({
          folder_id,
          folder: result.folder,
          child_folders: result.childFolders,
          sessions: result.sessions,
          sessions_page: result.sessionsPage,
          board_items: result.boardItems,
          items: result.items.map((item) => serializeFolderItem(item, runtime)),
          items_page: result.itemsPage,
          counts: result.counts,
        });
      } catch (err) {
        return errorResult(err instanceof Error ? err.message : String(err));
      }
    },
  );

  server.registerTool(
    "move_folder",
    boardTools.move_folder.config,
    async ({ folder_id, parent_folder_id }) => {
      try {
        await runtime.catalogService.setFolderParent(
          folder_id,
          parent_folder_id ?? null,
        );
        return jsonResult({ ok: true });
      } catch (err) {
        return errorResult(err instanceof Error ? err.message : String(err));
      }
    },
  );

  server.registerTool(
    "delete_folder",
    boardTools.delete_folder.config,
    async ({ folder_id }) => {
      try {
        await runtime.catalogService.deleteFolder(folder_id);
        return jsonResult({ ok: true });
      } catch (err) {
        return errorResult(err instanceof Error ? err.message : String(err));
      }
    },
  );

  server.registerTool(
    "move_sessions_to_folder",
    boardTools.move_sessions_to_folder.config,
    async ({ session_ids, folder_id }) => {
      try {
        await runtime.catalogService.moveSessionsToFolder(
          session_ids,
          folder_id ?? null,
        );
        return jsonResult({ ok: true, moved: session_ids.length });
      } catch (err) {
        return errorResult(err instanceof Error ? err.message : String(err));
      }
    },
  );

  server.registerTool(
    "update_board_item_position",
    boardTools.update_board_item_position.config,
    async ({ board_item_id, x, y }) => {
      try {
        await runtime.catalogService.updateBoardItemPosition(board_item_id, x, y);
        return jsonResult({ ok: true, board_item_id });
      } catch (err) {
        return errorResult(err instanceof Error ? err.message : String(err));
      }
    },
  );

  server.registerTool(
    "move_board_item_to_folder",
    boardTools.move_board_item_to_folder.config,
    async ({ board_item_id, folder_id, x, y, idempotency_key }) => {
      try {
        if ((x === undefined) !== (y === undefined)) {
          return errorResult("x and y must be supplied together");
        }
        const result = await runtime.catalogService.moveBoardItemToFolder({
          boardItemId: board_item_id,
          folderId: folder_id,
          ...(x !== undefined && y !== undefined ? { position: { x, y } } : {}),
          idempotencyKey: idempotency_key,
        });
        return jsonResult({
          ok: true,
          board_item: result.boardItem,
          ...(result.enrolled ? { enrolled: true } : {}),
          idempotency_key,
        });
      } catch (err) {
        return errorResult(err instanceof Error ? err.message : String(err));
      }
    },
  );

  server.registerTool(
    "create_markdown_document",
    boardTools.create_markdown_document.config,
    async ({ folder_id, title, body, x, y }) => {
      try {
        const result = await runtime.catalogService.createMarkdownDocument({
          folderId: folder_id,
          title,
          body: body ?? "",
          x,
          y,
        });
        return jsonResult(result);
      } catch (err) {
        return errorResult(err instanceof Error ? err.message : String(err));
      }
    },
  );

  server.registerTool(
    "get_markdown_document",
    boardTools.get_markdown_document.config,
    async ({ document_id }) => {
      try {
        const document = await runtime.catalogService.getMarkdownDocument(document_id);
        if (!document) return errorResult("document not found");
        return jsonResult(document);
      } catch (err) {
        return errorResult(err instanceof Error ? err.message : String(err));
      }
    },
  );

  server.registerTool(
    "update_markdown_document",
    boardTools.update_markdown_document.config,
    async ({ document_id, expected_version, title, body }) => {
      try {
        if (title === undefined && body === undefined) {
          return errorResult("No fields to update");
        }
        const document = await runtime.catalogService.updateMarkdownDocument(
          document_id,
          {
            expectedVersion: expected_version,
            ...(title !== undefined ? { title } : {}),
            ...(body !== undefined ? { body } : {}),
          },
        );
        if (!document) return errorResult("document not found");
        return jsonResult(document);
      } catch (err) {
        return errorResult(err instanceof Error ? err.message : String(err));
      }
    },
  );

  server.registerTool(
    "delete_markdown_document",
    boardTools.delete_markdown_document.config,
    async ({ document_id }) => {
      try {
        await runtime.catalogService.deleteMarkdownDocument(document_id);
        return jsonResult({ ok: true, document_id });
      } catch (err) {
        return errorResult(err instanceof Error ? err.message : String(err));
      }
    },
  );

  server.registerTool(
    "get_folder_system_prompt",
    boardTools.get_folder_system_prompt.config,
    async ({ folder_id }) => {
      try {
        const prompt =
          await runtime.catalogService.getFolderSystemPrompt(folder_id);
        return jsonResult({ folder_id, system_prompt: prompt });
      } catch (err) {
        return errorResult(err instanceof Error ? err.message : String(err));
      }
    },
  );

  server.registerTool(
    "set_folder_system_prompt",
    boardTools.set_folder_system_prompt.config,
    async ({ folder_id, system_prompt }) => {
      try {
        await runtime.catalogService.setFolderSystemPrompt(
          folder_id,
          system_prompt ?? null,
        );
        return jsonResult({ ok: true });
      } catch (err) {
        return errorResult(err instanceof Error ? err.message : String(err));
      }
    },
  );

}

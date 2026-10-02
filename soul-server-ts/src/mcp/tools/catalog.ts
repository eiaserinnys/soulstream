/** Catalog browse/mutation tools. Session deletion is TaskLifecycleRoute-owned. */
import { sessionTools } from "@soulstream/mcp-contract";
import { forwardOrchestratorTool } from "../orchestrator_tools.js";
import { TaskOwnedByAnotherNodeError } from "../../task/task_hydration_errors.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import { errorResult, jsonResult } from "../result.js";
import type { McpRuntime } from "../runtime.js";
import { registerFolderSearchTools, serializeFolderItem } from "./folder_browse.js";

export function registerCatalogTools(
  server: McpServer,
  runtime: McpRuntime,
): void {
  registerFolderSearchTools(server, runtime);
  server.registerTool(
    "list_folders",
    { description: "전체 폴더 목록.", inputSchema: {} },
    async () => {
      const folders = await runtime.catalogService.listFolders();
      return jsonResult({ folders });
    },
  );

  server.registerTool(
    "browse_folder",
    {
      description:
        "폴더 내부를 한 번에 브라우즈한다. 직접 자식 폴더, 세션 페이지, 문서/이미지/파일 보드 항목을 함께 반환.",
      inputSchema: {
        folder_id: z.string().min(1),
        session_cursor: z.number().int().min(0).default(0),
        session_limit: z.number().int().min(1).max(100).default(20),
        cursor: z.number().int().min(0).default(0),
        limit: z.number().int().min(1).max(100).default(20),
        include_archived: z.boolean().default(false),
      },
    },
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
    {
      description: "폴더를 다른 부모 폴더 아래로 이동. parent_folder_id=null/미지정 → 루트로 이동.",
      inputSchema: {
        folder_id: z.string(),
        parent_folder_id: z.string().nullable().optional(),
      },
    },
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
    {
      description: "폴더 삭제.",
      inputSchema: { folder_id: z.string() },
    },
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
    {
      description: "세션들을 폴더로 이동. folder_id=null/미지정 → 폴더 해제.",
      inputSchema: {
        session_ids: z.array(z.string().min(1)),
        folder_id: z.string().optional(),
      },
    },
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
    {
      description: "보드 항목 좌표 갱신. 좌표는 서버에서 20px 격자에 스냅된다.",
      inputSchema: {
        board_item_id: z.string().min(1),
        x: z.number(),
        y: z.number(),
      },
    },
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
    {
      description:
        "기존 보드 항목을 다른 폴더로 이동한다.",
      inputSchema: {
        board_item_id: z.string().min(1),
        folder_id: z.string().min(1),
        x: z.number().optional(),
        y: z.number().optional(),
        idempotency_key: z.string().min(1),
      },
    },
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
    {
      description: "현재 보드 폴더에 마크다운 문서와 보드 카드를 생성.",
      inputSchema: {
        folder_id: z.string().min(1),
        title: z.string().min(1),
        body: z.string().default(""),
        x: z.number().optional(),
        y: z.number().optional(),
      },
    },
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
    {
      description: "마크다운 문서 본문 조회.",
      inputSchema: { document_id: z.string().min(1) },
    },
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
    {
      description: "마크다운 문서 제목 또는 본문 수정.",
      inputSchema: {
        document_id: z.string().min(1),
        expected_version: z.number().int().positive(),
        title: z.string().optional(),
        body: z.string().optional(),
      },
    },
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
    {
      description: "마크다운 문서와 해당 보드 카드를 삭제.",
      inputSchema: { document_id: z.string().min(1) },
    },
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
    {
      description: "폴더 시스템 프롬프트 조회.",
      inputSchema: { folder_id: z.string() },
    },
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
    {
      description: "폴더 시스템 프롬프트 설정. 빈 문자열·null → 삭제.",
      inputSchema: {
        folder_id: z.string(),
        system_prompt: z.string().optional(),
      },
    },
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
        if (err instanceof TaskOwnedByAnotherNodeError) return forwardOrchestratorTool(runtime, sessionTools.delete_session, { session_id });
        return errorResult(err instanceof Error ? err.message : String(err));
      }
    },
  );
}

/** Previous local-only callback retained for roundtrip comparison until stage 6. */
export function registerDeleteSessionToolLegacy(server: McpServer, runtime: McpRuntime): void {
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
        return errorResult(err instanceof Error ? err.message : String(err));
      }
    },
  );
}

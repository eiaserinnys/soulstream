/**
 * catalog 도구 — Python `mcp_catalog.py` 정합 (키 호환). 모두 CatalogService 경유.
 */
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import { errorResult, jsonResult } from "../result.js";
import type { McpRuntime } from "../runtime.js";

export function registerCatalogTools(
  server: McpServer,
  runtime: McpRuntime,
): void {
  server.registerTool(
    "list_folders",
    { description: "전체 폴더 목록.", inputSchema: {} },
    async () => {
      const folders = await runtime.catalogService.listFolders();
      return jsonResult({ folders });
    },
  );

  server.registerTool(
    "list_child_folders",
    {
      description: "특정 폴더의 직접 자식 폴더만 조회.",
      inputSchema: {
        folder_id: z.string().nullable().optional(),
      },
    },
    async ({ folder_id }) => {
      const folders = await runtime.catalogService.listChildFolders(
        folder_id ?? null,
      );
      return jsonResult({ folder_id: folder_id ?? null, folders });
    },
  );

  server.registerTool(
    "create_folder",
    {
      description: "새 폴더 생성.",
      inputSchema: {
        name: z.string().min(1),
        sort_order: z.number().int().default(0),
        parent_folder_id: z.string().nullable().optional(),
      },
    },
    async ({ name, sort_order, parent_folder_id }) => {
      const folder = await runtime.catalogService.createFolder(
        name,
        sort_order ?? 0,
        parent_folder_id ?? null,
      );
      return jsonResult(folder);
    },
  );

  server.registerTool(
    "rename_folder",
    {
      description: "폴더 이름 변경.",
      inputSchema: { folder_id: z.string(), name: z.string().min(1) },
    },
    async ({ folder_id, name }) => {
      try {
        await runtime.catalogService.renameFolder(folder_id, name);
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
        title: z.string().optional(),
        body: z.string().optional(),
      },
    },
    async ({ document_id, title, body }) => {
      try {
        const document = await runtime.catalogService.updateMarkdownDocument(
          document_id,
          { ...(title !== undefined ? { title } : {}), ...(body !== undefined ? { body } : {}) },
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
    {
      description: "세션 삭제 (이벤트 cascade 포함).",
      inputSchema: { session_id: z.string() },
    },
    async ({ session_id }) => {
      try {
        await runtime.catalogService.deleteSession(session_id);
        return jsonResult({ ok: true, session_id });
      } catch (err) {
        return errorResult(err instanceof Error ? err.message : String(err));
      }
    },
  );
}

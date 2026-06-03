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

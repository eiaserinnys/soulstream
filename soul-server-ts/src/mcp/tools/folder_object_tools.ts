import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import { errorResult, jsonResult } from "../result.js";
import type { McpRuntime } from "../runtime.js";
import {
  callerSessionIdSchema,
  errorMessage,
  expectedVersionSchema,
  folderStatusSchema,
  getFolderService,
  idempotencyKeySchema,
  mutation,
  mutationToolDescription,
  optionalReasonSchema,
} from "./folder_tool_shared.js";

export function registerFolderObjectTools(server: McpServer, runtime: McpRuntime): void {
  server.registerTool("create_folder", {
    description: mutationToolDescription("현재 MCP caller session을 actor_kind='agent'로 하여 폴더를 생성한다."),
    inputSchema: {
      parent_folder_id: z.string().nullable().optional(),
      name: z.string().min(1),
      description: z.string().optional(),
      initial_context: z.unknown().optional(),
      sort_order: z.number().int().optional(),
      idempotency_key: idempotencyKeySchema,
      caller_session_id: callerSessionIdSchema,
    },
  }, async (input) => mutation(runtime, input.caller_session_id, (service, actor) => service.createFolder({
    ...actor, parentFolderId: input.parent_folder_id,
    name: input.name, description: input.description,
    initialContext: input.initial_context, sortOrder: input.sort_order,
    idempotencyKey: input.idempotency_key,
  })));

  server.registerTool("list_child_folders", {
    description: "직접 자식 폴더를 페이지 단위로 조회한다. folder_id=null이면 최상위 폴더를 조회한다.",
    inputSchema: { folder_id: z.string().nullable().optional(), include_archived: z.boolean().default(false), limit: z.number().int().min(1).max(200).default(100), cursor: z.string().optional() },
  }, async ({ folder_id, include_archived, limit, cursor }) => {
    try { return jsonResult(await getFolderService(runtime).listChildFolders({ folderId: folder_id ?? null, includeArchived: include_archived, limit, ...(cursor !== undefined ? { cursor } : {}) })); }
    catch (err) { return errorResult(errorMessage(err)); }
  });

  server.registerTool("get_folder", {
    description: "폴더와 카드를 조회한다. view=outline 또는 card_id로 응답을 축약할 수 있다.",
    inputSchema: { folder_id: z.string().min(1), view: z.enum(["full", "outline"]).default("full"), card_id: z.string().min(1).optional() },
  }, async ({ folder_id, view, card_id }) => {
    try { return jsonResult(await getFolderService(runtime).getFolder(folder_id, { view, cardId: card_id })); }
    catch (err) { return errorResult(errorMessage(err)); }
  });

  server.registerTool("rename_folder", {
    description: mutationToolDescription("폴더 이름을 바꾼다."),
    inputSchema: { folder_id: z.string().min(1), name: z.string().min(1), expected_version: expectedVersionSchema, reason: optionalReasonSchema, idempotency_key: idempotencyKeySchema, caller_session_id: callerSessionIdSchema },
  }, async (input) => mutation(runtime, input.caller_session_id, (service, actor) => service.renameFolder({ ...actor, folderId: input.folder_id, name: input.name, expectedVersion: input.expected_version, reason: input.reason, idempotencyKey: input.idempotency_key })));

  for (const archived of [true, false]) {
    const name = archived ? "archive_folder" : "unarchive_folder";
    server.registerTool(name, {
      description: mutationToolDescription(archived ? "폴더를 보관한다." : "보관된 폴더를 복구한다."),
      inputSchema: { folder_id: z.string().min(1), expected_version: expectedVersionSchema, reason: optionalReasonSchema, idempotency_key: idempotencyKeySchema, caller_session_id: callerSessionIdSchema },
    }, async (input) => mutation(runtime, input.caller_session_id, (service, actor) => service.setFolderArchived({ ...actor, folderId: input.folder_id, expectedVersion: input.expected_version, archived, reason: input.reason, idempotencyKey: input.idempotency_key })));
  }

  server.registerTool("set_folder_status", {
    description: mutationToolDescription("폴더의 open/completed 상태를 설정한다."),
    inputSchema: { folder_id: z.string().min(1), status: folderStatusSchema, expected_version: expectedVersionSchema, reason: optionalReasonSchema, idempotency_key: idempotencyKeySchema, caller_session_id: callerSessionIdSchema },
  }, async (input) => mutation(runtime, input.caller_session_id, (service, actor) => service.setFolderStatus({ ...actor, folderId: input.folder_id, status: input.status, expectedVersion: input.expected_version, reason: input.reason, idempotencyKey: input.idempotency_key })));


  server.registerTool("list_folder_operations", {
    description: "폴더와 카드의 감사 기록을 최신순으로 조회한다.",
    inputSchema: { folder_id: z.string().min(1), limit: z.number().int().min(1).max(200).default(50), cursor: z.string().optional() },
  }, async ({ folder_id, limit, cursor }) => {
    try { return jsonResult(await getFolderService(runtime).listFolderOperations(folder_id, limit, cursor)); }
    catch (err) { return errorResult(errorMessage(err)); }
  });

}

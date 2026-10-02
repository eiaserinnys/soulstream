import { z } from "zod";
import { folderStatusSchema, assigneeValueSchema, assigneeSchema, idempotencyKeySchema, optionalReasonSchema, expectedVersionSchema, callerSessionIdSchema, mutationToolDescription } from "./folder_shared.js";

export const folderObjectTools = {
  create_folder: { name: "create_folder", config: {
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
  }, audience: "all" },
  list_child_folders: { name: "list_child_folders", config: {
    description: "직접 자식 폴더를 페이지 단위로 조회한다. folder_id=null이면 최상위 폴더를 조회한다.",
    inputSchema: { folder_id: z.string().nullable().optional(), include_archived: z.boolean().default(false), limit: z.number().int().min(1).max(200).default(100), cursor: z.string().optional() },
  }, audience: "all" },
  get_folder: { name: "get_folder", config: {
    description: "폴더와 카드를 조회한다. view=outline 또는 card_id로 응답을 축약할 수 있다.",
    inputSchema: { folder_id: z.string().min(1), view: z.enum(["full", "outline"]).default("full"), card_id: z.string().min(1).optional() },
  }, audience: "all" },
  rename_folder: { name: "rename_folder", config: {
    description: mutationToolDescription("폴더 이름을 바꾼다."),
    inputSchema: { folder_id: z.string().min(1), name: z.string().min(1), expected_version: expectedVersionSchema, reason: optionalReasonSchema, idempotency_key: idempotencyKeySchema, caller_session_id: callerSessionIdSchema },
  }, audience: "all" },
  archive_folder: { name: "archive_folder", config: {
      description: mutationToolDescription("폴더를 보관한다."),
      inputSchema: { folder_id: z.string().min(1), expected_version: expectedVersionSchema, reason: optionalReasonSchema, idempotency_key: idempotencyKeySchema, caller_session_id: callerSessionIdSchema },
    }, audience: "all" },
  unarchive_folder: { name: "unarchive_folder", config: {
      description: mutationToolDescription("보관된 폴더를 복구한다."),
      inputSchema: { folder_id: z.string().min(1), expected_version: expectedVersionSchema, reason: optionalReasonSchema, idempotency_key: idempotencyKeySchema, caller_session_id: callerSessionIdSchema },
    }, audience: "all" },
  set_folder_status: { name: "set_folder_status", config: {
    description: mutationToolDescription("폴더의 open/completed 상태를 설정한다."),
    inputSchema: { folder_id: z.string().min(1), status: folderStatusSchema, expected_version: expectedVersionSchema, reason: optionalReasonSchema, idempotency_key: idempotencyKeySchema, caller_session_id: callerSessionIdSchema },
  }, audience: "all" },
  list_folder_operations: { name: "list_folder_operations", config: {
    description: "폴더와 카드의 감사 기록을 최신순으로 조회한다.",
    inputSchema: { folder_id: z.string().min(1), limit: z.number().int().min(1).max(200).default(50), cursor: z.string().optional() },
  }, audience: "all" },
} as const;

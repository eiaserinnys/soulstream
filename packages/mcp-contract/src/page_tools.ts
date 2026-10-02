import { z } from "zod";
import { CALLER_SESSION_ID_FALLBACK_GUIDANCE } from "./folder_shared.js";
import type { McpToolDefinition } from "./tool_definitions.js";

const id = z.string().trim().min(1);
const callerSessionId = id.optional();
const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const jsonObject = z.record(z.string(), z.unknown());
const pageForCreate = z.object({
  id: id.optional(),
  title: id,
  daily_date: date.nullable().optional(),
});
const placement = {
  parent_id: id.nullable().default(null),
  parent_temp_id: id.nullable().optional(),
  after_block_id: id.nullable().default(null),
  after_temp_id: id.nullable().optional(),
};
const nonDestructiveBatchOperations = [
  z.object({ op: z.literal("rename_page"), title: id }),
  z.object({ op: z.literal("set_page_archived"), archived: z.boolean() }),
  z.object({
    op: z.literal("create_block"),
    temp_id: id,
    ...placement,
    block_type: id.default("paragraph"),
    text: z.string(),
    properties: jsonObject.default({}),
    collapsed: z.boolean().optional(),
  }),
  z.object({ op: z.literal("move_block"), block_id: id, ...placement }),
  z.object({ op: z.literal("update_block_text"), block_id: id, text: z.string() }),
  z.object({
    op: z.literal("update_block_type_and_properties"),
    block_id: id,
    block_type: id,
    properties: jsonObject,
  }),
  z.object({ op: z.literal("set_check_state"), block_id: id, checked: z.boolean() }),
] as const;
const nonDestructiveBatchOperation = z.discriminatedUnion(
  "op",
  nonDestructiveBatchOperations,
);
const batchOperation = z.discriminatedUnion("op", [
  ...nonDestructiveBatchOperations,
  z.object({ op: z.literal("delete_block_subtree"), block_id: id }),
]);

function buildBatchInput(operation: z.ZodType) {
  return z.object({
  page: pageForCreate.optional(),
  page_id: id.optional(),
  expected_version: z.number().int().positive().optional(),
  operations: z.array(operation).min(1),
  idempotency_key: id,
  caller_session_id: callerSessionId,
  }).superRefine((value, context) => {
    if ((value.page ? 1 : 0) + (value.page_id ? 1 : 0) !== 1) {
      context.addIssue({ code: "custom", message: "page and page_id are mutually exclusive" });
    }
    if (value.page && value.expected_version !== undefined) {
      context.addIssue({ code: "custom", message: "new page must not include expected_version" });
    }
    if (value.page_id && value.expected_version === undefined) {
      context.addIssue({ code: "custom", message: "existing page requires expected_version" });
    }
  });
}

export const batchInput = buildBatchInput(batchOperation);
const nonDestructiveBatchInput = buildBatchInput(nonDestructiveBatchOperation);

export const upsertInput = z.object({
  page_id: id.optional(),
  title: id.optional(),
  markdown: z.string(),
  expected_version: z.number().int().positive().optional(),
  idempotency_key: id,
  caller_session_id: callerSessionId,
}).superRefine((value, context) => {
  if ((value.page_id ? 1 : 0) + (value.title ? 1 : 0) !== 1) {
    context.addIssue({ code: "custom", message: "page_id and title are mutually exclusive" });
  }
  if (value.page_id && value.expected_version === undefined) {
    context.addIssue({ code: "custom", message: "existing page requires expected_version" });
  }
  if (value.title && value.expected_version !== undefined) {
    context.addIssue({ code: "custom", message: "new page must not include expected_version" });
  }
});


function mutationDescription(description: string): string { return `${description} ${CALLER_SESSION_ID_FALLBACK_GUIDANCE}`; }
export const pageTools = {
  get_page: { name: "get_page", audience: "all", config: {
    description: "페이지와 선택적으로 블록 전체를 조회한다.",
    inputSchema: {
      page_id: id,
      include_blocks: z.boolean().default(true),
      caller_session_id: callerSessionId,
    },
  } },
  find_page: { name: "find_page", audience: "all", config: {
    description: "trim + case-insensitive exact title로 페이지를 찾는다.",
    inputSchema: { title: id, caller_session_id: callerSessionId },
  } },
  get_page_markdown: { name: "get_page_markdown", audience: "all", config: {
    description: "페이지 블록 트리를 마크다운 텍스트로 조회한다.",
    inputSchema: {
      page_id: id,
      include_block_ids: z.boolean().default(false),
      caller_session_id: callerSessionId,
    },
  } },
  get_backlinks: { name: "get_backlinks", audience: "all", config: {
    description: "페이지를 가리키는 materialized backlink를 cursor 방식으로 조회한다.",
    inputSchema: {
      page_id: id,
      kinds: z.array(z.enum(["mount", "inline_page", "block_ref"]))
        .min(1).default(["mount", "inline_page", "block_ref"]),
      cursor: id.optional(),
      include_self: z.boolean().default(false),
      limit: z.number().int().min(1).max(200).default(50),
      caller_session_id: callerSessionId,
    },
  } },
  create_page: { name: "create_page", audience: "all", config: {
    description: mutationDescription("새 페이지를 생성한다."),
    inputSchema: {
      title: id,
      daily_date: date.optional(),
      id: id.optional(),
      idempotency_key: id,
      caller_session_id: callerSessionId,
    },
  } },
  batch_page_operations: { name: "batch_page_operations", audience: "all", config: {
    description: mutationDescription("페이지 변경 묶음을 하나의 CAS transaction으로 실행한다."),
    inputSchema:
      batchInput.shape,
  }, externalInputSchema: nonDestructiveBatchInput.shape },
  upsert_page_markdown: { name: "upsert_page_markdown", audience: "all", config: {
    description: mutationDescription("마크다운으로 페이지 블록 전체를 명시적으로 교체한다."),
    inputSchema: upsertInput.shape,
  } },
  get_daily_page: { name: "get_daily_page", audience: "all", config: {
    description: mutationDescription("Asia/Seoul 기준 데일리 페이지를 멱등 get-or-create한다."),
    inputSchema: { date: date.optional(), caller_session_id: callerSessionId },
  } },
} as const satisfies Record<string, McpToolDefinition>;

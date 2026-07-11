import { randomUUID } from "node:crypto";

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  markdownToPageBlocks,
  pageToMarkdown,
  type PageLinkKind,
} from "@soulstream/page-model";
import { z } from "zod";

import { PageYjsHostClient } from "../../page/page_host_client.js";
import { SOULSTREAM_AGENT_SESSION_HEADER } from "../request_context.js";
import { errorResult, jsonResult } from "../result.js";
import type { McpRuntime } from "../runtime.js";
import { resolveEffectiveCallerSessionId } from "./caller_session.js";

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
const batchOperation = z.discriminatedUnion("op", [
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
  z.object({ op: z.literal("delete_block_subtree"), block_id: id }),
]);

const batchInput = z.object({
  page: pageForCreate.optional(),
  page_id: id.optional(),
  expected_version: z.number().int().positive().optional(),
  operations: z.array(batchOperation).min(1),
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

const upsertInput = z.object({
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

export function registerPageTools(server: McpServer, runtime: McpRuntime): void {
  server.registerTool("get_page", {
    description: "페이지와 선택적으로 블록 전체를 조회한다.",
    inputSchema: {
      page_id: id,
      include_blocks: z.boolean().default(true),
      caller_session_id: callerSessionId,
    },
  }, async ({ page_id, include_blocks }) => handle(runtime, async (client) =>
    await client.getPage(page_id, include_blocks)));

  server.registerTool("find_page", {
    description: "trim + case-insensitive exact title로 페이지를 찾는다.",
    inputSchema: { title: id, caller_session_id: callerSessionId },
  }, async ({ title }) => handle(runtime, async (client) => await client.findPage(title)));

  server.registerTool("get_page_markdown", {
    description: "페이지 블록 트리를 마크다운 텍스트로 조회한다.",
    inputSchema: {
      page_id: id,
      include_block_ids: z.boolean().default(false),
      caller_session_id: callerSessionId,
    },
  }, async ({ page_id, include_block_ids }) => {
    try {
      const result = await getPageHostClient(runtime).getPage(page_id, true);
      return {
        content: [{
          type: "text" as const,
          text: pageToMarkdown(result.page, result.blocks ?? [], {
            includeBlockIds: include_block_ids,
          }),
        }],
      };
    } catch (error) {
      return errorResult(errorMessage(error));
    }
  });

  server.registerTool("get_backlinks", {
    description: "페이지를 가리키는 materialized backlink를 cursor 방식으로 조회한다.",
    inputSchema: {
      page_id: id,
      kinds: z.array(z.enum(["mount", "inline_page", "block_ref"]))
        .min(1).default(["mount", "inline_page", "block_ref"]),
      cursor: id.optional(),
      limit: z.number().int().min(1).max(200).default(50),
      caller_session_id: callerSessionId,
    },
  }, async ({ page_id, kinds, cursor, limit }) => handle(runtime, async (client) =>
    await client.getBacklinks({
      pageId: page_id,
      kinds: kinds as PageLinkKind[],
      cursor,
      limit,
    })));

  server.registerTool("create_page", {
    description: mutationDescription("새 페이지를 생성한다."),
    inputSchema: {
      title: id,
      daily_date: date.optional(),
      id: id.optional(),
      idempotency_key: id,
      caller_session_id: callerSessionId,
    },
  }, async (input) => mutation(runtime, input.caller_session_id, async (client, actor) => {
    const result = await client.createPage({
      page: {
        id: input.id ?? randomUUID(),
        title: input.title,
        daily_date: input.daily_date ?? null,
      },
      actorSessionId: actor,
      idempotencyKey: input.idempotency_key,
    });
    return { page: result.page, created: true, operation: result.operation };
  }));

  server.registerTool("batch_page_operations", {
    description: mutationDescription("페이지 변경 묶음을 하나의 CAS transaction으로 실행한다."),
    inputSchema: batchInput.shape,
  }, async (raw) => {
    const parsed = batchInput.safeParse(raw);
    if (!parsed.success) return errorResult(parsed.error.message);
    return mutation(runtime, parsed.data.caller_session_id, async (client, actor) => {
      const data = parsed.data;
      const result = await client.batchPageOperations({
        ...(data.page
          ? {
              page: {
                id: data.page.id ?? randomUUID(),
                title: data.page.title,
                daily_date: data.page.daily_date ?? null,
              },
            }
          : { page_id: data.page_id!, expected_version: data.expected_version! }),
        operations: data.operations,
        actor_session_id: actor,
        idempotency_key: data.idempotency_key,
      });
      return { ...result, idempotent: result.idempotent === true };
    });
  });

  server.registerTool("upsert_page_markdown", {
    description: mutationDescription("마크다운으로 페이지 블록 전체를 명시적으로 교체한다."),
    inputSchema: upsertInput.shape,
  }, async (raw) => {
    const parsed = upsertInput.safeParse(raw);
    if (!parsed.success) return errorResult(parsed.error.message);
    return mutation(runtime, parsed.data.caller_session_id, async (client, actor) => {
      const data = parsed.data;
      if (data.title) {
        const blocks = markdownToPageBlocks(data.markdown, {
          title: data.title,
          createId: randomUUID,
        });
        const result = await client.createPage({
          page: { id: randomUUID(), title: data.title, daily_date: null },
          blocks,
          actorSessionId: actor,
          idempotencyKey: data.idempotency_key,
        });
        return { ...result, created: true };
      }
      const current = await client.getPage(data.page_id!, false);
      const blocks = markdownToPageBlocks(data.markdown, {
        title: current.page.title,
        createId: randomUUID,
      });
      const result = await client.replacePageMarkdown({
        pageId: data.page_id!,
        expectedVersion: data.expected_version!,
        blocks,
        actorSessionId: actor,
        idempotencyKey: data.idempotency_key,
      });
      return { ...result, created: false };
    });
  });

  server.registerTool("get_daily_page", {
    description: mutationDescription("Asia/Seoul 기준 데일리 페이지를 멱등 get-or-create한다."),
    inputSchema: { date: date.optional(), caller_session_id: callerSessionId },
  }, async (input) => mutation(runtime, input.caller_session_id, async (client, actor) =>
    await client.getDailyPage({ date: input.date, actorSessionId: actor })));
}

async function handle(
  runtime: McpRuntime,
  fn: (client: PageYjsHostClient) => Promise<unknown>,
) {
  try {
    return jsonResult(await fn(getPageHostClient(runtime)));
  } catch (error) {
    return errorResult(errorMessage(error));
  }
}

async function mutation(
  runtime: McpRuntime,
  explicitCallerSessionId: string | undefined,
  fn: (client: PageYjsHostClient, actorSessionId: string) => Promise<unknown>,
) {
  try {
    const actorSessionId = requireCallerSessionId(explicitCallerSessionId);
    return jsonResult(await fn(getPageHostClient(runtime), actorSessionId));
  } catch (error) {
    return errorResult(errorMessage(error));
  }
}

function getPageHostClient(runtime: McpRuntime): PageYjsHostClient {
  if (runtime.pageHostClient) return runtime.pageHostClient;
  if (!runtime.orch) throw new Error("orchestrator proxy is not configured");
  return new PageYjsHostClient({ orch: runtime.orch, logger: runtime.logger });
}

function requireCallerSessionId(explicit: string | undefined): string {
  const resolved = resolveEffectiveCallerSessionId(explicit);
  if (!resolved) {
    throw new Error(
      `caller session id is required for page mutation tools. Send ${SOULSTREAM_AGENT_SESSION_HEADER}.`,
    );
  }
  return resolved;
}

function mutationDescription(description: string): string {
  return `${description} Codex 등 헤더 미지원 백엔드는 자기 agent_session_id를 caller_session_id로 전달한다.`;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

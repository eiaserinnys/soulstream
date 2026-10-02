import { randomUUID } from "node:crypto";
import { STATUS_CODES } from "node:http";
import { markdownToPageBlocks, pageToMarkdown } from "@soulstream/page-model";
import { batchInput, upsertInput, errorResult, errorResultFromError, jsonResult, readOrchErrorEnvelopeText, type CallToolResult, type pageTools } from "@soulstream/mcp-contract";
import { executePageHostOperation } from "../page/page_host_operations.js";
import type { McpCallContext, McpHostOptions, McpToolHandler } from "./types.js";

type Args = Record<string, unknown>;
export const pageHandlers = {
  get_page: (o, a) => run(() => request(o, "get-page", { page_id: a.page_id, include_blocks: a.include_blocks })),
  find_page: (o, a) => run(() => request(o, "find-page", { title: a.title })),
  get_page_markdown: async (o, a) => {
    try {
      const result = await request(o, "get-page", { page_id: a.page_id, include_blocks: true });
      return { content: [{ type: "text", text: pageToMarkdown(result.page, result.blocks ?? [], { includeBlockIds: a.include_block_ids as boolean }) }] };
    } catch (error) { return errorResultFromError(error); }
  },
  get_backlinks: (o, a) => run(() => request(o, "get-backlinks", { page_id: a.page_id, kinds: a.kinds, cursor: a.cursor, include_self: a.include_self ?? false, limit: a.limit })),
  create_page: (o, a, c) => run(async () => {
    const actor = mutationActor(a, c);
    const result = await request(o, "create-page", { page: { id: a.id ?? randomUUID(), title: a.title, daily_date: a.daily_date ?? null }, ...actor, idempotency_key: a.idempotency_key });
    return { page: result.page, created: true, operation: result.operation };
  }),
  batch_page_operations: async (o, a, c) => {
    const parsed = batchInput.safeParse(a);
    if (!parsed.success) return errorResult(parsed.error.message);
    return run(async () => {
      const data = parsed.data;
      const actor = mutationActor(data, c);
      const result = await request(o, "batch-page-operations", {
        ...(data.page ? { page: { id: data.page.id ?? randomUUID(), title: data.page.title, daily_date: data.page.daily_date ?? null } }
          : { page_id: data.page_id!, expected_version: data.expected_version! }),
        operations: data.operations, ...actor, idempotency_key: data.idempotency_key,
      });
      return { ...result, idempotent: result.idempotent === true };
    });
  },
  upsert_page_markdown: async (o, a, c) => {
    const parsed = upsertInput.safeParse(a);
    if (!parsed.success) return errorResult(parsed.error.message);
    return run(async () => {
      const data = parsed.data;
      const actor = mutationActor(data, c);
      if (data.title) {
        const blocks = markdownToPageBlocks(data.markdown, { title: data.title, createId: randomUUID });
        const result = await request(o, "create-page", { page: { id: randomUUID(), title: data.title, daily_date: null }, blocks, ...actor, idempotency_key: data.idempotency_key });
        return { ...result, created: true };
      }
      const current = await request(o, "get-page", { page_id: data.page_id!, include_blocks: false });
      const blocks = markdownToPageBlocks(data.markdown, { title: current.page.title, createId: randomUUID });
      const result = await request(o, "replace-page-markdown", { page_id: data.page_id!, expected_version: data.expected_version!, blocks, ...actor, idempotency_key: data.idempotency_key });
      return { ...result, created: false };
    });
  },
  get_daily_page: (o, a, c) => run(() => request(o, "get-daily-page", { date: a.date, ...mutationActor(a, c) })),
} satisfies Record<keyof typeof pageTools, McpToolHandler>;

function mutationActor(args: Args, context: McpCallContext) {
  if (context.principal === "external") return { actor_kind: "llm" as const, actor_session_id: null };
  const explicit = typeof args.caller_session_id === "string" ? args.caller_session_id.trim() : "";
  const session = explicit || context.callerSessionId;
  if (!session) throw new Error("caller session id is required for page mutation tools. Send x-soulstream-agent-session-id.");
  return { actor_kind: "agent" as const, actor_session_id: session };
}
async function request(options: McpHostOptions, operation: string, input: Args) {
  const response = await executePageHostOperation(operation, JSON.parse(JSON.stringify(input)), options.pages!.service, options.pages!.logger);
  // Retain the legacy host client's JSON boundary and its exact error envelope.
  const text = JSON.stringify(response.body);
  if (response.status !== 200) {
    const detail = readOrchErrorEnvelopeText({ status: response.status, statusText: STATUS_CODES[response.status] ?? "" }, text);
    throw Object.assign(new Error(`page Yjs host ${operation} failed: ${detail.message}`), { code: detail.code, status: response.status, details: detail.details });
  }
  return JSON.parse(text);
}
async function run(fn: () => Promise<unknown>): Promise<CallToolResult> {
  try { return jsonResult(await fn()); } catch (error) { return errorResultFromError(error); }
}

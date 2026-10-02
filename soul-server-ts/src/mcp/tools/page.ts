import { randomUUID } from "node:crypto";

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  markdownToPageBlocks,
  pageToMarkdown,
  type PageLinkKind,
} from "@soulstream/page-model";
import { pageTools, batchInput, upsertInput } from "@soulstream/mcp-contract";
import { registerOrchestratorTools } from "../orchestrator_tools.js";

import { PageYjsHostClient } from "../../page/page_host_client.js";
import { isCurrentMcpCallerExternal } from "../request_context.js";
import { errorResult, errorResultFromError, jsonResult } from "../result.js";
import type { McpRuntime } from "../runtime.js";
import {
  requireMcpMutationActor,
  type McpMutationActor,
} from "./caller_session.js";

export function registerPageTools(server: McpServer, runtime: McpRuntime): void {
  registerOrchestratorTools(server, runtime, Object.values(pageTools));
}

export function registerPageToolsLegacy(server: McpServer, runtime: McpRuntime): void {
  server.registerTool("get_page", pageTools.get_page.config, async ({ page_id, include_blocks }) => handle(runtime, async (client) =>
    await client.getPage(page_id, include_blocks)));

  server.registerTool("find_page", pageTools.find_page.config, async ({ title }) => handle(runtime, async (client) => await client.findPage(title)));

  server.registerTool("get_page_markdown", pageTools.get_page_markdown.config, async ({ page_id, include_block_ids }) => {
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
      return errorResultFromError(error);
    }
  });

  server.registerTool("get_backlinks", pageTools.get_backlinks.config, async ({ page_id, kinds, cursor, include_self, limit }) => handle(runtime, async (client) =>
    await client.getBacklinks({
      pageId: page_id,
      kinds: kinds as PageLinkKind[],
      cursor,
      includeSelf: include_self ?? false,
      limit,
    })));

  server.registerTool("create_page", pageTools.create_page.config, async (input) => mutation(runtime, input.caller_session_id, async (client, actor) => {
    const result = await client.createPage({
      page: {
        id: input.id ?? randomUUID(),
        title: input.title,
        daily_date: input.daily_date ?? null,
      },
      actorKind: actor.actorKind,
      actorSessionId: actor.actorSessionId,
      idempotencyKey: input.idempotency_key,
    });
    return { page: result.page, created: true, operation: result.operation };
  }));

  server.registerTool("batch_page_operations", { ...pageTools.batch_page_operations.config, inputSchema: isCurrentMcpCallerExternal() ? pageTools.batch_page_operations.externalInputSchema : pageTools.batch_page_operations.config.inputSchema }, async (raw) => {
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
        actor_kind: actor.actorKind,
        actor_session_id: actor.actorSessionId,
        idempotency_key: data.idempotency_key,
      });
      return { ...result, idempotent: result.idempotent === true };
    });
  });

  server.registerTool("upsert_page_markdown", pageTools.upsert_page_markdown.config, async (raw) => {
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
          actorKind: actor.actorKind,
          actorSessionId: actor.actorSessionId,
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
        actorKind: actor.actorKind,
        actorSessionId: actor.actorSessionId,
        idempotencyKey: data.idempotency_key,
      });
      return { ...result, created: false };
    });
  });

  server.registerTool("get_daily_page", pageTools.get_daily_page.config, async (input) => mutation(runtime, input.caller_session_id, async (client, actor) =>
    await client.getDailyPage({
      date: input.date,
      actorKind: actor.actorKind,
      actorSessionId: actor.actorSessionId,
    })));
}

async function handle(
  runtime: McpRuntime,
  fn: (client: PageYjsHostClient) => Promise<unknown>,
) {
  try {
    return jsonResult(await fn(getPageHostClient(runtime)));
  } catch (error) {
    return errorResultFromError(error);
  }
}

async function mutation(
  runtime: McpRuntime,
  explicitCallerSessionId: string | undefined,
  fn: (client: PageYjsHostClient, actor: McpMutationActor) => Promise<unknown>,
) {
  try {
    const actor = requireMcpMutationActor(
      explicitCallerSessionId,
      "page mutation tools",
    );
    return jsonResult(await fn(getPageHostClient(runtime), actor));
  } catch (error) {
    return errorResultFromError(error);
  }
}

function getPageHostClient(runtime: McpRuntime): PageYjsHostClient {
  if (runtime.pageHostClient) return runtime.pageHostClient;
  if (!runtime.orch) throw new Error("orchestrator proxy is not configured");
  return new PageYjsHostClient({ orch: runtime.orch, logger: runtime.logger });
}

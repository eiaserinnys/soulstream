import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import Fastify from "fastify";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { registerPageYjsHostOperationRoutes } from "../../../orch-server-ts/src/page/page_host_operations.js";
import { PageRepository } from "../../../orch-server-ts/src/page/page_repository.js";
import { PageYjsService } from "../../../orch-server-ts/src/page/page_service.js";
import { createLiveDbSqlResolver } from "../../../orch-server-ts/src/runtime/live_db_sql.js";
import {
  createPagePostgresHarness,
  type PagePostgresHarness,
} from "../../../orch-server-ts/tests/page/page_postgres_harness.js";
import type { McpRuntime } from "../../src/mcp/runtime.js";
import { registerPageTools } from "../../src/mcp/tools/page.js";
import { PageYjsHostClient } from "../../src/page/page_host_client.js";

describe("page MCP → orch host complete round-trip", () => {
  let harness: PagePostgresHarness;
  let service: PageYjsService;
  let app: ReturnType<typeof Fastify>;
  let call: (name: string, input: Record<string, unknown>) => Promise<any>;

  beforeAll(async () => {
    harness = await createPagePostgresHarness();
    await harness.sql`INSERT INTO sessions (session_id) VALUES ('agent-session')`;
    const repository = new PageRepository(createLiveDbSqlResolver({ sql: harness.liveSql }));
    let pageSequence = 0;
    service = new PageYjsService({
      repository,
      createPageId: () => `daily-page-${++pageSequence}`,
      now: () => new Date("2026-07-11T15:30:00.000Z"),
    });
    app = Fastify({ logger: false });
    registerPageYjsHostOperationRoutes(app, {
      service,
      authBearerToken: "service-token",
    });
    const address = await app.listen({ host: "127.0.0.1", port: 0 });
    const client = new PageYjsHostClient({
      orch: {
        baseUrl: address,
        headers: { authorization: "Bearer service-token" },
      },
      logger: { warn: vi.fn() } as never,
    });
    call = register(client);
  }, 60_000);

  afterAll(async () => {
    await app?.close();
    await service?.close();
    await harness?.cleanup();
  });

  it("creates, reads, moves, checks, materializes backlinks, and lazily creates KST daily pages", async () => {
    await call("create_page", {
      id: "target-page",
      title: "Target",
      idempotency_key: "create_page:agent-session:target",
      caller_session_id: "agent-session",
    });
    const created = await call("batch_page_operations", {
      page: { id: "source-page", title: "Source", daily_date: null },
      operations: [
        {
          op: "create_block",
          temp_id: "root",
          parent_id: null,
          after_block_id: null,
          block_type: "paragraph",
          text: "[[Target]]",
          properties: {},
        },
        {
          op: "create_block",
          temp_id: "check",
          parent_temp_id: "root",
          parent_id: null,
          after_block_id: null,
          block_type: "checklist",
          text: "Verify",
          properties: { checked: false },
        },
      ],
      idempotency_key: "batch_page_operations:agent-session:create-source",
      caller_session_id: "agent-session",
    });
    if (created.isError) throw new Error(JSON.stringify(created.structuredContent));
    expect(created.structuredContent).toMatchObject({
      page: { id: "source-page", version: 1 },
      operation: {
        operation_type: "batch_operations",
        actor_session_id: "agent-session",
        expected_version: 0,
        result_version: 1,
      },
    });
    const mapping = created.structuredContent.temp_id_mapping as Record<string, string>;

    const firstRead = await call("get_page", { page_id: "source-page", include_blocks: true });
    expect(firstRead.structuredContent.blocks).toHaveLength(2);

    await call("batch_page_operations", {
      page_id: "source-page",
      expected_version: 1,
      operations: [
        {
          op: "move_block",
          block_id: mapping.check,
          parent_id: null,
          after_block_id: mapping.root,
        },
        { op: "set_check_state", block_id: mapping.check, checked: true },
      ],
      idempotency_key: "batch_page_operations:agent-session:move-check",
      caller_session_id: "agent-session",
    });
    const secondRead = await call("get_page", { page_id: "source-page", include_blocks: true });
    expect(secondRead.structuredContent).toMatchObject({ page: { version: 2 } });
    expect(secondRead.structuredContent.blocks).toContainEqual(expect.objectContaining({
      id: mapping.check,
      parent_id: null,
      block_type: "checklist",
      properties: { checked: true },
    }));

    const backlinks = await call("get_backlinks", { page_id: "target-page", limit: 50 });
    expect(backlinks.structuredContent).toMatchObject({
      items: [expect.objectContaining({
        source_page_id: "source-page",
        source_block_id: mapping.root,
        link_kind: "mount",
        target_page_id: "target-page",
      })],
      next_cursor: null,
    });

    const daily = await call("get_daily_page", { caller_session_id: "agent-session" });
    expect(daily.structuredContent).toMatchObject({
      page: { title: "2026년 7월 12일", daily_date: "2026-07-12" },
      created: true,
      operation: { operation_type: "create_page" },
    });
    const repeated = await call("get_daily_page", { caller_session_id: "agent-session" });
    expect(repeated.structuredContent).toMatchObject({
      page: { id: daily.structuredContent.page.id },
      created: false,
    });
  }, 30_000);
});

function register(client: PageYjsHostClient) {
  const handlers = new Map<string, Function>();
  const server = {
    registerTool(name: string, _config: unknown, handler: Function) {
      handlers.set(name, handler);
    },
  } as unknown as McpServer;
  registerPageTools(server, {
    pageHostClient: client,
    logger: { warn: vi.fn() },
  } as unknown as McpRuntime);
  return async (name: string, input: Record<string, unknown>) => {
    const handler = handlers.get(name);
    if (!handler) throw new Error(`tool not registered: ${name}`);
    return await handler(input, {});
  };
}

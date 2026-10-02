import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

import type { CatalogService } from "../../src/catalog/catalog_service.js";
import { SessionDB } from "../../src/db/session_db.js";
import type { McpRuntime } from "../../src/mcp/runtime.js";
import { buildInternalMcpServer } from "../../src/server.js";
import type { TaskExecutor } from "../../src/task/task_executor.js";
import type { TaskManager } from "../../src/task/task_manager.js";
import {
  createFullSchemaPostgresHarness,
  hasFullSchemaPostgresBackend,
  type FullSchemaPostgresHarness,
} from "../db/full_schema_postgres_harness.js";
import { configureTestSessionDataHost } from "../helpers/session_data_test_host.js";
import { startSessionPostgresMcpHost } from "../helpers/session_postgres_mcp_host.js";
import { appendTestEvent } from "../helpers/append_test_event.js";

const describePostgres = hasFullSchemaPostgresBackend ? describe : describe.skip;

describePostgres("tool event PostgreSQL search integration", () => {
  let harness: FullSchemaPostgresHarness | undefined;
  let db: SessionDB;
  const openClients: Client[] = [];
  const openHosts: Awaited<ReturnType<typeof startSessionPostgresMcpHost>>[] = [];
  const openServers: Awaited<ReturnType<typeof buildInternalMcpServer>>[] = [];

  beforeAll(async () => {
    harness = await createFullSchemaPostgresHarness();
    db = new SessionDB();
    configureTestSessionDataHost(db, harness.sql);
    await harness.sql`
      INSERT INTO sessions (
        session_id, display_name, status, session_type, agent_id,
        created_at, updated_at
      ) VALUES (
        'tool-search-session', 'Tool Search', 'completed', 'llm',
        'roselin_codex', NOW(), NOW()
      )
    `;
  }, 45_000);

  afterAll(async () => {
    while (openClients.length > 0) {
      try {
        await openClients.pop()?.close();
      } catch {
        // ignore cleanup failures
      }
    }
    while (openServers.length > 0) {
      const server = openServers.pop();
      try {
        if (server?.closeMcp) await server.closeMcp();
        await server?.close();
      } catch {
        // ignore cleanup failures
      }
    }
    while (openHosts.length > 0) await openHosts.pop()?.app.close();
    await harness?.cleanup();
  }, 15_000);

  function silentLogger() {
    const noop = () => undefined;
    return {
      fatal: noop,
      error: noop,
      warn: noop,
      info: noop,
      debug: noop,
      trace: noop,
      silent: noop,
      level: "silent",
      child: () => silentLogger(),
    } as unknown as McpRuntime["logger"];
  }

  async function createMcpClient(): Promise<Client> {
    const logger = silentLogger();
    const runtime: McpRuntime = {
      nodeId: "node-test",
      agentsConfigPath: "/tmp/agents.yaml",
      db,
      taskManager: {} as TaskManager,
      taskExecutor: {} as TaskExecutor,
      onResume: () => undefined,
      agentRegistry: {} as McpRuntime["agentRegistry"],
      catalogService: {} as CatalogService,
      logger,
    };
    openHosts.push(await startSessionPostgresMcpHost(runtime, harness!));
    const server = await buildInternalMcpServer({
      logger,
      runtime,
      path: "/mcp/internal",
      auth: {
        requireAuth: false,
        bearerToken: "",
        allowedHosts: ["127.0.0.1", "localhost"],
      },
      statelessTransport: true,
    });
    openServers.push(server);
    const baseUrl = await server.listen({ host: "127.0.0.1", port: 0 });
    const client = new Client({ name: "tool-search-postgres-test", version: "0.0.0" });
    await client.connect(new StreamableHTTPClientTransport(new URL(`${baseUrl}/mcp/internal`)));
    openClients.push(client);
    return client;
  }

  it("persists synthetic tool events and finds both through search_session_history MCP", async () => {
    await appendTestEvent(harness!.sql, {
      sessionId: "tool-search-session",
      eventType: "tool_start",
      payload: JSON.stringify({
        type: "tool_start",
        tool_name: "mcp/atom/search_cards",
        tool_input: { query: "침몰선 설계", path: "project/lore" },
      }),
      searchableText: "mcp/atom/search_cards 침몰선 설계 project/lore",
      createdAt: new Date(),
    });
    await appendTestEvent(harness!.sql, {
      sessionId: "tool-search-session",
      eventType: "tool_result",
      payload: JSON.stringify({
        type: "tool_result",
        tool_name: "mcp/atom/search_cards",
        result: "침몰선 설계 카드를 찾았습니다 foundmarker",
        is_error: false,
      }),
      searchableText: "mcp/atom/search_cards 침몰선 설계 카드를 찾았습니다 foundmarker",
      createdAt: new Date(),
    });

    const client = await createMcpClient();
    const starts = await client.callTool({
      name: "search_session_history",
      arguments: {
        query: "project/lore",
        session_ids: ["tool-search-session"],
        event_types: ["tool_start", "tool_result"],
        top_k: 10,
      },
    });
    const results = await client.callTool({
      name: "search_session_history",
      arguments: {
        query: "foundmarker",
        session_ids: ["tool-search-session"],
        event_types: ["tool_start", "tool_result"],
        top_k: 10,
      },
    });

    expect(starts.isError).not.toBe(true);
    expect(starts.structuredContent?.results).toEqual([
      expect.objectContaining({ session_id: "tool-search-session", event_type: "tool_start" }),
    ]);
    expect(results.isError).not.toBe(true);
    expect(results.structuredContent?.results).toEqual([
      expect.objectContaining({ session_id: "tool-search-session", event_type: "tool_result" }),
    ]);
  });

  it("serves the scoped MCP request shape that previously timed out", async () => {
    const query = "cn-characters cn-followups cn-support cn-synopsis glossary-zh-fill glossary-mirror-from-shay retire-glossary-gsheet-sync cn-term-alignment";
    await harness!.sql`
      INSERT INTO sessions (
        session_id, display_name, status, session_type, agent_id,
        created_at, updated_at
      ) VALUES
        ('9e75020a-efce-4e45-bc95-0f50e4ae9fe4', 'MCP search work', 'completed', 'llm', 'roselin_codex', NOW(), NOW()),
        ('fe465d6b-ed53-4df0-a092-5ed1256e237f', 'MCP search diagnostic', 'completed', 'llm', 'roselin_codex', NOW(), NOW())
    `;
    await appendTestEvent(harness!.sql, {
      sessionId: "9e75020a-efce-4e45-bc95-0f50e4ae9fe4",
      eventType: "tool_result",
      payload: JSON.stringify({ type: "tool_result", result: query, is_error: false }),
      searchableText: query,
      createdAt: new Date(),
    });
    await appendTestEvent(harness!.sql, {
      sessionId: "fe465d6b-ed53-4df0-a092-5ed1256e237f",
      eventType: "text_delta",
      payload: JSON.stringify({ type: "text_delta", text: query }),
      searchableText: query,
      createdAt: new Date(),
    });

    const client = await createMcpClient();
    const result = await client.callTool({
      name: "search_session_history",
      arguments: {
        query,
        session_ids: [
          "9e75020a-efce-4e45-bc95-0f50e4ae9fe4",
          "fe465d6b-ed53-4df0-a092-5ed1256e237f",
        ],
        event_types: ["tool_start", "tool_result", "assistant_message", "user_message"],
        top_k: 10,
      },
    });

    expect(result.isError, JSON.stringify(result)).not.toBe(true);
    expect(result.structuredContent?.results).toEqual([
      expect.objectContaining({
        session_id: "9e75020a-efce-4e45-bc95-0f50e4ae9fe4",
        event_type: "tool_result",
      }),
    ]);
  });
});

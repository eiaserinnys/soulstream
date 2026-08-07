/**
 * MCP Streamable HTTP transport 통합 테스트.
 *
 * 실제 fastify를 임의 port에 listen시키고 http fetch로 lifecycle 검증.
 * SDK client smoke는 별도 client.test.ts에서 다룬다 (본 파일은 raw HTTP만).
 */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { buildServer } from "../../src/server.js";
import type { McpRuntime } from "../../src/mcp/runtime.js";
import { CatalogService } from "../../src/catalog/catalog_service.js";
import { SessionDB, type SqlClient } from "../../src/db/session_db.js";
import { AgentRegistry } from "../../src/agent_registry.js";
import type { SessionBroadcaster } from "../../src/upstream/session_broadcaster.js";
import type { TaskManager } from "../../src/task/task_manager.js";
import type { TaskExecutor } from "../../src/task/task_executor.js";

interface MockCall {
  fragments: string[];
  values: unknown[];
}

function createMockSql(resultFor?: (call: MockCall) => unknown[]) {
  const calls: MockCall[] = [];
  const fn = ((strings: TemplateStringsArray, ...values: unknown[]) => {
    const call: MockCall = { fragments: Array.from(strings), values };
    calls.push(call);
    const result = resultFor ? resultFor(call) : [];
    return Promise.resolve(result);
  }) as unknown as SqlClient & {
    array: (a: unknown[]) => unknown[];
    end: () => Promise<void>;
  };
  fn.array = (a: unknown[]) => a;
  fn.end = vi.fn().mockResolvedValue(undefined);
  return { sql: fn as unknown as SqlClient, calls };
}

function createSilentLogger(warn: (...args: unknown[]) => void = () => {}) {
  // pino-compat 최소 표면. 실 logger.warn/error만 호출됨.
  const noop = () => {};
  return {
    fatal: noop,
    error: noop,
    warn,
    info: noop,
    debug: noop,
    trace: noop,
    silent: noop,
    level: "silent",
    child: () => createSilentLogger(),
  } as unknown as McpRuntime["logger"];
}

function makeRuntime(warn: (...args: unknown[]) => void = () => {}): McpRuntime {
  const { sql } = createMockSql();
  const db = new SessionDB();
  const broadcaster = {
    emitCatalogUpdated: vi.fn().mockResolvedValue(undefined),
    emitSessionDeleted: vi.fn().mockResolvedValue(undefined),
  } as unknown as SessionBroadcaster;
  const catalogService = new CatalogService(db, broadcaster);
  const agentRegistry = new AgentRegistry([
    {
      id: "codex-default",
      name: "Codex",
      backend: "codex",
      workspace_dir: "/tmp/codex-ws",
    },
  ]);
  const taskManager = {
    listTasks: () => [],
    getTask: () => undefined,
  } as unknown as TaskManager;
  const taskExecutor = {} as unknown as TaskExecutor;
  return {
    nodeId: "test-node",
    agentsConfigPath: "/tmp/agents.yaml",
    db,
    taskManager,
    taskExecutor,
    agentRegistry,
    catalogService,
    logger: createSilentLogger(warn),
  };
}

describe("MCP transport lifecycle (raw HTTP)", () => {
  let server: Awaited<ReturnType<typeof buildServer>>;
  let baseUrl: string;
  const warning = vi.fn();

  beforeAll(async () => {
    server = await buildServer({
      host: "127.0.0.1",
      port: 0,
      nodeId: "test-node",
      logger: createSilentLogger(),
      mcp: {
        runtime: makeRuntime(warning),
        path: "/mcp",
        auth: {
          requireAuth: false,
          bearerToken: "",
          allowedHosts: ["127.0.0.1", "localhost"],
        },
      },
    });
    const addr = await server.listen({ host: "127.0.0.1", port: 0 });
    baseUrl = addr;
  });

  afterAll(async () => {
    if (server.closeMcp) await server.closeMcp();
    await server.close();
  });

  it("POST /mcp without session, non-initialize → 400", async () => {
    const res = await fetch(`${baseUrl}/mcp`, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        method: "tools/list",
        params: {},
        id: 1,
      }),
    });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBeDefined();
  });

  it("POST /mcp with unknown session id → 404", async () => {
    const res = await fetch(`${baseUrl}/mcp`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        "mcp-session-id": "nonexistent",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        method: "tools/list",
        params: {},
        id: 1,
      }),
    });
    expect(res.status).toBe(404);
  });

  it("GET /mcp without session id → 400", async () => {
    const res = await fetch(`${baseUrl}/mcp`, { method: "GET" });
    expect(res.status).toBe(400);
  });

  it("DELETE /mcp without session id → 400", async () => {
    const res = await fetch(`${baseUrl}/mcp`, { method: "DELETE" });
    expect(res.status).toBe(400);
  });

  it("POST /mcp initialize → 200 + Mcp-Session-Id 헤더", async () => {
    const res = await fetch(`${baseUrl}/mcp`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        method: "initialize",
        params: {
          protocolVersion: "2024-11-05",
          capabilities: {},
          clientInfo: { name: "test-client", version: "0.0.0" },
        },
        id: 1,
      }),
    });
    expect(res.status).toBe(200);
    const sessionId = res.headers.get("mcp-session-id");
    expect(sessionId).toBeTruthy();
    // body stream을 끝까지 drain하여 transport가 cleanup하도록.
    await res.text();
  });

  it("rejects unknown caller origin on initialize", async () => {
    const res = await initialize(baseUrl, "unknown");
    expect(res.status).toBe(400);
    expect(await res.text()).toContain("unsupported caller origin");
  });

  it("pins llm origin when later requests omit the origin header", async () => {
    const initialized = await initialize(baseUrl, "llm");
    expect(initialized.status).toBe(200);
    const sessionId = initialized.headers.get("mcp-session-id");
    expect(sessionId).toBeTruthy();
    await initialized.text();

    const listed = await mcpPost(baseUrl, sessionId!, {
      jsonrpc: "2.0",
      method: "tools/list",
      params: {},
      id: 2,
    });
    const payload = await rpcPayload(listed);
    const tools = payload.result.tools as Array<{
      name: string;
      inputSchema: unknown;
    }>;
    expect(tools.map((tool) => tool.name)).toEqual(
      expect.arrayContaining([
        "create_agent_session",
        "create_remote_agent_session",
        "create_task",
        "archive_task",
        "batch_page_operations",
      ]),
    );
    expect(tools.map((tool) => tool.name)).not.toEqual(
      expect.arrayContaining([
        "delete_folder",
        "delete_markdown_document",
        "delete_session",
      ]),
    );
    const batch = tools.find((tool) => tool.name === "batch_page_operations");
    expect(JSON.stringify(batch?.inputSchema)).not.toContain(
      "delete_block_subtree",
    );

    const directDelete = await mcpPost(baseUrl, sessionId!, {
      jsonrpc: "2.0",
      method: "tools/call",
      params: {
        name: "delete_session",
        arguments: { session_id: "sess-do-not-delete" },
      },
      id: 5,
    });
    const deletePayload = await rpcPayload(directDelete);
    expect(deletePayload.result.isError).toBe(true);
    expect(JSON.stringify(deletePayload.result)).toContain("delete_session");
    expect(warning).toHaveBeenCalledWith(
      { callerOrigin: "llm", toolName: "delete_session" },
      "Blocked destructive MCP tool for external LLM caller",
    );

    const nestedDelete = await mcpPost(baseUrl, sessionId!, {
      jsonrpc: "2.0",
      method: "tools/call",
      params: {
        name: "batch_page_operations",
        arguments: {
          page_id: "page-do-not-delete",
          operations: [
            { op: "delete_block_subtree", block_id: "block-do-not-delete" },
          ],
        },
      },
      id: 6,
    });
    const nestedDeletePayload = await rpcPayload(nestedDelete);
    expect(nestedDeletePayload.result.isError).toBe(true);
    expect(JSON.stringify(nestedDeletePayload.result)).toContain(
      "batch_page_operations",
    );
    expect(warning).toHaveBeenCalledWith(
      { callerOrigin: "llm", toolName: "batch_page_operations" },
      "Blocked destructive MCP tool for external LLM caller",
    );
  });

  it("does not upgrade an existing internal session when llm is added later", async () => {
    const initialized = await initialize(baseUrl);
    const sessionId = initialized.headers.get("mcp-session-id");
    expect(sessionId).toBeTruthy();
    await initialized.text();

    const listed = await mcpPost(
      baseUrl,
      sessionId!,
      {
        jsonrpc: "2.0",
        method: "tools/list",
        params: {},
        id: 3,
      },
      "llm",
    );
    const payload = await rpcPayload(listed);
    expect(
      (payload.result.tools as Array<{ name: string }>).map((tool) => tool.name),
    ).toContain("delete_session");
  });

  it("rejects unknown origin on an existing session follow-up", async () => {
    const initialized = await initialize(baseUrl);
    const sessionId = initialized.headers.get("mcp-session-id");
    expect(sessionId).toBeTruthy();
    await initialized.text();

    const res = await mcpPost(
      baseUrl,
      sessionId!,
      { jsonrpc: "2.0", method: "tools/list", params: {}, id: 4 },
      "unknown",
    );
    expect(res.status).toBe(400);
    expect(await res.text()).toContain("unsupported caller origin");
  });

  it("rejects unknown origin on existing-session GET and DELETE follow-ups", async () => {
    const initialized = await initialize(baseUrl, "llm");
    const sessionId = initialized.headers.get("mcp-session-id");
    expect(sessionId).toBeTruthy();
    await initialized.text();

    for (const method of ["GET", "DELETE"]) {
      const response = await fetch(`${baseUrl}/mcp`, {
        method,
        headers: {
          "mcp-session-id": sessionId!,
          "x-soulstream-caller-origin": "unknown",
        },
      });
      expect(response.status).toBe(400);
      expect(await response.text()).toContain("unsupported caller origin");
    }

    const stillOpen = await mcpPost(baseUrl, sessionId!, {
      jsonrpc: "2.0",
      method: "tools/list",
      params: {},
      id: 7,
    });
    expect((await rpcPayload(stillOpen)).result.tools).toBeDefined();
  });
});

describe("MCP Host header guard", () => {
  let server: Awaited<ReturnType<typeof buildServer>>;
  let baseUrl: string;

  beforeAll(async () => {
    server = await buildServer({
      host: "127.0.0.1",
      port: 0,
      nodeId: "test-node",
      logger: createSilentLogger(),
      mcp: {
        runtime: makeRuntime(),
        path: "/mcp",
        auth: {
          requireAuth: false,
          bearerToken: "",
          allowedHosts: ["example.com"], // 의도적으로 127.0.0.1 불포함
        },
      },
    });
    const addr = await server.listen({ host: "127.0.0.1", port: 0 });
    baseUrl = addr;
  });

  afterAll(async () => {
    if (server.closeMcp) await server.closeMcp();
    await server.close();
  });

  it("Host 헤더 미허용 → 403", async () => {
    const res = await fetch(`${baseUrl}/mcp`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
      },
      body: JSON.stringify({ jsonrpc: "2.0", method: "initialize", id: 1 }),
    });
    expect(res.status).toBe(403);
  });
});

describe("MCP bearer auth guard", () => {
  let server: Awaited<ReturnType<typeof buildServer>>;
  let baseUrl: string;

  beforeAll(async () => {
    server = await buildServer({
      host: "127.0.0.1",
      port: 0,
      nodeId: "test-node",
      logger: createSilentLogger(),
      mcp: {
        runtime: makeRuntime(),
        path: "/mcp",
        auth: {
          requireAuth: true,
          bearerToken: "secret-token",
          allowedHosts: ["127.0.0.1", "localhost"],
        },
      },
    });
    const addr = await server.listen({ host: "127.0.0.1", port: 0 });
    baseUrl = addr;
  });

  afterAll(async () => {
    if (server.closeMcp) await server.closeMcp();
    await server.close();
  });

  it("Authorization 누락 → 401", async () => {
    const res = await fetch(`${baseUrl}/mcp`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
      },
      body: JSON.stringify({ jsonrpc: "2.0", method: "initialize", id: 1 }),
    });
    expect(res.status).toBe(401);
  });

  it("올바른 bearer → 통과 (initialize 성공)", async () => {
    const res = await fetch(`${baseUrl}/mcp`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        authorization: "Bearer secret-token",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        method: "initialize",
        params: {
          protocolVersion: "2024-11-05",
          capabilities: {},
          clientInfo: { name: "test", version: "0.0.0" },
        },
        id: 1,
      }),
    });
    expect(res.status).toBe(200);
    await res.text();
  });
});

function initialize(baseUrl: string, origin?: string): Promise<Response> {
  return fetch(`${baseUrl}/mcp`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      ...(origin ? { "x-soulstream-caller-origin": origin } : {}),
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      method: "initialize",
      params: {
        protocolVersion: "2024-11-05",
        capabilities: {},
        clientInfo: { name: "origin-test", version: "0.0.0" },
      },
      id: 1,
    }),
  });
}

function mcpPost(
  baseUrl: string,
  sessionId: string,
  body: Record<string, unknown>,
  origin?: string,
): Promise<Response> {
  return fetch(`${baseUrl}/mcp`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      "mcp-session-id": sessionId,
      ...(origin ? { "x-soulstream-caller-origin": origin } : {}),
    },
    body: JSON.stringify(body),
  });
}

async function rpcPayload(response: Response): Promise<Record<string, any>> {
  expect(response.status).toBe(200);
  const text = await response.text();
  const data = text
    .split("\n")
    .find((line) => line.startsWith("data: "))
    ?.slice("data: ".length);
  return JSON.parse(data ?? text) as Record<string, any>;
}

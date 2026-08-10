import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { afterEach, describe, expect, it, vi } from "vitest";

import { AgentRegistry } from "../../src/agent_registry.js";
import type { CatalogService } from "../../src/catalog/catalog_service.js";
import type { SessionDB } from "../../src/db/session_db.js";
import {
  getCurrentMcpCallerSessionId,
} from "../../src/mcp/request_context.js";
import type { McpRuntime } from "../../src/mcp/runtime.js";
import { buildServer } from "../../src/server.js";
import type { TaskExecutor } from "../../src/task/task_executor.js";
import type { TaskManager } from "../../src/task/task_manager.js";

let server: Awaited<ReturnType<typeof buildServer>> | undefined;
let client: Client | undefined;

afterEach(async () => {
  try {
    await client?.close();
  } catch {
    // A stateless server may already be closed by the restart test.
  }
  client = undefined;
  if (server) {
    if (server.closeMcp) await server.closeMcp();
    await server.close();
    server = undefined;
  }
});

describe("MCP stateless restart recovery", () => {
  it("does not issue a session id and accepts a follow-up carrying a stale id", async () => {
    server = await buildStatelessServer(makeRuntime());
    const baseUrl = await server.listen({ host: "127.0.0.1", port: 0 });

    const initialized = await post(baseUrl, undefined, {
      jsonrpc: "2.0",
      method: "initialize",
      params: {
        protocolVersion: "2024-11-05",
        capabilities: {},
        clientInfo: { name: "stateless-test", version: "0.0.0" },
      },
      id: 1,
    });
    expect(initialized.status).toBe(200);
    expect(initialized.headers.get("mcp-session-id")).toBeNull();
    await initialized.text();

    const listed = await post(baseUrl, "stale-before-restart", {
      jsonrpc: "2.0",
      method: "tools/list",
      params: {},
      id: 2,
    });
    expect((await rpcPayload(listed)).result.tools).toBeDefined();

    for (const method of ["GET", "DELETE"]) {
      const response = await fetch(`${baseUrl}/mcp`, { method });
      expect(response.status).toBe(405);
    }
  });

  it("keeps one SDK client lossless across request-scoped transport replacement and preserves caller ownership", async () => {
    const callerSessionIds: Array<string | undefined> = [];
    const runtime = makeRuntime();
    runtime.agentProfileSource = {
      async list() {
        callerSessionIds.push(getCurrentMcpCallerSessionId());
        return [{
          profile: {
            id: "codex-default",
            name: "Codex",
            backend: "codex",
            workspace_dir: "/tmp/codex-ws",
          },
          source: "yaml",
          stale: false,
        }];
      },
    } as never;

    server = await buildStatelessServer(runtime);
    const baseUrl = await server.listen({ host: "127.0.0.1", port: 0 });
    client = new Client({ name: "stateless-restart-test", version: "0.0.0" });
    await client.connect(new StreamableHTTPClientTransport(
      new URL(`${baseUrl}/mcp`),
      {
        requestInit: {
          headers: {
            "x-soulstream-agent-session-id": "caller-session-1",
          },
        },
      },
    ));

    expect((await client.callTool({
      name: "list_local_agents",
      arguments: {},
    })).isError).not.toBe(true);

    // Stateless mode discards the transport and McpServer after every POST.
    // The second call therefore crosses the same MCP-state-loss boundary as a
    // worker restart, without coupling this contract to TCP socket handover.
    expect((await client.callTool({
      name: "list_local_agents",
      arguments: {},
    })).isError).not.toBe(true);
    expect(callerSessionIds).toEqual([
      "caller-session-1",
      "caller-session-1",
    ]);
  });

  it("pins the stateless principal to llm when origin and session headers are omitted or forged", async () => {
    const runtime = makeRuntime();
    const createTask = vi.fn(async (params: { agentSessionId: string }) => ({
      agentSessionId: params.agentSessionId,
      status: "pending",
    }));
    runtime.taskManager = {
      listTasks: () => [],
      getTask: () => undefined,
      createTask,
    } as unknown as TaskManager;
    runtime.taskExecutor = { startExecution: vi.fn() } as unknown as TaskExecutor;
    runtime.agentRegistry = new AgentRegistry([{
      id: "codex-default",
      name: "Codex",
      backend: "codex",
      workspace_dir: "/tmp/codex-ws",
    }]);

    server = await buildStatelessServer(runtime);
    const baseUrl = await server.listen({ host: "127.0.0.1", port: 0 });

    for (const origin of [undefined, "internal"] as const) {
      const listed = await post(
        baseUrl,
        undefined,
        { jsonrpc: "2.0", method: "tools/list", params: {}, id: 10 },
        {
          "x-soulstream-agent-session-id": "spoofed-header-session",
          ...(origin ? { "x-soulstream-caller-origin": origin } : {}),
        },
      );
      const toolNames = (await rpcPayload(listed)).result.tools.map(
        (tool: { name: string }) => tool.name,
      );
      expect(toolNames).not.toContain("delete_session");
    }

    const created = await post(
      baseUrl,
      undefined,
      {
        jsonrpc: "2.0",
        method: "tools/call",
        params: {
          name: "create_agent_session",
          arguments: {
            agent_id: "codex-default",
            prompt: "do not trust the claimed parent",
            caller_session_id: "spoofed-body-session",
          },
        },
        id: 11,
      },
      {
        "x-soulstream-agent-session-id": "spoofed-header-session",
        "x-soulstream-caller-origin": "internal",
      },
    );
    expect((await rpcPayload(created)).result.isError).not.toBe(true);
    expect(createTask).toHaveBeenCalledWith(expect.objectContaining({
      callerSessionId: null,
      callerInfo: expect.objectContaining({ source: "llm" }),
    }));
  });
});

function buildStatelessServer(runtime: McpRuntime) {
  return buildServer({
    host: "127.0.0.1",
    port: 0,
    nodeId: "test-node",
    logger: createSilentLogger(),
    mcp: {
      runtime,
      path: "/mcp",
      statelessTransport: true,
      auth: {
        requireAuth: false,
        bearerToken: "",
        allowedHosts: ["127.0.0.1", "localhost"],
      },
    },
  });
}

function makeRuntime(): McpRuntime {
  return {
    nodeId: "test-node",
    agentsConfigPath: "/tmp/agents.yaml",
    db: {} as SessionDB,
    taskManager: {
      listTasks: () => [],
      getTask: () => undefined,
    } as unknown as TaskManager,
    taskExecutor: {} as TaskExecutor,
    agentRegistry: new AgentRegistry([]),
    catalogService: {} as CatalogService,
    logger: createSilentLogger(),
  };
}

function createSilentLogger() {
  const noop = () => {};
  return {
    fatal: noop,
    error: noop,
    warn: noop,
    info: noop,
    debug: noop,
    trace: noop,
    silent: noop,
    level: "silent",
    child: () => createSilentLogger(),
  } as unknown as McpRuntime["logger"];
}

function post(
  baseUrl: string,
  sessionId: string | undefined,
  body: Record<string, unknown>,
  headers: Record<string, string> = {},
): Promise<Response> {
  return fetch(`${baseUrl}/mcp`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      ...(sessionId ? { "mcp-session-id": sessionId } : {}),
      ...headers,
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

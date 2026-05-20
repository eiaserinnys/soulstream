import http from "node:http";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { afterEach, describe, expect, it, vi } from "vitest";

import { AgentRegistry } from "../../src/agent_registry.js";
import type { CatalogService } from "../../src/catalog/catalog_service.js";
import type { SessionDB } from "../../src/db/session_db.js";
import type { McpRuntime, OrchProxyConfig } from "../../src/mcp/runtime.js";
import { buildServer } from "../../src/server.js";
import type { TaskExecutor } from "../../src/task/task_executor.js";
import type {
  AddInterventionParams,
  AddInterventionResult,
  StartExecutionCallback,
  TaskManager,
} from "../../src/task/task_manager.js";
import type { AgentProfile } from "../../src/agent_registry.js";

const openClients: Client[] = [];
const openServers: Awaited<ReturnType<typeof buildServer>>[] = [];

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

function makeRuntime(
  addInterventionResult: AddInterventionResult | Error,
  orch?: OrchProxyConfig,
  agents?: AgentProfile[],
): McpRuntime & {
  addIntervention: ReturnType<typeof vi.fn>;
  createTask: ReturnType<typeof vi.fn>;
  startExecution: ReturnType<typeof vi.fn>;
} {
  const addIntervention = vi.fn(
    async (_p: AddInterventionParams, _r: StartExecutionCallback) => {
      if (addInterventionResult instanceof Error) throw addInterventionResult;
      return addInterventionResult;
    },
  );
  const createTask = vi.fn(async (params) => ({
    agentSessionId: params.agentSessionId,
    status: "running" as const,
  }));
  const startExecution = vi.fn();
  const taskManager = {
    createTask,
    addIntervention,
    getTask: vi.fn((sessionId: string) =>
      sessionId === "caller-sess-1" ? { profileId: "codex-default" } : undefined,
    ),
    listTasks: vi.fn(() => []),
  } as unknown as TaskManager;
  const agentRegistry = new AgentRegistry(agents ?? [
    {
      id: "codex-default",
      name: "Codex Default",
      backend: "codex",
      workspace_dir: "/tmp/codex",
      portrait_path: "portraits/codex.png",
    },
  ]);
  return {
    nodeId: "node-test",
    db: {} as SessionDB,
    taskManager,
    taskExecutor: { startExecution } as unknown as TaskExecutor,
    agentRegistry,
    catalogService: {} as CatalogService,
    logger: createSilentLogger(),
    orch,
    addIntervention,
    createTask,
    startExecution,
  };
}

async function createClient(runtime: McpRuntime): Promise<Client> {
  const server = await buildServer({
    host: "127.0.0.1",
    port: 0,
    nodeId: runtime.nodeId,
    logger: createSilentLogger(),
    mcp: {
      runtime,
      path: "/mcp",
      auth: {
        requireAuth: false,
        bearerToken: "",
        allowedHosts: ["127.0.0.1", "localhost"],
      },
    },
  });
  openServers.push(server);
  const baseUrl = await server.listen({ host: "127.0.0.1", port: 0 });
  const client = new Client({ name: "session-mgmt-test", version: "0.0.0" });
  await client.connect(new StreamableHTTPClientTransport(new URL(`${baseUrl}/mcp`)));
  openClients.push(client);
  return client;
}

interface CapturedRequest {
  method?: string;
  url?: string;
  headers: http.IncomingHttpHeaders;
  body: string;
}

async function createOrchCapture(status = 200): Promise<{
  orch: OrchProxyConfig;
  requests: CapturedRequest[];
  close: () => Promise<void>;
}> {
  const requests: CapturedRequest[] = [];
  const server = http.createServer((req, res) => {
    let body = "";
    req.setEncoding("utf8");
    req.on("data", (chunk) => {
      body += chunk;
    });
    req.on("end", () => {
      requests.push({
        method: req.method,
        url: req.url,
        headers: req.headers,
        body,
      });
      res.writeHead(status, {
        "content-type": "application/json",
      });
      res.end("{}");
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("listen failed");
  return {
    orch: {
      baseUrl: `http://127.0.0.1:${address.port}`,
      headers: { authorization: "Bearer test-token" },
    },
    requests,
    close: () =>
      new Promise<void>((resolve, reject) =>
        server.close((err) => (err ? reject(err) : resolve())),
      ),
  };
}

afterEach(async () => {
  while (openClients.length > 0) {
    const client = openClients.pop();
    try {
      await client?.close();
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
});

describe("agent profile backend boundary", () => {
  const codexAgent: AgentProfile = {
    id: "codex-default",
    name: "로젤린",
    backend: "codex",
    workspace_dir: "/tmp/codex",
  };
  const claudeAgent: AgentProfile = {
    id: "claude-roselin",
    name: "로젤린",
    backend: "claude",
    workspace_dir: "/tmp/claude",
  };

  it("list_local_agents는 executable backend agent만 backend와 함께 반환", async () => {
    const runtime = makeRuntime(
      { queued: true, queuePosition: 1 },
      undefined,
      [codexAgent, claudeAgent],
    );
    const client = await createClient(runtime);

    const result = await client.callTool({
      name: "list_local_agents",
      arguments: {},
    });

    expect(result.isError).not.toBe(true);
    expect(result.structuredContent).toEqual({
      agents: [
        {
          id: "codex-default",
          name: "로젤린",
          backend: "codex",
          max_turns: null,
        },
      ],
    });
  });

  it("create_agent_session은 engine 미지원 backend profile을 task 생성 전 차단", async () => {
    const runtime = makeRuntime(
      { queued: true, queuePosition: 1 },
      undefined,
      [codexAgent, claudeAgent],
    );
    const client = await createClient(runtime);

    const result = await client.callTool({
      name: "create_agent_session",
      arguments: {
        agent_id: "claude-roselin",
        prompt: "hi",
      },
    });

    expect(result.isError).toBe(true);
    expect((result.structuredContent as { error?: string }).error).toContain(
      "Unsupported backend",
    );
    expect(runtime.createTask).not.toHaveBeenCalled();
    expect(runtime.startExecution).not.toHaveBeenCalled();
  });

  it("reflect_service level=3은 executable agent 수와 configured profile 수를 분리", async () => {
    const runtime = makeRuntime(
      { queued: true, queuePosition: 1 },
      undefined,
      [codexAgent, claudeAgent],
    );
    const client = await createClient(runtime);

    const result = await client.callTool({
      name: "reflect_service",
      arguments: { service: "soul-server-ts", level: 3 },
    });

    expect(result.isError).not.toBe(true);
    expect(result.structuredContent).toMatchObject({
      agent_count: 1,
      configured_agent_count: 2,
      executable_backends: ["codex"],
    });
  });
});

describe("send_message_to_session", () => {
  it("local delivery succeeds without orch fallback", async () => {
    const runtime = makeRuntime({ queued: true, queuePosition: 1 });
    const client = await createClient(runtime);

    const result = await client.callTool({
      name: "send_message_to_session",
      arguments: {
        target_session_id: "target-sess-1",
        message: "hello",
        caller_session_id: "caller-sess-1",
      },
    });

    expect(result.isError).not.toBe(true);
    expect(result.structuredContent).toEqual({
      ok: true,
      detail: { queued: true, queuePosition: 1 },
    });
    expect(runtime.addIntervention).toHaveBeenCalledTimes(1);
    const params = runtime.addIntervention.mock.calls[0]![0] as AddInterventionParams;
    expect(params.agentSessionId).toBe("target-sess-1");
    expect(params.text).toBe("hello");
    expect(params.user).toBe("agent");
    expect(params.callerInfo?.source).toBe("agent");
    expect(params.callerInfo?.agent_node).toBe("node-test");
    expect(params.callerInfo?.agent_id).toBe("codex-default");
  });

  it("local failure falls back to orch /intervene with snake_case caller_info", async () => {
    const capture = await createOrchCapture();
    try {
      const runtime = makeRuntime(new Error("Task not found: target-sess-2"), capture.orch);
      const client = await createClient(runtime);

      const result = await client.callTool({
        name: "send_message_to_session",
        arguments: {
          target_session_id: "target-sess-2",
          message: "cross-node hello",
          caller_session_id: "caller-sess-1",
        },
      });

      expect(result.isError).not.toBe(true);
      expect(result.structuredContent).toEqual({
        ok: true,
        detail: {
          relayed: true,
          target_session_id: "target-sess-2",
          local_error: "Task not found: target-sess-2",
        },
      });
      expect(capture.requests).toHaveLength(1);
      const req = capture.requests[0]!;
      expect(req.method).toBe("POST");
      expect(req.url).toBe("/api/sessions/target-sess-2/intervene");
      expect(req.headers.authorization).toBe("Bearer test-token");
      expect(req.headers["content-type"]).toMatch(/^application\/json/);
      const body = JSON.parse(req.body);
      expect(body.text).toBe("cross-node hello");
      expect(body.user).toBe("agent");
      expect(body.caller_info).toBeDefined();
      expect(body.caller_info.source).toBe("agent");
      expect(body.caller_info.agent_node).toBe("node-test");
      expect(body.caller_info.agent_id).toBe("codex-default");
      expect(body.callerInfo).toBeUndefined();
    } finally {
      await capture.close();
    }
  });

  it("local failure without orch reports explicit fallback unavailability", async () => {
    const runtime = makeRuntime(new Error("Task not found: target-sess-3"));
    const client = await createClient(runtime);

    const result = await client.callTool({
      name: "send_message_to_session",
      arguments: {
        target_session_id: "target-sess-3",
        message: "hello",
      },
    });

    expect(result.isError).not.toBe(true);
    expect(result.structuredContent).toEqual({
      ok: false,
      error: "Task not found: target-sess-3",
      fallback_error: "orch fallback unavailable",
    });
  });

  it("orch non-2xx response returns ok=false with fallback_error", async () => {
    const capture = await createOrchCapture(502);
    try {
      const runtime = makeRuntime(new Error("Task not found: target-sess-4"), capture.orch);
      const client = await createClient(runtime);

      const result = await client.callTool({
        name: "send_message_to_session",
        arguments: {
          target_session_id: "target-sess-4",
          message: "hello",
        },
      });

      expect(result.isError).not.toBe(true);
      expect(result.structuredContent).toEqual({
        ok: false,
        error: "Task not found: target-sess-4",
        fallback_error:
          "orch POST /api/sessions/target-sess-4/intervene failed: 502 Bad Gateway",
      });
    } finally {
      await capture.close();
    }
  });
});

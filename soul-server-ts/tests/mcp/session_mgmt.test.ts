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
  callerFolderId: string | null = "caller-folder",
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
    agentsConfigPath: "/tmp/agents.yaml",
    db: {
      getSession: vi.fn(async (sessionId: string) =>
        sessionId === "caller-sess-1" ? { folder_id: callerFolderId } : null,
      ),
    } as unknown as SessionDB,
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

async function createClient(
  runtime: McpRuntime,
  headers?: Record<string, string>,
): Promise<Client> {
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
  await client.connect(new StreamableHTTPClientTransport(
    new URL(`${baseUrl}/mcp`),
    headers ? { requestInit: { headers } } : undefined,
  ));
  openClients.push(client);
  return client;
}

interface CapturedRequest {
  method?: string;
  url?: string;
  headers: http.IncomingHttpHeaders;
  body: string;
}

interface CapturedResponse {
  status?: number;
  body?: unknown;
}

async function createOrchCapture(
  status = 200,
  handler?: (request: CapturedRequest) => CapturedResponse,
): Promise<{
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
      const captured = requests[requests.length - 1]!;
      const response = handler?.(captured) ?? { status, body: {} };
      res.writeHead(response.status ?? status, {
        "content-type": "application/json",
      });
      res.end(JSON.stringify(response.body ?? {}));
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

  it("list_local_agents는 registry agent를 backend와 함께 모두 반환", async () => {
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
        {
          id: "claude-roselin",
          name: "로젤린",
          backend: "claude",
          max_turns: null,
        },
      ],
    });
  });

  it("create_agent_session은 선택한 backend profile을 executor에 그대로 전달", async () => {
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

    expect(result.isError).not.toBe(true);
    expect(result.structuredContent).toMatchObject({
      status: "running",
    });
    expect(runtime.createTask).toHaveBeenCalledTimes(1);
    expect(runtime.startExecution).toHaveBeenCalledWith(
      expect.objectContaining({ agentSessionId: expect.any(String) }),
      claudeAgent,
    );
  });

  it("create_agent_session은 caller_session_id와 caller_info를 로컬 task에 보존한다", async () => {
    const runtime = makeRuntime(
      { queued: true, queuePosition: 1 },
      undefined,
      [codexAgent, claudeAgent],
    );
    const client = await createClient(runtime);

    const result = await client.callTool({
      name: "create_agent_session",
      arguments: {
        agent_id: "codex-default",
        prompt: "child work",
        caller_session_id: "caller-sess-1",
        folder_id: "folder-1",
      },
    });

    expect(result.isError).not.toBe(true);
    expect(runtime.createTask).toHaveBeenCalledTimes(1);
    expect(runtime.createTask).toHaveBeenCalledWith(
      expect.objectContaining({
        prompt: "child work",
        profileId: "codex-default",
        callerSessionId: "caller-sess-1",
        folderId: "folder-1",
        callerInfo: expect.objectContaining({
          source: "agent",
          agent_node: "node-test",
          agent_id: "codex-default",
        }),
      }),
    );
  });

  it("create_agent_session은 MCP 요청 header의 caller id를 로컬 task에 보존한다", async () => {
    const runtime = makeRuntime(
      { queued: true, queuePosition: 1 },
      undefined,
      [codexAgent, claudeAgent],
    );
    const client = await createClient(runtime, {
      "x-soulstream-agent-session-id": "caller-sess-1",
    });

    const result = await client.callTool({
      name: "create_agent_session",
      arguments: {
        agent_id: "codex-default",
        prompt: "child work",
      },
    });

    expect(result.isError).not.toBe(true);
    expect(runtime.createTask).toHaveBeenCalledWith(
      expect.objectContaining({
        callerSessionId: "caller-sess-1",
        callerInfo: expect.objectContaining({
          source: "agent",
          agent_node: "node-test",
          agent_id: "codex-default",
        }),
      }),
    );
  });

  it("reflect_service level=3은 typed runtime snapshot 안에 registry agent 수를 보고", async () => {
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
      schema_version: "soulstream.reflect.v1",
      agent_count: 2,
      data: {
        counts: {
          agent_count: 2,
        },
        dependencies: {
          database: {
            status: "unavailable",
          },
        },
      },
    });
  });
});

describe("create_remote_agent_session", () => {
  it("agent_id는 대상 노드의 정확한 id와 일치해야 하며 표시명/접두어 휴리스틱으로 해석하지 않는다", async () => {
    const capture = await createOrchCapture(200, (req) => {
      if (req.method === "GET" && req.url === "/api/nodes/node-remote/agents") {
        return {
          body: {
            agents: [
              {
                id: "roselin_codex",
                name: "로젤린 (codex)",
                backend: "codex",
              },
            ],
          },
        };
      }
      return { body: { agentSessionId: "should-not-create" } };
    });
    try {
      const runtime = makeRuntime({ queued: true, queuePosition: 1 }, capture.orch);
      const client = await createClient(runtime);

      const result = await client.callTool({
        name: "create_remote_agent_session",
        arguments: {
          node_id: "node-remote",
          agent_id: "roselin",
          prompt: "delegate",
          caller_session_id: "caller-sess-1",
        },
      });

      expect(result.isError).toBe(true);
      const structured = result.structuredContent as { error?: string };
      expect(structured.error).toContain("agent_id를 찾을 수 없습니다: roselin");
      expect(structured.error).toContain("roselin_codex");
      expect(capture.requests.map((r) => `${r.method} ${r.url}`)).toEqual([
        "GET /api/nodes/node-remote/agents",
      ]);
    } finally {
      await capture.close();
    }
  });

  it("agent_id가 정확히 일치하면 검증 후 /api/sessions에 그대로 전달한다", async () => {
    const capture = await createOrchCapture(200, (req) => {
      if (req.method === "GET" && req.url === "/api/nodes/node-remote/agents") {
        return {
          body: {
            agents: [
              {
                id: "roselin_codex",
                name: "로젤린 (codex)",
                backend: "codex",
              },
            ],
          },
        };
      }
      if (req.method === "POST" && req.url === "/api/sessions") {
        return { body: { agentSessionId: "sess-child", nodeId: "node-remote" } };
      }
      return { status: 404, body: { error: "unexpected route" } };
    });
    try {
      const runtime = makeRuntime({ queued: true, queuePosition: 1 }, capture.orch);
      const client = await createClient(runtime);

      const result = await client.callTool({
        name: "create_remote_agent_session",
        arguments: {
          node_id: "node-remote",
          agent_id: "roselin_codex",
          prompt: "delegate",
          caller_session_id: "caller-sess-1",
          folder_id: "folder-1",
        },
      });

      expect(result.isError).not.toBe(true);
      expect(result.structuredContent).toEqual({
        agentSessionId: "sess-child",
        nodeId: "node-remote",
      });
      expect(capture.requests.map((r) => `${r.method} ${r.url}`)).toEqual([
        "GET /api/nodes/node-remote/agents",
        "POST /api/sessions",
      ]);
      const body = JSON.parse(capture.requests[1]!.body);
      expect(body.profile).toBe("roselin_codex");
      expect(body.nodeId).toBe("node-remote");
      expect(body.folderId).toBe("folder-1");
      expect(body.caller_session_id).toBe("caller-sess-1");
      expect(body.caller_info.agent_id).toBe("codex-default");
      expect(body.caller_info.agent_node).toBe("node-test");
    } finally {
      await capture.close();
    }
  });

  it("MCP 요청 header의 caller id로 remote caller_session_id와 caller_info를 전달한다", async () => {
    const capture = await createOrchCapture(200, (req) => {
      if (req.method === "GET" && req.url === "/api/nodes/node-remote/agents") {
        return {
          body: {
            agents: [
              {
                id: "roselin_codex",
                name: "로젤린 (codex)",
                backend: "codex",
              },
            ],
          },
        };
      }
      if (req.method === "POST" && req.url === "/api/sessions") {
        return { body: { agentSessionId: "sess-child", nodeId: "node-remote" } };
      }
      return { status: 404, body: { error: "unexpected route" } };
    });
    try {
      const runtime = makeRuntime({ queued: true, queuePosition: 1 }, capture.orch);
      const client = await createClient(runtime, {
        "x-soulstream-agent-session-id": "caller-sess-1",
      });

      const result = await client.callTool({
        name: "create_remote_agent_session",
        arguments: {
          node_id: "node-remote",
          agent_id: "roselin_codex",
          prompt: "delegate",
        },
      });

      expect(result.isError).not.toBe(true);
      expect(capture.requests.map((r) => `${r.method} ${r.url}`)).toEqual([
        "GET /api/nodes/node-remote/agents",
        "POST /api/sessions",
      ]);
      const body = JSON.parse(capture.requests[1]!.body);
      expect(body.caller_session_id).toBe("caller-sess-1");
      expect(body.folderId).toBe("caller-folder");
      expect(body.caller_info).toEqual(expect.objectContaining({
        source: "agent",
        agent_node: "node-test",
        agent_id: "codex-default",
      }));
    } finally {
      await capture.close();
    }
  });

  it("명시 caller_session_id가 MCP 요청 header보다 우선한다", async () => {
    const capture = await createOrchCapture(200, (req) => {
      if (req.method === "GET" && req.url === "/api/nodes/node-remote/agents") {
        return {
          body: {
            agents: [
              {
                id: "roselin_codex",
                name: "로젤린 (codex)",
                backend: "codex",
              },
            ],
          },
        };
      }
      if (req.method === "POST" && req.url === "/api/sessions") {
        return { body: { agentSessionId: "sess-child", nodeId: "node-remote" } };
      }
      return { status: 404, body: { error: "unexpected route" } };
    });
    try {
      const runtime = makeRuntime({ queued: true, queuePosition: 1 }, capture.orch);
      const client = await createClient(runtime, {
        "x-soulstream-agent-session-id": "stale-header-sess",
      });

      const result = await client.callTool({
        name: "create_remote_agent_session",
        arguments: {
          node_id: "node-remote",
          agent_id: "roselin_codex",
          prompt: "delegate",
          caller_session_id: "caller-sess-1",
        },
      });

      expect(result.isError).not.toBe(true);
      const body = JSON.parse(capture.requests[1]!.body);
      expect(body.caller_session_id).toBe("caller-sess-1");
      expect(body.folderId).toBe("caller-folder");
    } finally {
      await capture.close();
    }
  });

  it("folder_id를 명시하지 않으면 caller session 폴더를 remote body에 상속한다", async () => {
    const capture = await createOrchCapture(200, (req) => {
      if (req.method === "GET" && req.url === "/api/nodes/node-remote/agents") {
        return { body: { agents: [{ id: "roselin_codex", name: "로젤린", backend: "codex" }] } };
      }
      if (req.method === "POST" && req.url === "/api/sessions") {
        return { body: { agentSessionId: "sess-child", nodeId: "node-remote" } };
      }
      return { status: 404, body: { error: "unexpected route" } };
    });
    try {
      const runtime = makeRuntime({ queued: true, queuePosition: 1 }, capture.orch);
      const client = await createClient(runtime);

      const result = await client.callTool({
        name: "create_remote_agent_session",
        arguments: {
          node_id: "node-remote",
          agent_id: "roselin_codex",
          prompt: "delegate",
          caller_session_id: "caller-sess-1",
        },
      });

      expect(result.isError).not.toBe(true);
      const body = JSON.parse(capture.requests[1]!.body);
      expect(body.folderId).toBe("caller-folder");
    } finally {
      await capture.close();
    }
  });

  it("folder_id=null은 caller folder 상속 없이 root 의도로 전달한다", async () => {
    const capture = await createOrchCapture(200, (req) => {
      if (req.method === "GET" && req.url === "/api/nodes/node-remote/agents") {
        return { body: { agents: [{ id: "roselin_codex", name: "로젤린", backend: "codex" }] } };
      }
      if (req.method === "POST" && req.url === "/api/sessions") {
        return { body: { agentSessionId: "sess-child", nodeId: "node-remote" } };
      }
      return { status: 404, body: { error: "unexpected route" } };
    });
    try {
      const runtime = makeRuntime({ queued: true, queuePosition: 1 }, capture.orch);
      const client = await createClient(runtime);

      const result = await client.callTool({
        name: "create_remote_agent_session",
        arguments: {
          node_id: "node-remote",
          agent_id: "roselin_codex",
          prompt: "delegate",
          caller_session_id: "caller-sess-1",
          folder_id: null,
        },
      });

      expect(result.isError).not.toBe(true);
      const body = JSON.parse(capture.requests[1]!.body);
      expect(body.folderId).toBeNull();
    } finally {
      await capture.close();
    }
  });

  it("caller id를 알 수 없으면 remote orphan 세션을 만들지 않는다", async () => {
    const capture = await createOrchCapture(200);
    try {
      const runtime = makeRuntime({ queued: true, queuePosition: 1 }, capture.orch);
      const client = await createClient(runtime);

      const result = await client.callTool({
        name: "create_remote_agent_session",
        arguments: {
          node_id: "node-remote",
          agent_id: "roselin_codex",
          prompt: "delegate",
        },
      });

      expect(result.isError).toBe(true);
      expect(result.structuredContent).toEqual({
        error: expect.stringContaining("caller_session_id"),
      });
      expect(capture.requests).toEqual([]);
    } finally {
      await capture.close();
    }
  });
});

describe("reflect_cluster_brief", () => {
  it("proxies orchestrator aggregate without colliding with self reflect_brief", async () => {
    const capture = await createOrchCapture(200, (req) => {
      if (req.method === "GET" && req.url === "/cogito/briefs") {
        return {
          body: {
            schema_version: "soulstream.reflect.aggregate.v1",
            kind: "orchestrator_node_brief_aggregate",
            status: "ok",
            nodes: [
              {
                node_id: "node-remote",
                status: "ok",
                data: { kind: "compact_aggregate" },
              },
            ],
          },
        };
      }
      return { status: 404, body: { error: "unexpected route" } };
    });
    try {
      const runtime = makeRuntime({ queued: true, queuePosition: 1 }, capture.orch);
      const client = await createClient(runtime);

      const result = await client.callTool({
        name: "reflect_cluster_brief",
        arguments: {},
      });

      expect(result.isError).not.toBe(true);
      expect(result.structuredContent).toMatchObject({
        schema_version: "soulstream.reflect.aggregate.v1",
        kind: "orchestrator_node_brief_aggregate",
        nodes: [
          expect.objectContaining({
            node_id: "node-remote",
            status: "ok",
          }),
        ],
      });
      expect(capture.requests.map((r) => `${r.method} ${r.url}`)).toEqual([
        "GET /cogito/briefs",
      ]);
    } finally {
      await capture.close();
    }
  });

  it("returns explicit error when orchestrator proxy is not configured", async () => {
    const runtime = makeRuntime({ queued: true, queuePosition: 1 });
    const client = await createClient(runtime);

    const result = await client.callTool({
      name: "reflect_cluster_brief",
      arguments: {},
    });

    expect(result.isError).toBe(true);
    expect(result.structuredContent).toEqual({
      error: "multi-node not configured",
    });
  });
});

describe("plan_remote_agent_profile_update", () => {
  it("proxies read-only profile update planning to the orchestrator node endpoint", async () => {
    const capture = await createOrchCapture(200, (req) => {
      if (
        req.method === "POST" &&
        req.url === "/api/nodes/node-remote/agents/config/plan-profile-update"
      ) {
        return {
          body: {
            ok: true,
            config_path: "/srv/agents.yaml",
            changed: true,
            semantic_changes: [
              {
                op: "add_agent",
                agent_id: "codex-default",
                before: null,
                after: {
                  id: "codex-default",
                  name: "Codex Planned",
                  backend: "codex",
                  workspace_dir: "/tmp/codex",
                },
              },
            ],
            text_diff_included: true,
            diff: "--- agents.yaml\n+++ agents.yaml\n",
            comment_preservation: "not_preserved",
          },
        };
      }
      return { status: 404, body: { error: "unexpected route" } };
    });
    try {
      const runtime = makeRuntime({ queued: true, queuePosition: 1 }, capture.orch);
      const client = await createClient(runtime);

      const result = await client.callTool({
        name: "plan_remote_agent_profile_update",
        arguments: {
          node_id: "node-remote",
          create_if_missing: true,
          include_text_diff: true,
          profile: {
            id: "codex-default",
            name: "Codex Planned",
            backend: "codex",
            workspace_dir: "/tmp/codex",
          },
        },
      });

      expect(result.isError).not.toBe(true);
      expect(result.structuredContent).toMatchObject({
        ok: true,
        changed: true,
        semantic_changes: [
          expect.objectContaining({
            op: "add_agent",
            agent_id: "codex-default",
          }),
        ],
        text_diff_included: true,
        comment_preservation: "not_preserved",
      });
      expect(capture.requests.map((r) => `${r.method} ${r.url}`)).toEqual([
        "POST /api/nodes/node-remote/agents/config/plan-profile-update",
      ]);
      const body = JSON.parse(capture.requests[0]!.body);
      expect(body.nodeId).toBeUndefined();
      expect(body.create_if_missing).toBe(true);
      expect(body.include_text_diff).toBe(true);
      expect(body.profile.id).toBe("codex-default");
    } finally {
      await capture.close();
    }
  });
});

describe("remote agent config mutation tools", () => {
  it("apply_remote_agent_profile_update proxies write request with checksum guard", async () => {
    const capture = await createOrchCapture(200, (req) => {
      if (
        req.method === "POST" &&
        req.url === "/api/nodes/node-remote/agents/config/apply-profile-update"
      ) {
        return {
          body: {
            ok: true,
            changed: true,
            snapshot_path: "/srv/snap.yaml",
            config_checksum: "next-checksum",
            base_config_checksum: "base-checksum",
            semantic_changes: [
              { op: "replace_agent", agent_id: "codex-default" },
            ],
            text_diff_included: false,
            diff: "",
            reload_ok: true,
          },
        };
      }
      return { status: 404, body: { error: "unexpected route" } };
    });
    try {
      const runtime = makeRuntime({ queued: true, queuePosition: 1 }, capture.orch);
      const client = await createClient(runtime);

      const result = await client.callTool({
        name: "apply_remote_agent_profile_update",
        arguments: {
          node_id: "node-remote",
          create_if_missing: true,
          expected_config_checksum: "base-checksum",
          profile: {
            id: "codex-default",
            name: "Codex Applied",
            backend: "codex",
            workspace_dir: "/tmp/codex",
          },
        },
      });

      expect(result.isError).not.toBe(true);
      expect(result.structuredContent).toMatchObject({
        ok: true,
        changed: true,
        snapshot_path: "/srv/snap.yaml",
        reload_ok: true,
      });
      expect(capture.requests.map((r) => `${r.method} ${r.url}`)).toEqual([
        "POST /api/nodes/node-remote/agents/config/apply-profile-update",
      ]);
      const body = JSON.parse(capture.requests[0]!.body);
      expect(body.expected_config_checksum).toBe("base-checksum");
      expect(body.include_text_diff).toBe(false);
      expect(body.create_if_missing).toBe(true);
    } finally {
      await capture.close();
    }
  });

  it("list_remote_agents_config_snapshots proxies snapshot inventory request", async () => {
    const capture = await createOrchCapture(200, (req) => {
      if (
        req.method === "GET" &&
        req.url === "/api/nodes/node-remote/agents/config/snapshots"
      ) {
        return {
          body: {
            ok: true,
            snapshots: [{ snapshot_id: "snap.yaml", snapshot_path: "/srv/snap.yaml" }],
          },
        };
      }
      return { status: 404, body: { error: "unexpected route" } };
    });
    try {
      const runtime = makeRuntime({ queued: true, queuePosition: 1 }, capture.orch);
      const client = await createClient(runtime);

      const result = await client.callTool({
        name: "list_remote_agents_config_snapshots",
        arguments: { node_id: "node-remote" },
      });

      expect(result.isError).not.toBe(true);
      expect(result.structuredContent).toMatchObject({
        ok: true,
        snapshots: [expect.objectContaining({ snapshot_id: "snap.yaml" })],
      });
      expect(capture.requests.map((r) => `${r.method} ${r.url}`)).toEqual([
        "GET /api/nodes/node-remote/agents/config/snapshots",
      ]);
    } finally {
      await capture.close();
    }
  });

  it("rollback_remote_agents_config proxies snapshot id rollback request", async () => {
    const capture = await createOrchCapture(200, (req) => {
      if (
        req.method === "POST" &&
        req.url === "/api/nodes/node-remote/agents/config/rollback"
      ) {
        return {
          body: {
            ok: true,
            changed: true,
            snapshot_path: "/srv/pre-rollback.yaml",
            config_checksum: "restored-checksum",
            reload_ok: true,
          },
        };
      }
      return { status: 404, body: { error: "unexpected route" } };
    });
    try {
      const runtime = makeRuntime({ queued: true, queuePosition: 1 }, capture.orch);
      const client = await createClient(runtime);

      const result = await client.callTool({
        name: "rollback_remote_agents_config",
        arguments: {
          node_id: "node-remote",
          snapshot_id: "snap.yaml",
          include_text_diff: true,
        },
      });

      expect(result.isError).not.toBe(true);
      expect(result.structuredContent).toMatchObject({
        ok: true,
        reload_ok: true,
      });
      expect(capture.requests.map((r) => `${r.method} ${r.url}`)).toEqual([
        "POST /api/nodes/node-remote/agents/config/rollback",
      ]);
      const body = JSON.parse(capture.requests[0]!.body);
      expect(body.snapshot_id).toBe("snap.yaml");
      expect(body.include_text_diff).toBe(true);
    } finally {
      await capture.close();
    }
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

  it("local live-steer delivery result passes through without orch fallback", async () => {
    const runtime = makeRuntime({ delivered: true });
    const client = await createClient(runtime);

    const result = await client.callTool({
      name: "send_message_to_session",
      arguments: {
        target_session_id: "target-sess-1",
        message: "steer now",
      },
    });

    expect(result.isError).not.toBe(true);
    expect(result.structuredContent).toEqual({
      ok: true,
      detail: { delivered: true },
    });
    expect(runtime.addIntervention).toHaveBeenCalledTimes(1);
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

/**
 * full 세션 자격 증명의 MCP 전송 계층 수용.
 *
 * ssf1은 restricted 설정 없이도 full principal로 initialize·tools/list를
 * 통과한다. 세션 프로필에 금지 도구가 없으면 서비스 토큰과 같은 도구 범위를
 * 본다. 변조·타 인증 키 토큰은 401이다.
 */
import { afterEach, describe, expect, it } from "vitest";

import type { AgentProfile } from "../../src/agent_registry.js";
import { SessionDB } from "../../src/db/session_db.js";
import type { McpRuntime } from "../../src/mcp/runtime.js";
import { createFullSessionMcpToken } from "../../src/security/restricted_mcp_auth.js";
import { buildInternalMcpServer } from "../../src/server.js";

const KEY = "test-transport-key-0001";
const SESSION_A = "11111111-1111-4111-8111-111111111111";
const TOKEN_FULL = createFullSessionMcpToken(SESSION_A, KEY);

function silentLogger() {
  const noop = () => {};
  return {
    fatal: noop, error: noop, warn: noop, info: noop, debug: noop, trace: noop, silent: noop,
    level: "silent", child: () => silentLogger(),
  } as unknown as McpRuntime["logger"];
}

const SESSION_PROFILE: AgentProfile = {
  id: "full-session-transport-test",
  name: "Full session test",
  backend: "claude",
  workspace_dir: "/tmp/full-session-ws",
};

function makeRuntime(): McpRuntime {
  return {
    nodeId: "test-node",
    agentsConfigPath: "/tmp/agents.yaml",
    db: new SessionDB(),
    taskManager: {
      listTasks: () => [],
      getTask: (sessionId: string) => sessionId === SESSION_A
        ? { agentSessionId: sessionId, agentProfileSnapshot: SESSION_PROFILE }
        : undefined,
    },
    taskExecutor: {},
    onResume: () => undefined,
    agentRegistry: { listAgents: () => [], get: () => undefined },
    catalogService: {},
    logger: silentLogger(),
  } as unknown as McpRuntime;
}

interface ServerHandle {
  close: () => Promise<void>;
  baseUrl: string;
}

const openServers: ServerHandle[] = [];

async function startServer(options: { requireAuth?: boolean } = {}): Promise<ServerHandle> {
  const server = await buildInternalMcpServer({
    logger: silentLogger(),
    statelessTransport: false,
    runtime: makeRuntime(),
    path: "/mcp",
    auth: {
      requireAuth: options.requireAuth ?? true,
      bearerToken: KEY,
      allowedHosts: ["127.0.0.1", "localhost"],
    },
  });
  const baseUrl = await server.listen({ host: "127.0.0.1", port: 0 });
  const handle: ServerHandle = {
    baseUrl,
    close: async () => {
      if (server.closeMcp) await server.closeMcp();
      await server.close();
    },
  };
  openServers.push(handle);
  return handle;
}

afterEach(async () => {
  await Promise.all(openServers.splice(0).map((handle) => handle.close()));
});

function postMcp(
  baseUrl: string,
  authorization: string,
  body: Record<string, unknown>,
  sessionId?: string,
): Promise<Response> {
  return fetch(`${baseUrl}/mcp`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      authorization,
      ...(sessionId ? { "mcp-session-id": sessionId } : {}),
    },
    body: JSON.stringify(body),
  });
}

const initializeBody = {
  jsonrpc: "2.0",
  method: "initialize",
  params: {
    protocolVersion: "2024-11-05",
    capabilities: {},
    clientInfo: { name: "full-session-test", version: "0.0.0" },
  },
  id: 1,
};

async function initialize(baseUrl: string, authorization: string): Promise<string> {
  const res = await postMcp(baseUrl, authorization, initializeBody);
  expect(res.status).toBe(200);
  const sessionId = res.headers.get("mcp-session-id");
  expect(sessionId).toBeTruthy();
  await res.text();
  return sessionId ?? "";
}

function listTools(baseUrl: string, authorization: string, sessionId: string): Promise<Response> {
  return postMcp(
    baseUrl,
    authorization,
    { jsonrpc: "2.0", method: "tools/list", params: {}, id: 2 },
    sessionId,
  );
}

async function payloadOf(response: Response): Promise<Record<string, any>> {
  expect(response.status).toBe(200);
  const text = await response.text();
  const data = text.split("\n").find((line) => line.startsWith("data: "))?.slice("data: ".length);
  return JSON.parse(data ?? text) as Record<string, any>;
}

describe("full session credential over MCP transport", () => {
  it("accepts ssf1 with the same tool surface as the service token when its profile disallows no tools", async () => {
    const { baseUrl } = await startServer();
    const serviceSession = await initialize(baseUrl, `Bearer ${KEY}`);
    const serviceTools = (await payloadOf(
      await listTools(baseUrl, `Bearer ${KEY}`, serviceSession),
    )).result?.tools as unknown[];

    const sessionId = await initialize(baseUrl, `Bearer ${TOKEN_FULL}`);
    const payload = await payloadOf(await listTools(baseUrl, `Bearer ${TOKEN_FULL}`, sessionId));
    expect(Array.isArray(serviceTools)).toBe(true);
    expect(serviceTools.length).toBeGreaterThan(0);
    expect(payload.result?.tools).toHaveLength(serviceTools.length);
  });

  it("rejects a tampered or foreign-key ssf1 with 401", async () => {
    const { baseUrl } = await startServer();
    const tampered = await postMcp(
      baseUrl,
      `Bearer ${TOKEN_FULL.slice(0, -1)}${TOKEN_FULL.endsWith("A") ? "B" : "A"}`,
      initializeBody,
    );
    expect(tampered.status).toBe(401);

    const foreign = createFullSessionMcpToken(SESSION_A, "another-key");
    const rejected = await postMcp(baseUrl, `Bearer ${foreign}`, initializeBody);
    expect(rejected.status).toBe(401);
  });

  it("accepts ssf1 when MCP_REQUIRE_AUTH is false", async () => {
    const { baseUrl } = await startServer({ requireAuth: false });
    const sessionId = await initialize(baseUrl, `Bearer ${TOKEN_FULL}`);
    const payload = await payloadOf(await listTools(baseUrl, `Bearer ${TOKEN_FULL}`, sessionId));
    expect(Array.isArray(payload.result?.tools)).toBe(true);
    expect(payload.result?.tools.length).toBeGreaterThan(0);
  });
});

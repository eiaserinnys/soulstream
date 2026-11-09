/**
 * stateful MCP 세션의 principal 고정(§3) — raw HTTP.
 *
 * 최초 initialize의 principal과 다른 POST/GET/DELETE는 403이다. restricted A가
 * restricted B의 세션도, full 세션도 빌릴 수 없다. full 동작은 그대로다.
 * 정책 로드 실패는 restricted만 503으로 막고 full은 계속 동작한다.
 */
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it, vi } from "vitest";

import { buildInternalMcpServer } from "../../src/server.js";
import type { McpRuntime } from "../../src/mcp/runtime.js";
import { SessionDB } from "../../src/db/session_db.js";
import { createRestrictedMcpToken } from "../../src/security/restricted_mcp_auth.js";
import { loadIsolationPolicyFile } from "../../src/security/session_isolation_policy.js";
import type { McpRestrictedAuthConfig } from "../../src/mcp/auth.js";

const KEY = "test-transport-key-0001";
const SESSION_A = "11111111-1111-4111-8111-111111111111";
const SESSION_B = "22222222-2222-4222-8222-222222222222";
const TOKEN_A = createRestrictedMcpToken(SESSION_A, KEY);
const TOKEN_B = createRestrictedMcpToken(SESSION_B, KEY);
const POLICY_PATH = fileURLToPath(
  new URL("../../src/policies/session-isolation.json", import.meta.url),
);
const loadedPolicy = loadIsolationPolicyFile(POLICY_PATH);

function silentLogger() {
  const noop = () => {};
  return {
    fatal: noop, error: noop, warn: noop, info: noop, debug: noop, trace: noop, silent: noop,
    level: "silent", child: () => silentLogger(),
  } as unknown as McpRuntime["logger"];
}

function makeRuntime(): McpRuntime {
  return {
    nodeId: "test-node",
    agentsConfigPath: "/tmp/agents.yaml",
    db: new SessionDB(),
    taskManager: { listTasks: () => [], getTask: () => undefined },
    taskExecutor: {},
    onResume: () => undefined,
    agentRegistry: { listAgents: () => [] },
    catalogService: {},
    logger: silentLogger(),
  } as unknown as McpRuntime;
}

const restrictedConfig: McpRestrictedAuthConfig = {
  policyProvider: { get: () => loadedPolicy },
  sessionExists: async (sessionId) => sessionId === SESSION_A || sessionId === SESSION_B,
};

interface ServerHandle {
  close: () => Promise<void>;
  baseUrl: string;
}

const openServers: ServerHandle[] = [];

async function startServer(options: {
  restricted?: McpRestrictedAuthConfig;
  requireAuth?: boolean;
} = {}): Promise<ServerHandle> {
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
    ...(options.restricted ? { restricted: options.restricted } : {}),
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
  authorization: string | undefined,
  body: Record<string, unknown>,
  sessionId?: string,
): Promise<Response> {
  return fetch(`${baseUrl}/mcp`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      ...(authorization ? { authorization } : {}),
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
    clientInfo: { name: "principal-test", version: "0.0.0" },
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
  return postMcp(baseUrl, authorization, { jsonrpc: "2.0", method: "tools/list", params: {}, id: 2 }, sessionId);
}

async function payloadOf(response: Response): Promise<Record<string, any>> {
  expect(response.status).toBe(200);
  const text = await response.text();
  const data = text.split("\n").find((line) => line.startsWith("data: "))?.slice("data: ".length);
  return JSON.parse(data ?? text) as Record<string, any>;
}

describe("stateful principal binding", () => {
  it("rejects a second restricted session on the first restricted session", async () => {
    const { baseUrl } = await startServer({ restricted: restrictedConfig });
    const sessionId = await initialize(baseUrl, `Bearer ${TOKEN_A}`);

    const borrowed = await listTools(baseUrl, `Bearer ${TOKEN_B}`, sessionId);
    expect(borrowed.status).toBe(403);
    expect(String((await borrowed.json()).error?.message)).toBe("principal mismatch");

    const asFull = await listTools(baseUrl, `Bearer ${KEY}`, sessionId);
    expect(asFull.status).toBe(403);
  });

  it("rejects a restricted principal on a full session and keeps full working", async () => {
    const { baseUrl } = await startServer({ restricted: restrictedConfig });
    const sessionId = await initialize(baseUrl, `Bearer ${KEY}`);

    const fullList = await listTools(baseUrl, `Bearer ${KEY}`, sessionId);
    const fullPayload = await payloadOf(fullList);
    expect(fullPayload.result?.tools).toHaveLength(139);

    const borrowed = await listTools(baseUrl, `Bearer ${TOKEN_A}`, sessionId);
    expect(borrowed.status).toBe(403);
  });

  it("lets one restricted session continue with its own token", async () => {
    const { baseUrl } = await startServer({ restricted: restrictedConfig });
    const sessionId = await initialize(baseUrl, `Bearer ${TOKEN_A}`);
    const payload = await payloadOf(await listTools(baseUrl, `Bearer ${TOKEN_A}`, sessionId));
    expect(payload.result?.tools).toHaveLength(107);
  });

  it("refuses restricted start with 503 on policy failure while full stays up", async () => {
    const broken: McpRestrictedAuthConfig = {
      policyProvider: { get: () => { throw new Error("bad policy"); } },
      sessionExists: async () => true,
    };
    const { baseUrl } = await startServer({ restricted: broken });

    const restricted = await postMcp(baseUrl, `Bearer ${TOKEN_A}`, initializeBody);
    expect(restricted.status).toBe(503);
    expect(String((await restricted.json()).error?.message)).toBe("ISOLATION_POLICY_UNAVAILABLE");

    const fullSession = await initialize(baseUrl, `Bearer ${KEY}`);
    const fullList = await listTools(baseUrl, `Bearer ${KEY}`, fullSession);
    expect((await payloadOf(fullList)).result?.tools).toHaveLength(139);
  });

  it("refuses restricted credentials when MCP_REQUIRE_AUTH is false", async () => {
    const { baseUrl } = await startServer({ restricted: restrictedConfig, requireAuth: false });
    const res = await postMcp(baseUrl, `Bearer ${TOKEN_A}`, initializeBody);
    expect(res.status).toBe(401);
  });

  it("rejects a restricted credential with an unknown session id", async () => {
    const unknown = createRestrictedMcpToken("44444444-4444-4444-8444-444444444444", KEY);
    const { baseUrl } = await startServer({ restricted: restrictedConfig });
    const res = await postMcp(baseUrl, `Bearer ${unknown}`, initializeBody);
    expect(res.status).toBe(401);
  });
});

describe("restricted GET/DELETE principal binding", () => {
  it("rejects GET and DELETE from a different restricted session", async () => {
    const { baseUrl } = await startServer({ restricted: restrictedConfig });
    const sessionId = await initialize(baseUrl, `Bearer ${TOKEN_A}`);

    const get = await fetch(`${baseUrl}/mcp`, {
      method: "GET",
      headers: { authorization: `Bearer ${TOKEN_B}`, "mcp-session-id": sessionId, accept: "text/event-stream" },
    });
    expect(get.status).toBe(403);

    const del = await fetch(`${baseUrl}/mcp`, {
      method: "DELETE",
      headers: { authorization: `Bearer ${TOKEN_B}`, "mcp-session-id": sessionId },
    });
    expect(del.status).toBe(403);
  });
});

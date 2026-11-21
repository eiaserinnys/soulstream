/**
 * 세션 에이전트 프로필 금지 도구의 서버 쪽 거름.
 *
 * ssf1/ssr1은 토큰이 묶은 세션의 프로필 `disallowed_tools`를 tools/list와
 * tools/call 양쪽에 반영한다. 소울스트림 내부 MCP 서버 이름만 맨 도구 이름으로
 * 해석하고, 내장 도구와 다른 서버 항목은 무시한다. 서비스 토큰과 프로필을
 * 찾지 못한 세션은 지금처럼 전체 도구다.
 */
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it, vi } from "vitest";

import type { AgentProfile } from "@soulstream/agent-profile-contract";
import { SessionDB } from "../../src/db/session_db.js";
import type { McpRuntime } from "../../src/mcp/runtime.js";
import {
  createFullSessionMcpToken,
  createRestrictedMcpToken,
} from "../../src/security/restricted_mcp_auth.js";
import { loadIsolationPolicyFile } from "../../src/security/session_isolation_policy.js";
import { buildInternalMcpServer } from "../../src/server.js";

const KEY = "test-profile-filter-key-0001";
const SESSION_A = "11111111-1111-4111-8111-111111111111";
const SERVICE = `Bearer ${KEY}`;
const FULL = `Bearer ${createFullSessionMcpToken(SESSION_A, KEY)}`;
const RESTRICTED = `Bearer ${createRestrictedMcpToken(SESSION_A, KEY)}`;
const POLICY_PATH = fileURLToPath(
  new URL("../../src/policies/session-isolation.json", import.meta.url),
);
const loadedPolicy = loadIsolationPolicyFile(POLICY_PATH);

function silentLogger(warn: (...args: unknown[]) => void = () => {}) {
  const noop = () => {};
  return {
    fatal: noop, error: noop, warn, info: noop, debug: noop, trace: noop, silent: noop,
    level: "silent", child: () => silentLogger(warn),
  } as unknown as McpRuntime["logger"];
}

function profile(disallowedTools?: string[]): AgentProfile {
  return {
    id: "profile-filter-test",
    name: "Profile filter test",
    backend: "claude",
    workspace_dir: "/tmp/profile-filter-ws",
    ...(disallowedTools ? { disallowed_tools: disallowedTools } : {}),
  };
}

interface Harness {
  baseUrl: string;
  db: SessionDB;
  warn: ReturnType<typeof vi.fn>;
  close: () => Promise<void>;
}

const openServers: Harness[] = [];

async function startServer(options: {
  stateless?: boolean;
  taskProfile?: AgentProfile;
  restricted?: boolean;
} = {}): Promise<Harness> {
  const db = new SessionDB();
  const warn = vi.fn();
  const sessionProfile = options.taskProfile;
  const runtime = {
    nodeId: "test-node",
    agentsConfigPath: "/tmp/agents.yaml",
    db,
    taskManager: {
      listTasks: () => [],
      getTask: (sessionId: string) => sessionProfile && sessionId === SESSION_A
        ? { agentSessionId: sessionId, agentProfileSnapshot: sessionProfile }
        : undefined,
    },
    taskExecutor: {},
    onResume: () => undefined,
    agentRegistry: { listAgents: () => [], get: () => undefined },
    catalogService: { broadcastSessionDeletion: vi.fn(async () => undefined) },
    worktreeService: { list: vi.fn(async () => []) },
    logger: silentLogger(warn),
  } as unknown as McpRuntime;

  const server = await buildInternalMcpServer({
    logger: silentLogger(),
    statelessTransport: options.stateless ?? false,
    runtime,
    path: "/mcp",
    auth: {
      requireAuth: true,
      bearerToken: KEY,
      allowedHosts: ["127.0.0.1", "localhost"],
    },
    ...(options.restricted
      ? {
          restricted: {
            policyProvider: { get: () => loadedPolicy },
            sessionExists: async (sessionId: string) => sessionId === SESSION_A,
          },
        }
      : {}),
  });
  const baseUrl = await server.listen({ host: "127.0.0.1", port: 0 });
  const harness: Harness = {
    baseUrl,
    db,
    warn,
    close: async () => {
      if (server.closeMcp) await server.closeMcp();
      await server.close();
    },
  };
  openServers.push(harness);
  return harness;
}

afterEach(async () => {
  await Promise.all(openServers.splice(0).map((harness) => harness.close()));
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
    clientInfo: { name: "profile-filter-test", version: "0.0.0" },
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

async function payloadOf(response: Response): Promise<Record<string, any>> {
  expect(response.status).toBe(200);
  const text = await response.text();
  const data = text.split("\n").find((line) => line.startsWith("data: "))?.slice("data: ".length);
  return JSON.parse(data ?? text) as Record<string, any>;
}

async function toolNames(
  baseUrl: string,
  authorization: string,
  sessionId?: string,
): Promise<string[]> {
  const payload = await payloadOf(await postMcp(
    baseUrl,
    authorization,
    { jsonrpc: "2.0", method: "tools/list", params: {}, id: 2 },
    sessionId,
  ));
  return (payload.result?.tools ?? []).map((tool: { name: string }) => tool.name);
}

async function callTool(
  baseUrl: string,
  authorization: string,
  sessionId: string,
  name: string,
  args: Record<string, unknown> = {},
): Promise<Record<string, any>> {
  return await payloadOf(await postMcp(
    baseUrl,
    authorization,
    { jsonrpc: "2.0", method: "tools/call", params: { name, arguments: args }, id: 3 },
    sessionId,
  ));
}

describe("session profile tool filtering", () => {
  it("hides a profile-disallowed soulstream tool from ssf1 and rejects its call", async () => {
    const harness = await startServer({
      taskProfile: profile([
        "mcp__soulstream__search_sessions",
        " mcp__soul-server-ts__search_sessions ",
      ]),
    });
    const serviceSession = await initialize(harness.baseUrl, SERVICE);
    expect(await toolNames(harness.baseUrl, SERVICE, serviceSession)).toContain("search_sessions");

    const sessionId = await initialize(harness.baseUrl, FULL);
    const names = await toolNames(harness.baseUrl, FULL, sessionId);
    expect(names).not.toContain("search_sessions");
    expect(names).toContain("list_sessions");

    const payload = await callTool(harness.baseUrl, FULL, sessionId, "search_sessions");
    expect(payload.result?.isError).toBe(true);
    expect(String(payload.result?.content?.[0]?.text)).toContain("disabled");
  });

  it("applies the profile filter to restricted sessions on top of the isolation policy", async () => {
    const filtered = await startServer({
      restricted: true,
      taskProfile: profile(["mcp__soulstream__search_sessions"]),
    });
    const filteredSession = await initialize(filtered.baseUrl, RESTRICTED);
    expect(await toolNames(filtered.baseUrl, RESTRICTED, filteredSession)).not.toContain("search_sessions");

    const unfiltered = await startServer({
      restricted: true,
      taskProfile: profile(),
    });
    const unfilteredSession = await initialize(unfiltered.baseUrl, RESTRICTED);
    expect(await toolNames(unfiltered.baseUrl, RESTRICTED, unfilteredSession)).toContain("search_sessions");
  });

  it("ignores built-in tools and other MCP servers in disallowed_tools", async () => {
    const harness = await startServer({
      taskProfile: profile(["Bash", "mcp__other__search_sessions"]),
    });
    const sessionId = await initialize(harness.baseUrl, FULL);
    expect(await toolNames(harness.baseUrl, FULL, sessionId)).toContain("search_sessions");
  });

  it("does not filter a session without a findable profile and warns with only the session id", async () => {
    const harness = await startServer({ taskProfile: undefined });
    vi.spyOn(harness.db, "getSession").mockResolvedValue(null);

    const serviceSession = await initialize(harness.baseUrl, SERVICE);
    const serviceTools = await toolNames(harness.baseUrl, SERVICE, serviceSession);
    const sessionId = await initialize(harness.baseUrl, FULL);
    const sessionTools = await toolNames(harness.baseUrl, FULL, sessionId);

    expect(sessionTools).toHaveLength(serviceTools.length);
    expect(harness.warn).toHaveBeenCalledWith(
      { sessionId: SESSION_A },
      "MCP session has no agent profile; server-side tool filtering skipped",
    );
  });

  it("filters stateless transports as well", async () => {
    const harness = await startServer({
      stateless: true,
      taskProfile: profile(["mcp__soulstream__search_sessions"]),
    });
    const serviceNames = await toolNames(harness.baseUrl, SERVICE);
    const sessionNames = await toolNames(harness.baseUrl, FULL);
    expect(serviceNames).toContain("search_sessions");
    expect(sessionNames).not.toContain("search_sessions");
    expect(sessionNames.length).toBe(serviceNames.length - 1);
  });
});

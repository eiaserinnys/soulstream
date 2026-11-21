/**
 * 세션 프로필 조회가 일시 실패할 때의 서버 쪽 MCP 거름 (카드 #1434, mcp-guard-2).
 *
 * - 세션 DB 조회가 계속 예외를 던지면 tools/call만 그 요청에서 닫고
 *   initialize·tools/list는 통과한다.
 * - 짧게 다시 시도해 프로필을 찾으면 금지 도구를 거르고 허용 도구는 실행한다.
 * - 찾은 세션의 agent_id는 프로세스 안에 기억해, 이후 조회 실패에도 같은 프로필로 거른다.
 *
 * 실제로 기다리지 않도록 재시도 대기는 runtime.sessionProfileLookupSleep으로 주입하고,
 * 재시도 간격 자체는 findSessionAgentProfile에 sleep을 주입해 확인한다.
 */
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it, vi } from "vitest";

import type { AgentProfile } from "@soulstream/agent-profile-contract";
import { SessionDB } from "../../src/db/session_db.js";
import type { McpRuntime } from "../../src/mcp/runtime.js";
import {
  DEFAULT_AGENT_ID_CACHE_LIMIT,
  SessionAgentIdCache,
  findSessionAgentProfile,
} from "../../src/mcp/session_profile_tools.js";
import {
  createFullSessionMcpToken,
  createRestrictedMcpToken,
} from "../../src/security/restricted_mcp_auth.js";
import { loadIsolationPolicyFile } from "../../src/security/session_isolation_policy.js";
import { buildInternalMcpServer } from "../../src/server.js";

const KEY = "test-profile-lookup-key-0001";
const SESSION_A = "11111111-1111-4111-8111-111111111111";
const SERVICE = `Bearer ${KEY}`;
const FULL = `Bearer ${createFullSessionMcpToken(SESSION_A, KEY)}`;
const RESTRICTED = `Bearer ${createRestrictedMcpToken(SESSION_A, KEY)}`;
const POLICY_PATH = fileURLToPath(
  new URL("../../src/policies/session-isolation.json", import.meta.url),
);
const loadedPolicy = loadIsolationPolicyFile(POLICY_PATH);

type WarnFn = ReturnType<typeof vi.fn>;
type WorktreeListFn = ReturnType<typeof vi.fn>;

function silentLogger(warn: WarnFn = vi.fn()) {
  const noop = () => {};
  return {
    fatal: noop, error: noop, warn, info: noop, debug: noop, trace: noop, silent: noop,
    level: "silent", child: () => silentLogger(warn),
  } as unknown as McpRuntime["logger"];
}

function profile(disallowedTools?: string[]): AgentProfile {
  return {
    id: "profile-lookup-test",
    name: "Profile lookup test",
    backend: "claude",
    workspace_dir: "/tmp/profile-lookup-ws",
    ...(disallowedTools ? { disallowed_tools: disallowedTools } : {}),
  };
}

interface Harness {
  baseUrl: string;
  db: SessionDB;
  warn: WarnFn;
  profiles: Map<string, AgentProfile>;
  worktreeList: WorktreeListFn;
  close: () => Promise<void>;
}

const openServers: Harness[] = [];

async function startServer(options: { stateless?: boolean; restricted?: boolean } = {}): Promise<Harness> {
  const db = new SessionDB();
  const warn = vi.fn();
  const profiles = new Map<string, AgentProfile>();
  const worktreeList = vi.fn(async () => []);
  const runtime = {
    nodeId: "test-node",
    agentsConfigPath: "/tmp/agents.yaml",
    db,
    taskManager: { listTasks: () => [], getTask: () => undefined },
    taskExecutor: {},
    onResume: () => undefined,
    agentRegistry: {
      listAgents: () => [...profiles.values()],
      get: (id: string) => profiles.get(id),
    },
    catalogService: { broadcastSessionDeletion: vi.fn(async () => undefined) },
    worktreeService: { list: worktreeList },
    logger: silentLogger(warn),
    // 재시도 횟수는 실제와 같게 두고 대기만 없앤다.
    sessionProfileLookupSleep: async () => {},
  } as unknown as McpRuntime;
  const server = await buildInternalMcpServer({
    logger: silentLogger(),
    statelessTransport: options.stateless ?? true,
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
    profiles,
    worktreeList,
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
    clientInfo: { name: "profile-lookup-test", version: "0.0.0" },
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
  name: string,
  sessionId?: string,
  args: Record<string, unknown> = {},
): Promise<Record<string, any>> {
  return await payloadOf(await postMcp(
    baseUrl,
    authorization,
    { jsonrpc: "2.0", method: "tools/call", params: { name, arguments: args }, id: 3 },
    sessionId,
  ));
}

const unavailableText = "세션 프로필을 잠시 확인할 수 없습니다. 잠시 후 다시 시도하세요.";

describe("session profile lookup failures", () => {
  it("closes only tools/call when the session DB keeps failing; initialize and tools/list still succeed", async () => {
    const harness = await startServer();
    vi.spyOn(harness.db, "getSession").mockRejectedValue(new Error("ECONNREFUSED"));

    const init = await postMcp(harness.baseUrl, FULL, initializeBody);
    expect(init.status).toBe(200);
    const initPayload = await payloadOf(init);
    expect(initPayload.result?.serverInfo).toBeTruthy();

    const serviceNames = await toolNames(harness.baseUrl, SERVICE);
    const names = await toolNames(harness.baseUrl, FULL);
    expect(serviceNames).toContain("search_sessions");
    expect(names).toHaveLength(serviceNames.length);

    harness.worktreeList.mockClear();
    const denied = await callTool(harness.baseUrl, FULL, "list_worktrees");
    expect(denied.result?.isError).toBe(true);
    expect(denied.result?.structuredContent?.code).toBe("MCP_PROFILE_UNAVAILABLE");
    expect(String(denied.result?.content?.[0]?.text)).toBe(unavailableText);
    expect(harness.worktreeList).not.toHaveBeenCalled();

    expect(harness.warn).toHaveBeenCalledWith(
      { sessionId: SESSION_A, reason: "ECONNREFUSED", attempts: 3 },
      "MCP tools/call rejected: session agent profile lookup failed",
    );
  });

  it("closes tools/call in stateful transports too", async () => {
    const harness = await startServer({ stateless: false });
    vi.spyOn(harness.db, "getSession").mockRejectedValue(new Error("ECONNREFUSED"));

    const sessionId = await initialize(harness.baseUrl, FULL);
    expect((await toolNames(harness.baseUrl, FULL, sessionId)).length).toBeGreaterThan(0);

    harness.worktreeList.mockClear();
    const denied = await callTool(harness.baseUrl, FULL, "list_worktrees", sessionId);
    expect(denied.result?.isError).toBe(true);
    expect(denied.result?.structuredContent?.code).toBe("MCP_PROFILE_UNAVAILABLE");
    expect(harness.worktreeList).not.toHaveBeenCalled();
  });

  it("retries the session lookup and filters once a retry succeeds", async () => {
    const harness = await startServer();
    const getSession = vi.spyOn(harness.db, "getSession")
      .mockRejectedValueOnce(new Error("ECONNREFUSED"))
      .mockRejectedValueOnce(new Error("ECONNREFUSED"))
      .mockResolvedValue({ agent_id: "agent-a" } as never);
    harness.profiles.set("agent-a", profile(["mcp__soulstream__search_sessions"]));

    const names = await toolNames(harness.baseUrl, FULL);
    expect(names).not.toContain("search_sessions");
    expect(names).toContain("list_worktrees");
    expect(getSession).toHaveBeenCalledTimes(3);

    harness.worktreeList.mockClear();
    const allowed = await callTool(harness.baseUrl, FULL, "list_worktrees");
    expect(allowed.result?.isError).toBeUndefined();
    expect(harness.worktreeList).toHaveBeenCalledTimes(1);

    const denied = await callTool(harness.baseUrl, FULL, "search_sessions", undefined, { query: "hello" });
    expect(denied.result?.isError).toBe(true);
    expect(String(denied.result?.content?.[0]?.text)).toContain("disabled");
    expect(getSession).toHaveBeenCalledTimes(3);
  });
});

describe("profile lookup misses", () => {
  it.each([
    ["no_session", null],
    ["no_agent_id", { agent_id: "" }],
    ["unknown_agent", { agent_id: "ghost-agent" }],
  ])("keeps the surface unfiltered and warns with reason %s", async (reason, row) => {
    const harness = await startServer();
    vi.spyOn(harness.db, "getSession").mockResolvedValue(row as never);

    const serviceNames = await toolNames(harness.baseUrl, SERVICE);
    const names = await toolNames(harness.baseUrl, FULL);
    expect(names).toHaveLength(serviceNames.length);
    expect(harness.warn).toHaveBeenCalledWith(
      { sessionId: SESSION_A, reason },
      "MCP session agent profile missing",
    );

    harness.worktreeList.mockClear();
    const payload = await callTool(harness.baseUrl, FULL, "list_worktrees");
    expect(payload.result?.isError).toBeUndefined();
    expect(harness.worktreeList).toHaveBeenCalledTimes(1);
  });
});

describe("session agent id memory", () => {
  it("keeps filtering with the remembered profile when the session DB later fails", async () => {
    const harness = await startServer();
    const getSession = vi.spyOn(harness.db, "getSession")
      .mockResolvedValue({ agent_id: "agent-a" } as never);
    harness.profiles.set("agent-a", profile(["mcp__soulstream__search_sessions"]));

    expect(await toolNames(harness.baseUrl, FULL)).not.toContain("search_sessions");
    expect(getSession).toHaveBeenCalledTimes(1);

    getSession.mockRejectedValue(new Error("ECONNREFUSED"));
    const names = await toolNames(harness.baseUrl, FULL);
    expect(names).not.toContain("search_sessions");
    expect(getSession).toHaveBeenCalledTimes(1);

    harness.worktreeList.mockClear();
    const allowed = await callTool(harness.baseUrl, FULL, "list_worktrees");
    expect(allowed.result?.isError).toBeUndefined();
    expect(harness.worktreeList).toHaveBeenCalledTimes(1);
    expect(getSession).toHaveBeenCalledTimes(1);
  });

  it("reflects disallowed_tools changes on the next request", async () => {
    const harness = await startServer();
    vi.spyOn(harness.db, "getSession").mockResolvedValue({ agent_id: "agent-a" } as never);
    harness.profiles.set("agent-a", profile(["mcp__soulstream__search_sessions"]));

    let names = await toolNames(harness.baseUrl, FULL);
    expect(names).not.toContain("search_sessions");
    expect(names).toContain("list_sessions");

    harness.profiles.set("agent-a", profile(["mcp__soulstream__list_sessions"]));
    names = await toolNames(harness.baseUrl, FULL);
    expect(names).toContain("search_sessions");
    expect(names).not.toContain("list_sessions");
  });

  it("keeps the most recently used 5,000 agent ids", () => {
    expect(DEFAULT_AGENT_ID_CACHE_LIMIT).toBe(5_000);
    const cache = new SessionAgentIdCache();
    for (let index = 0; index < DEFAULT_AGENT_ID_CACHE_LIMIT; index += 1) {
      cache.set(`session-${index}`, `agent-${index}`);
    }
    expect(cache.size).toBe(DEFAULT_AGENT_ID_CACHE_LIMIT);

    // 가장 오래 쓴 항목을 다시 읽으면 최근으로 올라간다.
    expect(cache.get("session-0")).toBe("agent-0");
    cache.set("session-overflow", "agent-overflow");
    expect(cache.size).toBe(DEFAULT_AGENT_ID_CACHE_LIMIT);
    expect(cache.get("session-1")).toBeUndefined();
    expect(cache.get("session-0")).toBe("agent-0");
    expect(cache.get("session-overflow")).toBe("agent-overflow");
  });
});

describe("findSessionAgentProfile retry timing", () => {
  function runtimeWith(getSession: (...args: unknown[]) => Promise<unknown>, getProfile: (id: string) => AgentProfile | undefined = () => undefined) {
    return {
      taskManager: { getTask: () => undefined },
      db: { getSession },
      agentRegistry: { get: getProfile },
    } as unknown as Pick<McpRuntime, "taskManager" | "db" | "agentRegistry">;
  }

  it("waits 200ms then 400ms between three attempts and reports the reason", async () => {
    const sleep = vi.fn(async (_ms: number) => {});
    const getSession = vi.fn(async () => {
      throw new Error("ECONNREFUSED");
    });

    const lookup = await findSessionAgentProfile(runtimeWith(getSession), SESSION_A, { sleep });

    expect(lookup).toEqual({ status: "unavailable", attempts: 3, reason: "ECONNREFUSED" });
    expect(sleep.mock.calls.map(([ms]) => ms)).toEqual([200, 400]);
    expect(getSession).toHaveBeenCalledTimes(3);
  });

  it("finds the profile when a later attempt succeeds", async () => {
    const sleep = vi.fn(async (_ms: number) => {});
    const found = profile();
    const getSession = vi.fn()
      .mockRejectedValueOnce(new Error("ECONNREFUSED"))
      .mockRejectedValueOnce(new Error("timeout"))
      .mockResolvedValueOnce({ agent_id: "agent-a" });

    const lookup = await findSessionAgentProfile(
      runtimeWith(getSession as never, (id) => (id === "agent-a" ? found : undefined)),
      SESSION_A,
      { sleep },
    );

    expect(lookup).toEqual({ status: "found", profile: found });
    expect(sleep).toHaveBeenCalledTimes(2);
  });

  it("does not retry or remember a missing session or a missing agent", async () => {
    const sleep = vi.fn(async (_ms: number) => {});
    const getSession = vi.fn(async () => null);

    const lookup = await findSessionAgentProfile(runtimeWith(getSession as never), SESSION_A, { sleep });

    expect(lookup).toEqual({ status: "missing", reason: "no_session" });
    expect(sleep).not.toHaveBeenCalled();
    expect(getSession).toHaveBeenCalledTimes(1);
  });
});

describe("service and restricted credentials", () => {
  it("does not look up a profile for a service token without a session id", async () => {
    const harness = await startServer();
    const getSession = vi.spyOn(harness.db, "getSession");

    const names = await toolNames(harness.baseUrl, SERVICE);

    expect(names).toContain("search_sessions");
    expect(getSession).not.toHaveBeenCalled();
    expect(harness.warn).not.toHaveBeenCalled();
  });

  async function expectRestrictedClosed(stateless: boolean): Promise<void> {
    const harness = await startServer({ restricted: true, stateless });
    vi.spyOn(harness.db, "getSession").mockRejectedValue(new Error("ECONNREFUSED"));

    const sessionId = stateless ? undefined : await initialize(harness.baseUrl, RESTRICTED);
    const names = await toolNames(harness.baseUrl, RESTRICTED, sessionId);
    expect(names).not.toContain("delete_session");
    expect(names).toContain("list_worktrees");

    harness.worktreeList.mockClear();
    const payload = await callTool(harness.baseUrl, RESTRICTED, "list_worktrees", sessionId);
    expect(payload.result?.isError).toBe(true);
    expect(payload.result?.structuredContent?.code).toBe("MCP_PROFILE_UNAVAILABLE");
    expect(String(payload.result?.content?.[0]?.text)).toBe(unavailableText);
    expect(harness.worktreeList).not.toHaveBeenCalled();
    expect(harness.warn).toHaveBeenCalledWith(
      { sessionId: SESSION_A, reason: "ECONNREFUSED", attempts: 3 },
      "MCP session agent profile lookup failed",
    );
    expect(harness.warn).toHaveBeenCalledWith(
      { sessionId: SESSION_A, reason: "ECONNREFUSED", attempts: 3 },
      "MCP tools/call rejected: session agent profile lookup failed",
    );
  }

  it("keeps the restricted policy and closes tools/call when the profile lookup fails (stateless)", async () => {
    await expectRestrictedClosed(true);
  });

  it("keeps the restricted policy and closes tools/call when the profile lookup fails (stateful)", async () => {
    await expectRestrictedClosed(false);
  });

  async function expectRestrictedFiltersAfterRetry(stateless: boolean): Promise<void> {
    const harness = await startServer({ restricted: true, stateless });
    const getSession = vi.spyOn(harness.db, "getSession")
      .mockRejectedValueOnce(new Error("ECONNREFUSED"))
      .mockRejectedValueOnce(new Error("ECONNREFUSED"))
      .mockResolvedValue({ agent_id: "agent-a" } as never);
    harness.profiles.set("agent-a", profile(["mcp__soulstream__search_sessions"]));

    const sessionId = stateless ? undefined : await initialize(harness.baseUrl, RESTRICTED);
    const names = await toolNames(harness.baseUrl, RESTRICTED, sessionId);
    expect(getSession).toHaveBeenCalledTimes(3);
    // 정책이 막은 도구와 프로필이 막은 도구가 함께 빠진다.
    expect(names).not.toContain("delete_session");
    expect(names).not.toContain("search_sessions");
    expect(names).toContain("list_worktrees");

    harness.worktreeList.mockClear();
    const allowed = await callTool(harness.baseUrl, RESTRICTED, "list_worktrees", sessionId);
    expect(allowed.result?.isError).toBeUndefined();
    expect(harness.worktreeList).toHaveBeenCalledTimes(1);

    const denied = await callTool(
      harness.baseUrl,
      RESTRICTED,
      "search_sessions",
      sessionId,
      { query: "hello" },
    );
    expect(denied.result?.isError).toBe(true);
    expect(String(denied.result?.content?.[0]?.text)).toContain("disabled");
    expect(getSession).toHaveBeenCalledTimes(3);
  }

  it("applies the restricted policy and the profile disallowed filter together after retries succeed (stateless)", async () => {
    await expectRestrictedFiltersAfterRetry(true);
  });

  it("applies the restricted policy and the profile disallowed filter together after retries succeed (stateful)", async () => {
    await expectRestrictedFiltersAfterRetry(false);
  });
});

/**
 * restricted principal의 실제 MCP 표면(§4) — raw HTTP로 확인한다.
 *
 * - tools/list는 deny를 빼고 allow+guarded+inherit만 노출한다(107).
 * - deny 도구의 tools/call은 handler를 한 번도 실행하지 않는다.
 * - guard 실패는 orchestrator 전달 전에 MCP_POLICY_DENIED로 끝난다.
 * - caller_session_id 선언 도구는 인증된 restricted 세션으로 강제된다.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { buildInternalMcpServer } from "../../src/server.js";
import type { McpRuntime } from "../../src/mcp/runtime.js";
import { SessionDB } from "../../src/db/session_db.js";
import type { SessionExecutionChain } from "../../src/db/session_db_types.js";
import { createRestrictedMcpToken } from "../../src/security/restricted_mcp_auth.js";
import {
  defaultIsolationPolicyPath,
  loadIsolationPolicyFile,
} from "../../src/security/session_isolation_policy.js";
import type { McpRestrictedAuthConfig } from "../../src/mcp/auth.js";

const KEY = "test-restricted-key-0001";
const SESSION_A = "11111111-1111-4111-8111-111111111111";
const SESSION_B = "22222222-2222-4222-8222-222222222222";
const OTHER = "33333333-3333-4333-8333-333333333333";
const TOKEN_A = createRestrictedMcpToken(SESSION_A, KEY);
const loadedPolicy = loadIsolationPolicyFile(defaultIsolationPolicyPath());

function silentLogger() {
  const noop = () => {};
  return {
    fatal: noop, error: noop, warn: noop, info: noop, debug: noop, trace: noop, silent: noop,
    level: "silent", child: () => silentLogger(),
  } as unknown as McpRuntime["logger"];
}

function row(sessionId: string, callerSessionId: string | null) {
  return { session_id: sessionId, caller_session_id: callerSessionId, model_preset: null, model: null, agent_id: null };
}

interface Harness {
  server: Awaited<ReturnType<typeof buildInternalMcpServer>>;
  baseUrl: string;
  db: SessionDB;
  worktreeList: ReturnType<typeof vi.fn>;
}

function makeRuntime(): { runtime: McpRuntime; db: SessionDB; worktreeList: ReturnType<typeof vi.fn> } {
  const db = new SessionDB();
  const worktreeList = vi.fn(async () => []);
  const runtime = {
    nodeId: "test-node",
    agentsConfigPath: "/tmp/agents.yaml",
    db,
    taskManager: { deleteTask: vi.fn(async () => undefined), listTasks: () => [], getTask: () => undefined },
    taskExecutor: {},
    onResume: () => undefined,
    agentRegistry: { listAgents: () => [] },
    catalogService: { broadcastSessionDeletion: vi.fn(async () => undefined) },
    logger: silentLogger(),
    worktreeService: { list: worktreeList },
  } as unknown as McpRuntime;
  return { runtime, db, worktreeList };
}

async function startServer(
  restricted: McpRestrictedAuthConfig | undefined,
  auth = { requireAuth: true, bearerToken: KEY, allowedHosts: ["127.0.0.1", "localhost"] },
): Promise<Harness> {
  const { runtime, db, worktreeList } = makeRuntime();
  const server = await buildInternalMcpServer({
    logger: silentLogger(),
    statelessTransport: false,
    runtime,
    path: "/mcp",
    auth,
    ...(restricted ? { restricted } : {}),
  });
  const baseUrl = await server.listen({ host: "127.0.0.1", port: 0 });
  return { server, baseUrl, db, worktreeList };
}

async function initialize(baseUrl: string, authorization: string): Promise<string> {
  const res = await fetch(`${baseUrl}/mcp`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      authorization,
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      method: "initialize",
      params: {
        protocolVersion: "2024-11-05",
        capabilities: {},
        clientInfo: { name: "restricted-test", version: "0.0.0" },
      },
      id: 1,
    }),
  });
  expect(res.status).toBe(200);
  const sessionId = res.headers.get("mcp-session-id");
  expect(sessionId).toBeTruthy();
  await res.text();
  return sessionId ?? "";
}

async function rpc(
  baseUrl: string,
  sessionId: string,
  authorization: string,
  body: Record<string, unknown>,
): Promise<Record<string, any>> {
  const res = await fetch(`${baseUrl}/mcp`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      authorization,
      "mcp-session-id": sessionId,
    },
    body: JSON.stringify(body),
  });
  expect(res.status).toBe(200);
  const text = await res.text();
  const data = text.split("\n").find((line) => line.startsWith("data: "))?.slice("data: ".length);
  return JSON.parse(data ?? text) as Record<string, any>;
}

const restrictedConfig: McpRestrictedAuthConfig = {
  policyProvider: { get: () => loadedPolicy },
  sessionExists: async (sessionId) => sessionId === SESSION_A || sessionId === SESSION_B,
};

describe("restricted MCP tool surface", () => {
  let harness: Harness;
  let sessionId: string;

  beforeAll(async () => {
    harness = await startServer(restrictedConfig);
    sessionId = await initialize(harness.baseUrl, `Bearer ${TOKEN_A}`);
  });

  afterAll(async () => {
    if (harness.server.closeMcp) await harness.server.closeMcp();
    await harness.server.close();
  });

  it("lists only allow, guarded and inherit tools (107)", async () => {
    const payload = await rpc(harness.baseUrl, sessionId, `Bearer ${TOKEN_A}`, {
      jsonrpc: "2.0", method: "tools/list", params: {}, id: 2,
    });
    const names: string[] = (payload.result?.tools ?? []).map((tool: { name: string }) => tool.name);
    expect(names).toHaveLength(107);
    for (const denied of ["delete_session", "run_card", "update_agent_profile", "dispatch_work"]) {
      expect(names).not.toContain(denied);
    }
    expect(names).toContain("observe_node_services");
    expect(names).toContain("send_message_to_session");
    expect(names).toContain("create_agent_session");
  });

  it("rejects a deny tool call before its handler runs", async () => {
    const spy = vi.spyOn(harness.db, "getBoardItemIdsForSession").mockResolvedValue([]);
    const payload = await rpc(harness.baseUrl, sessionId, `Bearer ${TOKEN_A}`, {
      jsonrpc: "2.0",
      method: "tools/call",
      params: { name: "delete_session", arguments: { session_id: SESSION_B } },
      id: 3,
    });
    expect(payload.error).toBeUndefined();
    expect(payload.result?.isError).toBe(true);
    expect(String(payload.result?.content?.[0]?.text)).toContain("disabled");
    expect(spy).not.toHaveBeenCalled();
  });

  it("denies a guarded message to an unrelated session before forwarding", async () => {
    vi.spyOn(harness.db, "getSessionCallerChain").mockImplementation(async (id: string) => {
      if (id === SESSION_A) return { root: row(SESSION_A, null), ancestors: [] } as SessionExecutionChain;
      if (id === OTHER) return { root: row(OTHER, null), ancestors: [] } as SessionExecutionChain;
      return { root: null, ancestors: [] } as SessionExecutionChain;
    });
    const getSession = vi.spyOn(harness.db, "getSession").mockResolvedValue(null);

    const payload = await rpc(harness.baseUrl, sessionId, `Bearer ${TOKEN_A}`, {
      jsonrpc: "2.0",
      method: "tools/call",
      params: {
        name: "send_message_to_session",
        arguments: { target_session_id: OTHER, message: "hello" },
      },
      id: 4,
    });
    expect(payload.result?.isError).toBe(true);
    expect(payload.result?.content?.[0]?.text).toBe("MCP_POLICY_DENIED: message-recipient");
    expect(getSession).not.toHaveBeenCalled();
  });

  it("forces caller_session_id to the authenticated restricted session", async () => {
    harness.worktreeList.mockClear();
    const payload = await rpc(harness.baseUrl, sessionId, `Bearer ${TOKEN_A}`, {
      jsonrpc: "2.0",
      method: "tools/call",
      params: {
        name: "list_worktrees",
        arguments: { caller_session_id: OTHER },
      },
      id: 5,
    });
    expect(payload.result?.isError).toBeUndefined();
    expect(harness.worktreeList).toHaveBeenCalledTimes(1);
    expect(harness.worktreeList.mock.calls[0]?.[0]).toMatchObject({ actorSessionId: SESSION_A });
  });
});

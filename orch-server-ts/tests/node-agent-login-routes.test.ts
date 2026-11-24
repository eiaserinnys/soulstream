import { describe, expect, it, vi } from "vitest";

import type { NodeClaudeAuthRouteOptions } from "../src/node/node_claude_auth_routes.js";
import { createClaudeAuthHarness } from "./node-claude-auth-test-helpers.js";
import { loadContractFixtures } from "../src/index.js";
import type { NodeRegistrationPayload } from "../src/node/registry.js";
import type { UsageSummarySnapshot } from "../src/usage/usage_summary_service.js";

const SECRET_URL = "https://auth.example.test/device?secret=SHOULD-NOT-ECHO";
const SECRET_CODE = "PASTED-CODE-SHOULD-NOT-ECHO";

function flow(overrides: Record<string, unknown> = {}) {
  return {
    login_id: "login-a",
    provider: "codex",
    state: "url_ready",
    auth_url: "https://login.example.test/device",
    user_code: "AAAA-BBBBB",
    expects_code: false,
    expires_at: "2026-11-24T16:00:00.000Z",
    error: null,
    ...overrides,
  };
}

const emptySummary: UsageSummarySnapshot = { collectedAt: "2026-11-24T15:00:00.000Z", nodes: [] } as unknown as UsageSummarySnapshot;

/** createClaudeAuthHarness가 만든 레지스트리에 agent_login_v1을 알리는 노드를 붙인다. */
function createHarness(options: {
  capable?: boolean;
  ackFor?: (message: Record<string, unknown>) => Record<string, unknown>;
  refreshNode?: () => Promise<UsageSummarySnapshot>;
  registerNode?: boolean;
} = {}) {
  const harness = createClaudeAuthHarness({
    registerNode: false,
    attachTransport: false,
    usageSummary: { refreshNode: options.refreshNode ?? (async () => emptySummary) },
  });
  if (options.registerNode !== false) {
    const registration = loadContractFixtures().fakeNodeReconnect.registration as NodeRegistrationPayload;
    const connectionId = harness.registry.registerNode({
      ...registration,
      capabilities: { ...(registration.capabilities ?? {}), ...(options.capable === false ? {} : { agent_login_v1: true }) },
    }).node.connectionId;
    harness.transports.attach({
      nodeId: "fake-node",
      connectionId,
      transport: {
        send: (data) => {
          const message = JSON.parse(data) as Record<string, unknown>;
          harness.sent.push(message);
          harness.registry.receiveNodeMessage(
            { nodeId: "fake-node", connectionId },
            { type: message.type, success: true, data: flow(), ...options.ackFor?.(message), requestId: message.requestId },
          );
        },
      },
    });
  }
  return harness;
}

const base = "/api/nodes/fake-node/agent-logins";

describe("노드 Codex와 Antigravity 로그인 경로", () => {
  it("네 경로가 워커 명령으로 가고 202와 200으로 스냅샷을 그대로 돌려준다", async () => {
    const refreshNode = vi.fn(async () => emptySummary);
    const { app, sent } = createHarness({ refreshNode });

    const started = await app.inject({ method: "POST", url: `${base}/codex` });
    const status = await app.inject({ method: "GET", url: `${base}/login-a` });
    const submitted = await app.inject({ method: "POST", url: `${base}/login-a/code`, payload: { code: SECRET_CODE } });
    const cancelled = await app.inject({ method: "DELETE", url: `${base}/login-a` });

    expect(started.statusCode).toBe(202);
    expect(started.json()).toEqual(flow());
    expect([status.statusCode, submitted.statusCode, cancelled.statusCode]).toEqual([200, 200, 200]);
    expect(sent.map((message) => message.type)).toEqual([
      "agent_login_start", "agent_login_status", "agent_login_submit_code", "agent_login_cancel",
    ]);
    expect(sent[0]).toMatchObject({ provider: "codex" });
    expect(sent[1]).toMatchObject({ login_id: "login-a" });
    expect(sent[2]).toMatchObject({ login_id: "login-a", code: SECRET_CODE });
    expect(sent[3]).toMatchObject({ login_id: "login-a" });
    expect(refreshNode).not.toHaveBeenCalled();
    await app.close();
  });

  it("스냅샷이 done이면 그 노드의 사용량을 곧바로 다시 읽는다", async () => {
    const refreshNode = vi.fn(async () => emptySummary);
    const { app } = createHarness({
      refreshNode,
      ackFor: (message) => message.type === "agent_login_status" ? { data: flow({ state: "done", auth_url: null, user_code: null }) } : {},
    });
    const status = await app.inject({ method: "GET", url: `${base}/login-a` });
    expect(status.statusCode).toBe(200);
    expect(status.json()).toMatchObject({ state: "done" });
    expect(refreshNode).toHaveBeenCalledTimes(1);
    expect(refreshNode).toHaveBeenCalledWith("fake-node");
    await app.close();
  });

  it("사용량 다시 읽기가 실패해도 로그인 결과는 그대로 돌려준다", async () => {
    const { app } = createHarness({
      refreshNode: async () => { throw new Error("usage down"); },
      ackFor: () => ({ data: flow({ state: "done" }) }),
    });
    const status = await app.inject({ method: "GET", url: `${base}/login-a` });
    expect(status.statusCode).toBe(200);
    expect(status.json()).toMatchObject({ state: "done" });
    await app.close();
  });

  it("능력을 알리지 않은 노드는 워커에 보내지 않고 409 agent_login_unsupported다", async () => {
    const { app, sent } = createHarness({ capable: false });
    const responses = await Promise.all([
      app.inject({ method: "POST", url: `${base}/codex` }),
      app.inject({ method: "GET", url: `${base}/login-a` }),
      app.inject({ method: "POST", url: `${base}/login-a/code`, payload: { code: SECRET_CODE } }),
      app.inject({ method: "DELETE", url: `${base}/login-a` }),
    ]);
    for (const response of responses) {
      expect(response.statusCode).toBe(409);
      expect(response.json()).toEqual({
        code: "agent_login_unsupported",
        message: "이 노드는 Codex와 Antigravity 로그인을 지원하지 않습니다.",
      });
      expect(response.body).not.toContain(SECRET_CODE);
    }
    expect(sent).toEqual([]);
    await app.close();
  });

  it("연결되지 않은 노드는 404 node_not_connected다", async () => {
    const { app } = createHarness({ registerNode: false });
    const response = await app.inject({ method: "POST", url: `${base}/codex` });
    expect(response.statusCode).toBe(404);
    expect(response.json()).toEqual({ code: "node_not_connected", message: "노드가 연결되어 있지 않습니다." });
    await app.close();
  });

  it.each([
    ["login_not_found", 404],
    ["agent_login_unsupported", 409],
    ["cli_not_installed", 409],
    ["login_not_ready", 409],
    ["code_not_expected", 409],
    ["invalid_request", 422],
    ["login_flow_failed", 502],
    ["something_new", 502],
  ])("워커 거절 %s는 HTTP %i이고 본문은 {code, message}뿐이다", async (code, status) => {
    const { app } = createHarness({
      ackFor: () => ({ success: false, data: undefined, error: { code, message: `${SECRET_URL} ${SECRET_CODE}` } }),
    });
    const response = await app.inject({ method: "POST", url: `${base}/login-a/code`, payload: { code: "x" } });
    expect(response.statusCode).toBe(status);
    expect(Object.keys(response.json()).sort()).toEqual(["code", "message"]);
    expect(response.json().code).toBe(code);
    // 워커가 보낸 문구는 싣지 않는다.
    expect(response.body).not.toContain(SECRET_URL);
    expect(response.body).not.toContain(SECRET_CODE);
    await app.close();
  });

  it("워커 오류 코드가 이상한 값이면 node_command_rejected 502로 바꾼다", async () => {
    const { app } = createHarness({ ackFor: () => ({ success: false, error: { code: "not a code!", message: "x" } }) });
    const response = await app.inject({ method: "GET", url: `${base}/login-a` });
    expect(response.statusCode).toBe(502);
    expect(response.json().code).toBe("node_command_rejected");
    await app.close();
  });

  it("올바르지 않은 공급자 이름과 코드 본문은 워커에 보내지 않고 422다", async () => {
    const { app, sent } = createHarness();
    const responses = await Promise.all([
      app.inject({ method: "POST", url: `${base}/Not%20A%20Provider` }),
      app.inject({ method: "POST", url: `${base}/login-a/code`, payload: { code: "" } }),
      app.inject({ method: "POST", url: `${base}/login-a/code`, payload: { code: "   " } }),
      app.inject({ method: "POST", url: `${base}/login-a/code`, payload: { code: 12 } }),
      app.inject({ method: "POST", url: `${base}/login-a/code`, payload: { code: "x", extra: true } }),
      app.inject({ method: "POST", url: `${base}/login-a/code`, payload: { code: "x".repeat(5_000) } }),
      app.inject({ method: "POST", url: `${base}/login-a/code` }),
    ]);
    expect(responses.map((response) => response.statusCode)).toEqual([422, 422, 422, 422, 422, 422, 422]);
    expect(responses.every((response) => response.json().code === "invalid_request")).toBe(true);
    expect(sent).toEqual([]);
    await app.close();
  });

  it("모르는 공급자 이름은 워커가 agent_login_unsupported로 거절하고 409가 된다", async () => {
    const { app, sent } = createHarness({
      ackFor: (message) => message.provider === "claude"
        ? { success: false, error: { code: "agent_login_unsupported", message: "no" } }
        : {},
    });
    const response = await app.inject({ method: "POST", url: `${base}/claude` });
    expect(sent).toHaveLength(1);
    expect(response.statusCode).toBe(409);
    expect(response.json().code).toBe("agent_login_unsupported");
    await app.close();
  });

  it("전송이 실패하면 502 node_command_failed이고 본문에 원인을 싣지 않는다", async () => {
    const { app, bridge } = createHarness();
    vi.spyOn(bridge, "sendPendingCommand").mockRejectedValue(new Error(`boom ${SECRET_URL}`));
    const response = await app.inject({ method: "POST", url: `${base}/codex` });
    expect(response.statusCode).toBe(502);
    expect(response.json()).toEqual({ code: "node_command_failed", message: "로그인 노드 요청을 처리하지 못했습니다." });
    await app.close();
  });

  it("관리자 판정이 주어지면 관리자가 아닌 사용자는 403이고 워커에 보내지 않는다", async () => {
    const harness = createHarness();
    const adminAccess = { currentEmail: () => "user@example.test", isAdminEmail: (email: string) => email === "admin@example.test" };
    (harness.routeOptions as NodeClaudeAuthRouteOptions & { adminAccess?: unknown }).adminAccess = adminAccess;
    const denied = await harness.app.inject({ method: "POST", url: `${base}/codex` });
    expect(denied.statusCode).toBe(403);
    expect(harness.sent).toEqual([]);

    adminAccess.currentEmail = () => "admin@example.test";
    const allowed = await harness.app.inject({ method: "POST", url: `${base}/codex` });
    expect(allowed.statusCode).toBe(202);
    await harness.app.close();
  });

  it("관리자 판정은 Claude 풀 경로에 걸리지 않는다", async () => {
    const claudePoolRequests = [
      { method: "GET", url: "/api/nodes/fake-node/claude-auth/accounts" },
      { method: "POST", url: "/api/nodes/fake-node/claude-auth/logins", payload: {} },
      { method: "GET", url: "/api/nodes/fake-node/claude-auth/logins/login-a" },
      { method: "DELETE", url: "/api/nodes/fake-node/claude-auth/logins/login-a" },
    ] as const;

    const plain = createHarness();
    const without = [];
    for (const request of claudePoolRequests) without.push((await plain.app.inject(request)).statusCode);
    await plain.app.close();

    const guarded = createHarness();
    (guarded.routeOptions as NodeClaudeAuthRouteOptions & { adminAccess?: unknown }).adminAccess = {
      currentEmail: () => "user@example.test",
      isAdminEmail: () => false,
    };
    const withGuard = [];
    for (const request of claudePoolRequests) withGuard.push((await guarded.app.inject(request)).statusCode);
    const agentLogin = await guarded.app.inject({ method: "POST", url: `${base}/codex` });
    await guarded.app.close();

    expect(withGuard).toEqual(without);
    expect(withGuard).not.toContain(403);
    expect(agentLogin.statusCode).toBe(403);
  });
});

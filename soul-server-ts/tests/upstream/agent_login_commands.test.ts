import type { AgentLoginFlow } from "@soulstream/wire-schema";
import pino from "pino";
import { describe, expect, it, vi } from "vitest";

import { AgentRegistry } from "../../src/agent_registry.js";
import { supportsAgentLogin } from "../../src/agent_login/capability.js";
import { AgentLoginServiceError } from "../../src/agent_login/types.js";
import type { ProviderUsageCommandHandler } from "../../src/auth/provider_usage.js";
import type { TaskExecutor } from "../../src/task/task_executor.js";
import type { TaskManager } from "../../src/task/task_manager.js";
import type { AgentLoginCommandHandler } from "../../src/upstream/agent_login_commands.js";
import { buildRegistrationMsg } from "../../src/upstream/registration.js";
import { createUpstreamCommandDispatcher } from "../../src/upstream/upstream_command_dispatcher.js";

function flow(overrides: Partial<AgentLoginFlow> = {}): AgentLoginFlow {
  return {
    login_id: "login-1",
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

function setup(service?: Partial<AgentLoginCommandHandler>) {
  const handler = {
    start: vi.fn(async () => flow()),
    status: vi.fn(async () => flow()),
    submit_code: vi.fn(async () => flow({ provider: "antigravity", state: "code_submitted" })),
    cancel: vi.fn(async () => flow({ state: "cancelled", auth_url: null, user_code: null })),
    ...service,
  } as AgentLoginCommandHandler;
  const sent: unknown[] = [];
  const dispatcher = createUpstreamCommandDispatcher({
    send: vi.fn(async (message: unknown) => { sent.push(message); }) as never,
    logger: pino({ level: "silent" }),
    nodeId: "node-a",
    dependencies: {
      agentRegistry: new AgentRegistry([]),
      taskManager: {} as TaskManager,
      taskExecutor: {} as TaskExecutor,
      providerUsage: { fetchUsage: vi.fn() } as unknown as ProviderUsageCommandHandler,
      ...(service === null ? {} : { agentLoginService: handler }),
    },
    listRunningSessionIds: async () => [],
  });
  return { dispatcher, handler, sent };
}

describe("agent_login_* 명령", () => {
  it("네 명령이 서비스로 가고 응답은 type, requestId, success, data 꼴이다", async () => {
    const { dispatcher, handler, sent } = setup();

    await dispatcher.dispatch({ type: "agent_login_start", requestId: "r1", provider: "codex" });
    await dispatcher.dispatch({ type: "agent_login_status", requestId: "r2", login_id: "login-1" });
    await dispatcher.dispatch({ type: "agent_login_submit_code", requestId: "r3", login_id: "login-1", code: "abc" });
    await dispatcher.dispatch({ type: "agent_login_cancel", requestId: "r4", login_id: "login-1" });

    expect(handler.start).toHaveBeenCalledWith({ provider: "codex" });
    expect(handler.status).toHaveBeenCalledWith({ login_id: "login-1" });
    expect(handler.submit_code).toHaveBeenCalledWith({ login_id: "login-1", code: "abc" });
    expect(handler.cancel).toHaveBeenCalledWith({ login_id: "login-1" });
    expect(sent).toEqual([
      { type: "agent_login_start", requestId: "r1", success: true, data: flow() },
      { type: "agent_login_status", requestId: "r2", success: true, data: flow() },
      { type: "agent_login_submit_code", requestId: "r3", success: true, data: flow({ provider: "antigravity", state: "code_submitted" }) },
      { type: "agent_login_cancel", requestId: "r4", success: true, data: flow({ state: "cancelled", auth_url: null, user_code: null }) },
    ]);
  });

  it.each([
    ["agent_login_unsupported"],
    ["cli_not_installed"],
    ["login_not_found"],
    ["login_not_ready"],
    ["code_not_expected"],
    ["invalid_request"],
  ] as const)("거절 코드 %s는 success false와 error {code, message}로 돌려준다", async (code) => {
    const { dispatcher, sent } = setup({
      start: vi.fn(async () => { throw new AgentLoginServiceError(code, `reason for ${code}`); }),
    });
    await dispatcher.dispatch({ type: "agent_login_start", requestId: "r1", provider: "codex" });
    expect(sent).toEqual([
      { type: "agent_login_start", requestId: "r1", success: false, error: { code, message: `reason for ${code}` } },
    ]);
  });

  it("예상 밖 오류는 원인 문구를 싣지 않고 login_flow_failed로 돌려준다", async () => {
    const { dispatcher, sent } = setup({
      status: vi.fn(async () => { throw new Error("spawn exploded with /secret/path"); }),
    });
    await dispatcher.dispatch({ type: "agent_login_status", requestId: "r1", login_id: "login-1" });
    expect(sent).toEqual([
      { type: "agent_login_status", requestId: "r1", success: false, error: { code: "login_flow_failed", message: "Agent login failed" } },
    ]);
  });

  it("본문 필드가 빠지면 서비스를 부르지 않고 invalid_request로 거절한다", async () => {
    const { dispatcher, handler, sent } = setup();
    await dispatcher.dispatch({ type: "agent_login_submit_code", requestId: "r1", login_id: "login-1" });
    await dispatcher.dispatch({ type: "agent_login_start", requestId: "r2" });
    expect(handler.submit_code).not.toHaveBeenCalled();
    expect(handler.start).not.toHaveBeenCalled();
    expect(sent).toMatchObject([
      { requestId: "r1", success: false, error: { code: "invalid_request" } },
      { requestId: "r2", success: false, error: { code: "invalid_request" } },
    ]);
  });

  it("서비스가 연결되지 않은 노드는 명령 오류로 알린다", async () => {
    const sent: unknown[] = [];
    const dispatcher = createUpstreamCommandDispatcher({
      send: vi.fn(async (message: unknown) => { sent.push(message); }) as never,
      logger: pino({ level: "silent" }),
      nodeId: "node-a",
      dependencies: {
        agentRegistry: new AgentRegistry([]),
        taskManager: {} as TaskManager,
        taskExecutor: {} as TaskExecutor,
        providerUsage: { fetchUsage: vi.fn() } as unknown as ProviderUsageCommandHandler,
      },
      listRunningSessionIds: async () => [],
    });
    await dispatcher.dispatch({ type: "agent_login_start", requestId: "r1", provider: "codex" });
    expect(sent).toHaveLength(1);
    expect(JSON.stringify(sent[0])).toContain("Agent login service is not configured");
  });
});

describe("등록 능력 agent_login_v1", () => {
  const register = (agents: ConstructorParameters<typeof AgentRegistry>[0]) =>
    buildRegistrationMsg({
      nodeId: "node-a",
      host: "127.0.0.1",
      port: 1,
      userName: "",
      agentRegistry: new AgentRegistry(agents),
    });
  const agent = (backend: "claude" | "codex" | "antigravity") => ({
    id: `${backend}-agent`,
    name: backend,
    backend,
    workspace_dir: "/tmp/agent",
  });

  it("codex나 antigravity 백엔드가 있으면 알리고, claude만 있으면 알리지 않는다", () => {
    expect(register([agent("codex")]).capabilities?.agent_login_v1).toBe(true);
    expect(register([agent("antigravity")]).capabilities?.agent_login_v1).toBe(true);
    expect(register([agent("claude"), agent("codex")]).capabilities?.agent_login_v1).toBe(true);
    expect(register([agent("claude")]).capabilities).not.toHaveProperty("agent_login_v1");
    expect(register([]).capabilities).not.toHaveProperty("agent_login_v1");
  });

  it("판별 함수는 서비스를 만드는 조건과 같다", () => {
    expect(supportsAgentLogin(["claude"])).toBe(false);
    expect(supportsAgentLogin(["claude", "codex"])).toBe(true);
    expect(supportsAgentLogin(["antigravity"])).toBe(true);
  });
});

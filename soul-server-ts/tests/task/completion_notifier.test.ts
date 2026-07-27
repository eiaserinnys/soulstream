/**
 * TaskCompletionNotifier — 피위임 완료 회송 (단계 2 TDD).
 *
 * 분석 캐시 `roselin/.local/artifacts/analysis/20260518-2125-ts-delegation-return.md` §5.
 *
 * 6개 unit:
 *   1. local 우선 — caller가 같은 노드에 있으면 taskManager.addIntervention만 호출
 *   2. orch fallback — local throw 시 orch /intervene HTTP POST (caller_info snake_case)
 *   3. callerSessionId 없음 — no-op
 *   4. 오류 완료 — `❌ 에이전트 세션 오류` 메시지 형식
 *   5. resultText 정본 — lastAssistantText 정합 (있음/없음/error 빈 본문)
 *   6. 양쪽 실패 격리 — local throw + orch throw → notify() resolve
 */
import pino from "pino";
import { describe, expect, it, vi } from "vitest";

import type { AgentRegistry } from "../../src/agent_registry.js";
import type { OrchProxyConfig } from "../../src/mcp/runtime.js";
import { TaskCompletionNotifier } from "../../src/task/completion_notifier.js";
import type {
  AddInterventionParams,
  AddInterventionResult,
  StartExecutionCallback,
  TaskManager,
} from "../../src/task/task_manager.js";
import type { Task } from "../../src/task/task_models.js";

const silentLogger = pino({ level: "silent" });

const NODE_ID = "node-test";

function makeChild(overrides: Partial<Task> = {}): Task {
  return {
    agentSessionId: "child-sess-1",
    prompt: "child prompt",
    status: "completed",
    profileId: "codex-default",
    callerSessionId: "parent-sess-1",
    createdAt: new Date(),
    lastEventId: 5,
    lastReadEventId: 0,
    lastAssistantText: "hello world from child",
    interventionQueue: [],
    ...overrides,
  };
}

function makeAgentRegistry(): AgentRegistry {
  const get = vi.fn((id: string) => {
    if (id === "codex-default") {
      return {
        id: "codex-default",
        name: "Codex Default",
        backend: "codex" as const,
        workspace_dir: "/tmp/codex",
        portrait_path: "portraits/codex.png",
      };
    }
    return undefined;
  });
  return { get } as unknown as AgentRegistry;
}

interface TaskManagerStub {
  taskManager: TaskManager;
  addIntervention: ReturnType<typeof vi.fn>;
}

function makeTaskManagerStub(
  result: AddInterventionResult | Error = { queued: true, queuePosition: 1 },
): TaskManagerStub {
  const addIntervention = vi.fn(
    async (_p: AddInterventionParams, _r: StartExecutionCallback) => {
      if (result instanceof Error) throw result;
      return result;
    },
  );
  const taskManager = { addIntervention } as unknown as TaskManager;
  return { taskManager, addIntervention };
}

function makeOrch(): OrchProxyConfig {
  return {
    baseUrl: "https://orch.example.com",
    headers: { authorization: "Bearer test-token" },
  };
}

describe("TaskCompletionNotifier.notify", () => {
  it("1. local 우선 — caller가 같은 노드에 있으면 addIntervention만 호출", async () => {
    const tm = makeTaskManagerStub();
    const registry = makeAgentRegistry();
    const fetchImpl = vi.fn().mockResolvedValue(new Response("{}", { status: 200 }));
    const onResume = vi.fn();

    const notifier = new TaskCompletionNotifier(
      NODE_ID,
      tm.taskManager,
      registry,
      onResume,
      silentLogger,
      makeOrch(),
      fetchImpl,
    );

    const child = makeChild();
    await notifier.notify(child);

    // local addIntervention 1회
    expect(tm.addIntervention).toHaveBeenCalledTimes(1);
    const [params, resumeCb] = tm.addIntervention.mock.calls[0]!;
    expect(params.agentSessionId).toBe("parent-sess-1");
    expect(params.user).toBe("agent");
    expect(params.text).toMatch(/^✅ 에이전트 세션 완료/);
    expect(params.text).toContain("child-sess-1");
    expect(params.text).toContain("hello world from child");
    // callerInfo 신원 박힘 검증
    expect(params.callerInfo?.source).toBe("agent");
    expect(params.callerInfo?.agent_node).toBe(NODE_ID);
    expect(params.callerInfo?.agent_id).toBe("codex-default");
    expect(params.callerInfo?.agent_name).toBe("Codex Default");
    // onResume이 콜백으로 전달됨
    expect(resumeCb).toBe(onResume);

    // orch fetch 호출 0건
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("gate OFF는 ownership DB를 조회하지 않고 legacy local-first로 즉시 전달한다", async () => {
    const tm = makeTaskManagerStub();
    const getSession = vi.fn(async () => {
      throw new Error("gate-off path must not touch the DB");
    });
    const notifier = new TaskCompletionNotifier(
      NODE_ID,
      tm.taskManager,
      makeAgentRegistry(),
      vi.fn(),
      silentLogger,
      makeOrch(),
      vi.fn(),
      {
        getSession,
        getSupervisorRegistry: vi.fn(),
      } as never,
      false,
    );

    await notifier.notify(makeChild());

    expect(getSession).not.toHaveBeenCalled();
    expect(tm.addIntervention).toHaveBeenCalledTimes(1);
  });

  it("v2는 supervisor 조회보다 먼저 durable identity를 등록한 뒤 현재 target을 전달한다", async () => {
    const tm = makeTaskManagerStub();
    let stored: Record<string, unknown> | undefined;
    const calls: string[] = [];
    const repository = {
      register: vi.fn(async (params: Record<string, unknown>) => {
        calls.push("register");
        stored = {
          delivery_id: params.deliveryId,
          target_session_id: params.targetSessionId,
          source_session_id: params.sourceSessionId,
          relation_key: params.relationKey,
          completion_id: params.completionId,
          intent: params.intent,
          source: params.source,
          producer_kind: params.producerKind,
          producer_id: params.producerId,
          producer_terminal_revision: params.producerTerminalRevision,
          parent_delivery_id: null,
          caller_turn_id: null,
          supervisor_role: params.supervisorRole,
          payload_hash: params.payloadHash,
          payload: params.payload,
          state: "pending",
          created_at: params.createdAt,
          updated_at: params.createdAt,
          claimed_at: null,
          dispatching_at: null,
          queued_at: null,
          delivered_at: null,
          consumed_at: null,
        };
        return { row: stored, inserted: true, conflict: false };
      }),
      get: vi.fn(async () => stored),
      claimForCurrentSupervisor: vi.fn(async (
        _deliveryId: string,
        _supervisorRole: string,
        leaseOwner: string,
      ) => {
        calls.push("claim-current");
        stored = {
          ...stored,
          target_session_id: "supervisor-current",
          state: "claimed",
          lease_owner: leaseOwner,
        };
        return stored;
      }),
      claimForTarget: vi.fn(),
      claimRecoverableCompletionDeliveries: vi.fn().mockResolvedValue([]),
      deferPending: vi.fn(),
      retryLeasedDelivery: vi.fn(),
      releaseExpiredDeliveryLeases: vi.fn().mockResolvedValue(0),
    };
    const notifier = new TaskCompletionNotifier(
      NODE_ID,
      tm.taskManager,
      makeAgentRegistry(),
      vi.fn(),
      silentLogger,
      makeOrch(),
      vi.fn(),
      {
        getSession: vi.fn().mockResolvedValue({ node_id: NODE_ID }),
      } as never,
      true,
      repository as never,
    );

    await notifier.notify(makeChild({
      lastEventId: 42,
      callerSessionId: "supervisor-old",
      callerInfo: {
        source: "agent",
        agent_id: "ariella-ashwood-codex",
      },
      completionSupervisorRole: "ariella-ashwood-codex",
    }));
    const params = tm.addIntervention.mock.calls[0]![0] as AddInterventionParams;

    expect(params).toMatchObject({
      agentSessionId: "supervisor-current",
      deliveryIntent: "completion_notification",
      source: "completion_notifier",
      producerTerminalRevision: "42",
      relationKey: "child_session:child-sess-1:42",
      supervisorRole: "ariella-ashwood-codex",
    });
    expect(params.deliveryId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
    expect(params.completionId).toMatch(/^completion:/);
    expect(calls).toEqual(["register", "claim-current"]);
  });

  it("v2 일반 agent caller는 supervisor로 추측하지 않고 실제 caller에 1회 전달한다", async () => {
    const tm = makeTaskManagerStub();
    let stored: Record<string, unknown> | undefined;
    const repository = {
      register: vi.fn(async (params: Record<string, unknown>) => {
        stored = {
          delivery_id: params.deliveryId,
          target_session_id: params.targetSessionId,
          source_session_id: params.sourceSessionId,
          relation_key: params.relationKey,
          completion_id: params.completionId,
          intent: params.intent,
          source: params.source,
          producer_kind: params.producerKind,
          producer_id: params.producerId,
          producer_terminal_revision: params.producerTerminalRevision,
          parent_delivery_id: null,
          caller_turn_id: null,
          supervisor_role: params.supervisorRole,
          payload_hash: params.payloadHash,
          payload: params.payload,
          state: "pending",
          created_at: params.createdAt,
          updated_at: params.createdAt,
          claimed_at: null,
          dispatching_at: null,
          queued_at: null,
          delivered_at: null,
          consumed_at: null,
        };
        return { row: stored, inserted: true, conflict: false };
      }),
      get: vi.fn(async () => stored),
      claimForCurrentSupervisor: vi.fn(),
      claimForTarget: vi.fn(async (
        _deliveryId: string,
        targetSessionId: string,
        leaseOwner: string,
      ) => {
        stored = {
          ...stored,
          target_session_id: targetSessionId,
          state: "claimed",
          lease_owner: leaseOwner,
        };
        return stored;
      }),
      claimRecoverableCompletionDeliveries: vi.fn().mockResolvedValue([]),
      deferPending: vi.fn(),
      retryLeasedDelivery: vi.fn(),
      releaseExpiredDeliveryLeases: vi.fn().mockResolvedValue(0),
    };
    const notifier = new TaskCompletionNotifier(
      NODE_ID,
      tm.taskManager,
      makeAgentRegistry(),
      vi.fn(),
      silentLogger,
      makeOrch(),
      vi.fn(),
      {
        getSession: vi.fn().mockResolvedValue({ node_id: NODE_ID }),
      } as never,
      true,
      repository as never,
    );

    await notifier.notify(makeChild({
      lastEventId: 43,
      callerSessionId: "ordinary-agent-caller",
      callerInfo: {
        source: "agent",
        agent_id: "seosoyoung-opus",
      },
    }));

    expect(repository.claimForCurrentSupervisor).not.toHaveBeenCalled();
    expect(repository.claimForTarget).toHaveBeenCalledWith(
      expect.any(String),
      "ordinary-agent-caller",
      expect.any(String),
      expect.any(Number),
    );
    expect(tm.addIntervention).toHaveBeenCalledTimes(1);
    expect(tm.addIntervention.mock.calls[0]![0]).toMatchObject({
      agentSessionId: "ordinary-agent-caller",
      supervisorRole: undefined,
      deliveryIntent: "completion_notification",
    });
  });

  it("1c. notifyCompletion=false면 callerSessionId가 있어도 완료통지를 보내지 않는다", async () => {
    const tm = makeTaskManagerStub();
    const registry = makeAgentRegistry();
    const fetchImpl = vi.fn().mockResolvedValue(new Response("{}", { status: 200 }));
    const onResume = vi.fn();

    const notifier = new TaskCompletionNotifier(
      NODE_ID,
      tm.taskManager,
      registry,
      onResume,
      silentLogger,
      makeOrch(),
      fetchImpl,
    );

    await notifier.notify(makeChild({ notifyCompletion: false }));

    expect(tm.addIntervention).not.toHaveBeenCalled();
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("1b. gate OFF는 supervisor metadata가 있어도 기존 caller로 그대로 보낸다", async () => {
    const tm = makeTaskManagerStub();
    const registry = makeAgentRegistry();
    const fetchImpl = vi.fn().mockResolvedValue(new Response("{}", { status: 200 }));
    const onResume = vi.fn();

    const notifier = new TaskCompletionNotifier(
      NODE_ID,
      tm.taskManager,
      registry,
      onResume,
      silentLogger,
      makeOrch(),
      fetchImpl,
    );

    await notifier.notify(makeChild({
      callerSessionId: "supervisor-old",
      callerInfo: {
        source: "agent",
        agent_id: "ariella-ashwood-codex",
      },
    }));

    expect(tm.addIntervention).toHaveBeenCalledTimes(1);
    expect(tm.addIntervention.mock.calls[0]![0].agentSessionId).toBe("supervisor-old");
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("v2 target claim 실패는 durable pending을 남기고 같은 identity로 recovery한다", async () => {
    const tm = makeTaskManagerStub();
    let stored: Record<string, unknown> | undefined;
    const claimForCurrentSupervisor = vi.fn()
      .mockRejectedValueOnce(new Error("temporary registry failure"))
      .mockImplementation(async (
        _deliveryId: string,
        _supervisorRole: string,
        leaseOwner: string,
      ) => {
        stored = {
          ...stored,
          target_session_id: "supervisor-current",
          state: "claimed",
          lease_owner: leaseOwner,
        };
        return stored;
      });
    const repository = {
      register: vi.fn(async (params: Record<string, unknown>) => {
        stored = {
          delivery_id: params.deliveryId,
          target_session_id: params.targetSessionId,
          source_session_id: params.sourceSessionId,
          relation_key: params.relationKey,
          completion_id: params.completionId,
          intent: params.intent,
          source: params.source,
          producer_kind: params.producerKind,
          producer_id: params.producerId,
          producer_terminal_revision: params.producerTerminalRevision,
          parent_delivery_id: null,
          caller_turn_id: null,
          supervisor_role: params.supervisorRole,
          payload_hash: params.payloadHash,
          payload: params.payload,
          state: "pending",
          created_at: params.createdAt,
          updated_at: params.createdAt,
          claimed_at: null,
          dispatching_at: null,
          queued_at: null,
          delivered_at: null,
          consumed_at: null,
        };
        return { row: stored, inserted: true, conflict: false };
      }),
      get: vi.fn(async () => stored),
      claimForCurrentSupervisor,
      claimForTarget: vi.fn(),
      claimRecoverableCompletionDeliveries: vi.fn(async (leaseOwner: string) => {
        stored = {
          ...stored,
          target_session_id: "supervisor-current",
          state: "claimed",
          lease_owner: leaseOwner,
        };
        return [stored];
      }),
      deferPending: vi.fn(),
      retryLeasedDelivery: vi.fn(),
      releaseExpiredDeliveryLeases: vi.fn().mockResolvedValue(0),
    };
    const notifier = new TaskCompletionNotifier(
      NODE_ID,
      tm.taskManager,
      makeAgentRegistry(),
      vi.fn(),
      silentLogger,
      makeOrch(),
      vi.fn(),
      {
        getSession: vi.fn().mockResolvedValue({ node_id: NODE_ID }),
      } as never,
      true,
      repository as never,
    );

    await notifier.notify(makeChild({
      callerSessionId: "supervisor-old",
      callerInfo: {
        source: "agent",
        agent_id: "ariella-ashwood-codex",
      },
      completionSupervisorRole: "ariella-ashwood-codex",
    }));

    expect(tm.addIntervention).not.toHaveBeenCalled();
    const deliveryId = stored?.delivery_id;
    await notifier.recoverPending();
    expect(tm.addIntervention).toHaveBeenCalledTimes(1);
    expect(tm.addIntervention.mock.calls[0]![0].deliveryId).toBe(deliveryId);
  });

  it("2. orch fallback — local throw 시 /api/sessions/{caller}/intervene POST", async () => {
    const tm = makeTaskManagerStub(new Error("Task not found: parent-sess-1"));
    const registry = makeAgentRegistry();
    const fetchImpl = vi.fn().mockResolvedValue(new Response("{}", { status: 200 }));
    const onResume = vi.fn();

    const notifier = new TaskCompletionNotifier(
      NODE_ID,
      tm.taskManager,
      registry,
      onResume,
      silentLogger,
      makeOrch(),
      fetchImpl,
    );

    await notifier.notify(makeChild({
      callerInfo: {
        source: "browser",
        email: "owner@example.com",
      },
    }));

    // local 1회 시도 (throw)
    expect(tm.addIntervention).toHaveBeenCalledTimes(1);

    // orch fallback 1회
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = fetchImpl.mock.calls[0]!;
    expect(url).toBe("https://orch.example.com/api/sessions/parent-sess-1/intervene");
    expect((init as RequestInit).method).toBe("POST");
    const headers = (init as RequestInit).headers as Record<string, string>;
    expect(headers.authorization).toBe("Bearer test-token");
    expect(headers["content-type"]).toBe("application/json");

    // body: snake_case caller_info — orch Pydantic InterveneRequest 정합
    const body = JSON.parse((init as RequestInit).body as string);
    expect(body.text).toMatch(/^✅ 에이전트 세션 완료/);
    expect(body.user).toBe("agent");
    expect(body.caller_info).toBeDefined();
    expect(body.caller_info.source).toBe("agent");
    expect(body.caller_info.agent_node).toBe(NODE_ID);
    expect(body.caller_info.email).toBe("owner@example.com");
    // camelCase callerInfo 키는 *박히지 않는다*
    expect(body.callerInfo).toBeUndefined();
  });

  it("3. callerSessionId 없음 — no-op (addIntervention·fetch 0건)", async () => {
    const tm = makeTaskManagerStub();
    const registry = makeAgentRegistry();
    const fetchImpl = vi.fn();
    const onResume = vi.fn();

    const notifier = new TaskCompletionNotifier(
      NODE_ID,
      tm.taskManager,
      registry,
      onResume,
      silentLogger,
      makeOrch(),
      fetchImpl,
    );

    await notifier.notify(makeChild({ callerSessionId: undefined }));

    expect(tm.addIntervention).not.toHaveBeenCalled();
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("4b. interrupted 완료 — `⚠️ 에이전트 세션 중단` 메시지 형식 (code-reviewer P1)", async () => {
    // TS는 cancelTask가 task.status='interrupted'만 박고 task.error는 채우지 않는다
    // (task_manager.ts:240). Python lifecycle과 비대칭 — interrupted 분기 의무.
    const tm = makeTaskManagerStub();
    const notifier = new TaskCompletionNotifier(
      NODE_ID, tm.taskManager, makeAgentRegistry(), vi.fn(), silentLogger,
    );
    await notifier.notify(makeChild({
      status: "interrupted",
      error: undefined,
      lastAssistantText: "lingering partial response",  // 잔존해도 사용되지 않아야
    }));
    const params = tm.addIntervention.mock.calls[0]![0] as AddInterventionParams;
    expect(params.text).toMatch(/^⚠️ 에이전트 세션 중단/);
    expect(params.text).toContain("child-sess-1");
    // interrupted는 lastAssistantText를 의도적으로 노출하지 않는다 (사용자가 cancel한 결과를
    // "✅ 완료"로 잘못 인지하는 회로 차단)
    expect(params.text).not.toContain("lingering partial response");
    expect(params.text).not.toMatch(/^✅/);
    expect(params.text).not.toMatch(/^❌/);
  });

  it("4. 오류 완료 — `❌ 에이전트 세션 오류` 메시지 형식", async () => {
    const tm = makeTaskManagerStub();
    const registry = makeAgentRegistry();
    const fetchImpl = vi.fn();
    const onResume = vi.fn();

    const notifier = new TaskCompletionNotifier(
      NODE_ID,
      tm.taskManager,
      registry,
      onResume,
      silentLogger,
      undefined,
      fetchImpl,
    );

    const child = makeChild({
      status: "error",
      error: "engine crash",
      lastAssistantText: undefined,
    });
    await notifier.notify(child);

    expect(tm.addIntervention).toHaveBeenCalledTimes(1);
    const params = tm.addIntervention.mock.calls[0]![0] as AddInterventionParams;
    expect(params.text).toMatch(/^❌ 에이전트 세션 오류/);
    expect(params.text).toContain("child-sess-1");
    expect(params.text).toContain("engine crash");
  });

  it("5a. resultText 정본 — lastAssistantText가 본문에 포함", async () => {
    const tm = makeTaskManagerStub();
    const notifier = new TaskCompletionNotifier(
      NODE_ID, tm.taskManager, makeAgentRegistry(), vi.fn(), silentLogger,
    );
    await notifier.notify(makeChild({ lastAssistantText: "actual result text" }));
    const params = tm.addIntervention.mock.calls[0]![0] as AddInterventionParams;
    expect(params.text).toContain("actual result text");
    expect(params.text).not.toContain("(빈 응답)");
  });

  it("5b. resultText 정본 — lastAssistantText 부재 시 `(빈 응답)` fallback", async () => {
    const tm = makeTaskManagerStub();
    const notifier = new TaskCompletionNotifier(
      NODE_ID, tm.taskManager, makeAgentRegistry(), vi.fn(), silentLogger,
    );
    await notifier.notify(makeChild({ lastAssistantText: undefined }));
    const params = tm.addIntervention.mock.calls[0]![0] as AddInterventionParams;
    expect(params.text).toMatch(/^✅ 에이전트 세션 완료/);
    expect(params.text).toContain("(빈 응답)");
  });

  it("5c. resultText 정본 — error path에서 error 없으면 빈 본문 prefix만", async () => {
    const tm = makeTaskManagerStub();
    const notifier = new TaskCompletionNotifier(
      NODE_ID, tm.taskManager, makeAgentRegistry(), vi.fn(), silentLogger,
    );
    await notifier.notify(makeChild({
      status: "error",
      error: undefined,
      lastAssistantText: undefined,
    }));
    const params = tm.addIntervention.mock.calls[0]![0] as AddInterventionParams;
    expect(params.text).toMatch(/^❌ 에이전트 세션 오류/);
    // error 본문이 비어도 prefix는 박힘, "(빈 응답)" fallback은 *성공 경로 전용*이라 박히지 않는다
    expect(params.text).not.toContain("(빈 응답)");
  });

  it("6. 양쪽 실패 격리 — local throw + orch throw → notify() resolve, throw 0건", async () => {
    const tm = makeTaskManagerStub(new Error("Task not found"));
    const registry = makeAgentRegistry();
    const fetchImpl = vi.fn().mockRejectedValue(new Error("network down"));
    const onResume = vi.fn();

    const notifier = new TaskCompletionNotifier(
      NODE_ID,
      tm.taskManager,
      registry,
      onResume,
      silentLogger,
      makeOrch(),
      fetchImpl,
    );

    // notify가 reject되지 않고 resolve해야 한다
    await expect(notifier.notify(makeChild())).resolves.toBeUndefined();

    expect(tm.addIntervention).toHaveBeenCalledTimes(1);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("6b. orch 미주입 + local throw — notify() resolve (single-node 환경)", async () => {
    const tm = makeTaskManagerStub(new Error("Task not found"));
    const notifier = new TaskCompletionNotifier(
      NODE_ID,
      tm.taskManager,
      makeAgentRegistry(),
      vi.fn(),
      silentLogger,
      undefined,  // orch 미주입
    );
    await expect(notifier.notify(makeChild())).resolves.toBeUndefined();
    expect(tm.addIntervention).toHaveBeenCalledTimes(1);
  });

  it("6c. orch HTTP non-2xx 응답 → cross-node 실패로 격리 (throw 0건)", async () => {
    const tm = makeTaskManagerStub(new Error("Task not found"));
    const fetchImpl = vi.fn().mockResolvedValue(
      new Response("upstream error", { status: 503 }),
    );
    const notifier = new TaskCompletionNotifier(
      NODE_ID,
      tm.taskManager,
      makeAgentRegistry(),
      vi.fn(),
      silentLogger,
      makeOrch(),
      fetchImpl,
    );
    await expect(notifier.notify(makeChild())).resolves.toBeUndefined();
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
});

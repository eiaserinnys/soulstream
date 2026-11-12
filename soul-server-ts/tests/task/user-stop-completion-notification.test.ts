/**
 * card #1261 A — 사람이 멈춘 세션도 부른 세션에 알린다.
 *
 * 디렉터 결정(261112): "멈춤 버튼을 누르면 항상 상위 세션에 알림이 가게 하자."
 * 멈춤 통지는 충돌(⚠️)과 구분되는 첫 줄(`⏹️ 에이전트 세션을 사람이 멈춤`)을 쓰고
 * 마지막 답변을 덧붙인다. notifyCompletion=false는 예외 없이 등록하지 않는다.
 */
import pino from "pino";
import { describe, expect, it, vi } from "vitest";

import type { AgentRegistry } from "../../src/agent_registry.js";
import type { EnginePort } from "../../src/engine/protocol.js";
import { InProcessRunnerCommandDispatcher } from
  "../../src/runner/runner_command_dispatcher.js";
import { TaskCompletionNotifier } from "../../src/task/completion_notifier.js";
import { TaskLifecycleTransition } from
  "../../src/task/task_lifecycle_transition.js";
import type { Task } from "../../src/task/task_models.js";
import type { TaskManager } from "../../src/task/task_manager.js";

const silentLogger = pino({ level: "silent" });

function makeTask(overrides: Partial<Task> = {}): Task {
  return {
    agentSessionId: "child-sess-1",
    prompt: "hi",
    status: "running",
    callerSessionId: "parent-sess-1",
    createdAt: new Date("2026-11-12T01:00:00.000Z"),
    lastEventId: 7,
    lastReadEventId: 0,
    lastAssistantText: "작업 중 남긴 마지막 답변",
    interventionQueue: [],
    ...overrides,
  };
}

function makePersistence() {
  const enqueueTerminalTransitionAndWaitForApplication = vi.fn(async (
    _sessionId: string,
    _event: unknown,
    effect: {
      status: string;
      termination_reason: string;
      termination_detail: string | null;
      review_state: string;
      last_assistant_text?: string | null;
      updated_at: string;
    },
  ) => ({
    eventId: 8,
    applied: true,
    canonicalSession: {
      status: effect.status,
      termination_reason: effect.termination_reason,
      termination_detail: effect.termination_detail,
      review_state: effect.review_state,
      last_assistant_text: effect.last_assistant_text ?? null,
      termination_event_id: 8,
      updated_at: effect.updated_at,
      last_event_id: 8,
    },
  }));
  return { enqueueTerminalTransitionAndWaitForApplication };
}

function makeDeliveryRepository() {
  const register = vi.fn(async (params: Record<string, unknown>) => ({
    row: {
      delivery_id: params.deliveryId,
      target_session_id: params.targetSessionId,
      source_session_id: params.sourceSessionId,
      state: "pending",
    },
    inserted: true,
    conflict: false,
  }));
  const repository = {
    register,
    get: vi.fn(async () => undefined),
    claimAttemptForTarget: vi.fn(async () => undefined),
    claimRecoverableCompletionDeliveries: vi.fn().mockResolvedValue([]),
    deferPending: vi.fn(),
    retryDeliveryAttempt: vi.fn(),
    expireStaleDeliveryAttempts: vi.fn().mockResolvedValue(0),
  };
  return { repository, register };
}

function makeNotifier(
  repository: ReturnType<typeof makeDeliveryRepository>["repository"],
): TaskCompletionNotifier {
  const taskManager = {
    addIntervention: vi.fn(async () => ({ queued: true, queuePosition: 1 })),
  } as unknown as TaskManager;
  const agentRegistry = { get: vi.fn(() => undefined) } as unknown as AgentRegistry;
  return new TaskCompletionNotifier(
    "node-test",
    taskManager,
    agentRegistry,
    vi.fn(),
    silentLogger,
    undefined,
    vi.fn(),
    undefined,
    true,
    repository as never,
  );
}

function makeRunner(events: string[]) {
  const engine = {
    interrupt: vi.fn(async () => true),
    close: vi.fn(async () => {}),
  } as unknown as EnginePort;
  const dispatcher = new InProcessRunnerCommandDispatcher(engine);
  const close = dispatcher.close.bind(dispatcher);
  const closeSpy = vi.spyOn(dispatcher, "close").mockImplementation(async () => {
    events.push("close-runner");
    await close();
  });
  return {
    runner: { engine, dispatcher },
    closeSpy,
  };
}

describe("사람의 멈춤 완료 통지 (card #1261)", () => {
  it("멈춤은 부른 세션에 정확히 한 번, 러너를 닫기 전에 등록한다", async () => {
    const events: string[] = [];
    const persistence = makePersistence();
    const { repository, register } = makeDeliveryRepository();
    const { runner, closeSpy } = makeRunner(events);
    const notifier = makeNotifier(repository);
    register.mockImplementation(async (params: Record<string, unknown>) => {
      events.push("register-notification");
      return {
        row: {
          delivery_id: params.deliveryId,
          target_session_id: params.targetSessionId,
          source_session_id: params.sourceSessionId,
          state: "pending",
        },
        inserted: true,
        conflict: false,
      };
    });

    const transition = new TaskLifecycleTransition({
      logger: silentLogger,
      persistence: persistence as never,
      completionNotifier: notifier,
    });
    const task = makeTask();
    task.runner = runner;

    await expect(transition.cancelRunningTask(task)).resolves.toBe(true);

    expect(register).toHaveBeenCalledTimes(1);
    const params = register.mock.calls[0]![0] as Record<string, unknown>;
    expect(params.targetSessionId).toBe("parent-sess-1");
    expect(params.sourceSessionId).toBe("child-sess-1");
    expect(params.producerTerminalRevision).toBe("8");
    expect(String(params.relationKey)).toContain(":8");
    expect(events).toEqual(["register-notification", "close-runner"]);

    const payload = params.payload as Record<string, unknown>;
    expect(String(payload.text)).toMatch(/^⏹️ 에이전트 세션을 사람이 멈춤/);
    expect(String(payload.text)).toContain("작업 중 남긴 마지막 답변");
    expect(String(payload.text)).not.toMatch(/^⚠️/);
    expect(closeSpy).toHaveBeenCalled();
    expect(task.status).toBe("interrupted");
    expect(task.terminationDetail).toBe("user_stop");
  });

  it("notify_completion=false면 사람의 멈춤도 등록하지 않는다", async () => {
    const persistence = makePersistence();
    const { repository, register } = makeDeliveryRepository();
    const notifier = makeNotifier(repository);
    const transition = new TaskLifecycleTransition({
      logger: silentLogger,
      persistence: persistence as never,
      completionNotifier: notifier,
    });
    const task = makeTask({ notifyCompletion: false });
    const engine = {
      interrupt: vi.fn(async () => true),
      close: vi.fn(async () => {}),
    } as unknown as EnginePort;
    task.runner = {
      engine,
      dispatcher: new InProcessRunnerCommandDispatcher(engine),
    };

    await expect(transition.cancelRunningTask(task)).resolves.toBe(true);

    expect(register).not.toHaveBeenCalled();
    // Terminal 기록 자체는 여전히 적용된다.
    expect(persistence.enqueueTerminalTransitionAndWaitForApplication)
      .toHaveBeenCalledTimes(1);
  });

  it("멈춤 첫 줄은 충돌 통지(⚠️)와 다르고 마지막 답변이 없으면 빈 응답 표기를 쓴다", async () => {
    const persistence = makePersistence();
    const { repository, register } = makeDeliveryRepository();
    const notifier = makeNotifier(repository);
    const transition = new TaskLifecycleTransition({
      logger: silentLogger,
      persistence: persistence as never,
      completionNotifier: notifier,
    });
    const task = makeTask({ lastAssistantText: undefined });
    const engine = {
      interrupt: vi.fn(async () => true),
      close: vi.fn(async () => {}),
    } as unknown as EnginePort;
    task.runner = {
      engine,
      dispatcher: new InProcessRunnerCommandDispatcher(engine),
    };

    await expect(transition.cancelRunningTask(task)).resolves.toBe(true);

    const params = register.mock.calls[0]![0] as Record<string, unknown>;
    const text = String((params.payload as Record<string, unknown>).text);
    expect(text).toMatch(/^⏹️ 에이전트 세션을 사람이 멈춤/);
    expect(text).toContain("(빈 응답)");
    expect(text).not.toContain("⚠️ 에이전트 세션 중단");
  });
});

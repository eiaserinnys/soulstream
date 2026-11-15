import pino from "pino";
import { describe, expect, it, vi } from "vitest";

import type { AgentProfile } from "../../src/agent_registry.js";
import type { SessionDB } from "../../src/db/session_db.js";
import type { RunnerRegistration } from "../../src/runner/runner_process_registry.js";
import { AutoResumeTransition } from "../../src/task/task_auto_resume_transition.js";
import { TaskExecutor } from "../../src/task/task_executor.js";
import type { RunnerProcessRuntimeFactory } from "../../src/task/task_executor.js";
import type { Task } from "../../src/task/task_models.js";
import { centralSessionFactsOf } from "../../src/task/state/node_response_handling.js";
import type { NodeResponseFacts } from "../../src/task/state/node_response_machine.js";
import type { SessionBroadcaster } from "../../src/upstream/session_broadcaster.js";

import { makeEventPersistenceTestDouble } from "./event_persistence_test_double.js";

/**
 * 카드 #1400. 붙은 러너 잇기의 거절 처리는 보낼 때의 실행에만 반영된다.
 *
 * 거절 ACK를 받은 잇기가 중앙 세션 줄 읽기를 기다리는 사이, 이전 실행이 치명 오류로 끝나고
 * 자동 재개가 같은 Task에 새 실행을 시작한다. 늦게 깨어난 거절 처리가 새 실행을 오류로 덮거나
 * 새 실행의 등록으로 종료를 올리면 안 된다.
 */

const logger = pino({ level: "silent" });

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((resolvePromise) => { resolve = resolvePromise; });
  return { promise, resolve };
}

const agent = {
  id: "claude-roselin",
  name: "Roselin",
  backend: "claude",
  workspace_dir: "/tmp/claude-roselin",
} as AgentProfile;

function centralRow(overrides: Record<string, unknown> = {}) {
  return {
    session_id: "sess-card1400",
    node_id: "node-a",
    status: "interrupted",
    termination_reason: null,
    termination_detail: null,
    review_state: "not_required",
    last_assistant_text: null,
    termination_event_id: null,
    updated_at: "2026-11-15T00:00:00.000Z",
    last_event_id: 3,
    ...overrides,
  };
}

function appliedRunning(eventId: number) {
  return {
    eventId,
    applied: true,
    canonicalSession: {
      status: "running",
      termination_reason: null,
      termination_detail: null,
      review_state: "not_required",
      last_assistant_text: null,
      termination_event_id: null,
      updated_at: "2026-11-15T00:00:00.000Z",
      last_event_id: eventId,
    },
  };
}

function appliedFalse(eventId: number, rejectionReason: string) {
  return {
    eventId,
    applied: false,
    rejectionReason,
    canonicalSession: {
      status: "interrupted",
      termination_reason: null,
      termination_detail: null,
      review_state: "not_required",
      last_assistant_text: null,
      termination_event_id: null,
      updated_at: "2026-11-15T00:00:00.000Z",
      last_event_id: eventId,
    },
  };
}

/**
 * 잇기 거절로 멈춰 둔 실행(이전 실행)을 만들고, 새 실행을 띄울 러너 공장을 준비한다.
 * 이전 실행은 시동 복구 잇기가 다시 될 수 있는 거절을 받아 프레임 통로를 붙잡은 채 멈춘다.
 */
function setup() {
  const double = makeEventPersistenceTestDouble();
  const enqueueTerminal = vi.fn(async (..._args: unknown[]) => ({
    eventId: 9,
    applied: true,
    canonicalSession: {
      status: "error",
      termination_reason: "error_aborted",
      termination_detail: "x",
      review_state: "not_required",
      last_assistant_text: null,
      termination_event_id: 9,
      updated_at: "2026-11-15T00:00:00.000Z",
      last_event_id: 9,
    },
    canonicalExecutionRegistration: null,
  }));

  let adoptTransitions = 0;
  const enqueueRunningTransitionAndWaitForApplication = vi.fn(
    async (
      _sessionId: string,
      input: { transitionId: string },
    ) => {
      if (input.transitionId.startsWith("resume:")) return appliedRunning(8);
      adoptTransitions += 1;
      // 1번째는 시동 복구 잇기다. 다시 될 수 있는 거절로 실행을 멈춰 세운다.
      if (adoptTransitions === 1) return appliedFalse(5, "worktree_not_ready");
      // 2번째는 붙은 러너 잇기다. 이 거절 처리가 중앙 읽기에서 멈춘다.
      return appliedFalse(7, "worktree_busy");
    },
  );
  Object.assign(double.persistence, {
    enqueueRunningTransitionAndWaitForApplication,
    enqueueTerminalTransitionAndWaitForApplication: enqueueTerminal,
  });

  // 1번째 중앙 읽기는 시동 복구 잇기의 거절 처리다. 2번째(붙은 러너 잇기)는 붙잡아 둔다.
  const centralRead = deferred<unknown>();
  let centralReads = 0;
  const getSession = vi.fn(async () => {
    centralReads += 1;
    if (centralReads === 1) {
      return centralRow({ execution_registration_id: "registration-A" });
    }
    return await centralRead.promise;
  });

  const never = new Promise<never>(() => undefined);
  const parkedFrames = {
    [Symbol.asyncIterator]: () => ({ next: () => never }),
  };
  const parkedDispatcher = {
    dispatch: vi.fn(),
    recoverFrames: vi.fn(() => parkedFrames),
    registrationId: vi.fn(() => "registration-A"),
    hasActiveExecution: vi.fn(() => true),
    interrupt: vi.fn(async () => true),
    close: vi.fn(async () => undefined),
    detachHost: vi.fn(async () => undefined),
    releaseEventStreamRegistration: vi.fn(async () => undefined),
    releaseUnadoptedRecovery: vi.fn(async () => undefined),
    sendControlFrame: vi.fn(async () => true),
    requestContext: vi.fn(),
    waitForSessionAck: vi.fn(async () => 12),
    invoke: vi.fn(),
  };
  const newDispatcher = {
    dispatch: vi.fn(),
    prepareExecutionIdentity: vi.fn(async () => ({
      registrationId: "registration-B",
      executionCommandId: "execute-B",
      pid: 4242,
      startIdentity: "start-4242",
    })),
    prepareSession: vi.fn(() => never),
    registrationId: vi.fn(() => "registration-B"),
    hasActiveExecution: vi.fn(() => true),
    isClosed: vi.fn(() => false),
    interrupt: vi.fn(async () => true),
    close: vi.fn(async () => undefined),
    detachHost: vi.fn(async () => undefined),
    releaseEventStreamRegistration: vi.fn(async () => undefined),
  };
  const factory = ((_task: Task, _agent: AgentProfile) => ({
    engine: { backendId: "claude", workspaceDir: "/tmp/claude-roselin" } as never,
    dispatcher: newDispatcher as never,
    eventPersistence: "runner",
  })) as unknown as RunnerProcessRuntimeFactory;
  factory.recover = vi.fn(() => ({
    engine: { backendId: "claude", workspaceDir: "/tmp/claude-roselin" } as never,
    dispatcher: parkedDispatcher as never,
    eventPersistence: "runner",
  }));

  const executor = new TaskExecutor(
    () => { throw new Error("no engine in this test"); },
    { updateSession: vi.fn(), getSession } as unknown as SessionDB,
    double.persistence,
    {
      emitEventEnvelope: vi.fn(),
      emitSessionUpdated: vi.fn(),
    } as unknown as SessionBroadcaster,
    logger,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined, // 6~11
    factory, // 12
  );
  const task: Task = {
    agentSessionId: "sess-card1400",
    prompt: "hi",
    status: "initializing",
    createdAt: new Date("2026-11-15T00:00:00.000Z"),
    lastEventId: 3,
    lastReadEventId: 0,
    interventionQueue: [],
    callerSessionId: "parent-session",
    profileId: agent.id,
  };
  const registrationA = {
    config: { agent, sessionId: task.agentSessionId },
    lifecycle: {
      execution_command_id: "execute-old",
      execution_state: "running",
      terminal_error: null,
    },
  } as unknown as RunnerRegistration;
  return {
    executor,
    task,
    registrationA,
    persistence: double.persistence,
    centralRead,
    getSession,
    enqueueTerminal,
    enqueueRunningTransitionAndWaitForApplication,
  };
}

describe("card #1400 an adoption rejection settles only for the execution it was sent for", () => {
  it("leaves the auto-resumed new execution running and raises no terminal with its registration", async () => {
    const subject = setup();
    const { executor, task } = subject;

    // 1. 이전 실행이 시동 복구 잇기에서 다시 될 수 있는 거절을 받아 멈춰 선다.
    await expect(executor.recoverRegisteredRunner(
      task,
      subject.registrationA,
      "execute-old",
      "adopt",
    )).rejects.toThrow();
    expect(task.status).toBe("initializing");
    expect(task.runner).toBeDefined();

    // 2. 붙은 러너 잇기가 worktree_busy 거절 ACK를 받고, 중앙 읽기에서 멈춘다.
    const adoption = executor.adoptAttachedRunnerExecution(task, "execute-old");
    await vi.waitFor(() => expect(subject.getSession).toHaveBeenCalledTimes(2));

    // 3. 그 사이 이전 실행이 치명 오류로 끝난다.
    await expect(
      executor.terminateAfterFatalEngineError(task, "Persistent Claude Query is fatal"),
    ).resolves.toBe(true);
    expect(task.status).toBe("error");
    expect(task.terminationEventRecorded).toBe(true);
    expect(task.runner).toBeUndefined();

    // 4. 자동 재개가 같은 Task에 새 실행을 시작한다(실제 제품 메서드로).
    const autoResume = new AutoResumeTransition({
      logger,
      persistence: subject.persistence,
    });
    await autoResume.resume(
      task,
      { text: "continue", user: "u" },
      (resumed, activation) => executor.startNewExecution(resumed, agent, activation),
    );
    await vi.waitFor(() =>
      expect(task.executionRegistration?.registrationId).toBe("registration-B"));
    expect(task.executionPromise).toBeDefined();

    // 5. 늦게 중앙 행 읽기가 풀린다. 행은 새 실행의 등록을 싣는다.
    subject.centralRead.resolve(centralRow({
      execution_registration_id: "registration-B",
      execution_command_id: "execute-B",
    }));
    await expect(adoption).resolves.toMatchObject({ applied: false });

    // 6. 거절 처리는 보낼 때의 실행(이전 실행)에만 반영된다.
    expect(task.status).toBe("running");
    expect(task.terminationReason).toBeUndefined();
    expect(task.terminationEventRecorded).toBe(false);
    expect(task.executionRegistration).toEqual({
      registrationId: "registration-B",
      executionCommandId: "execute-B",
    });
    const terminalRegistrations = subject.enqueueTerminal.mock.calls
      .map((call) => call[3]);
    expect(terminalRegistrations).not.toContain("registration-B");
  });
});

describe("card #1400 centralSessionFactsOf compares the sent registration", () => {
  const facts = (): NodeResponseFacts => ({
    call: "attached_runner_adopt",
    route: "applied_false",
    reason: "worktree_busy",
    registration: "same",
    termination: "absent",
    centralSession: "unknown",
    retained: false,
  });

  it("marks the row's other registration as different from the sent one", () => {
    const next = centralSessionFactsOf(
      facts(),
      {
        status: "interrupted",
        termination_event_id: null,
        execution_registration_id: "registration-B",
      },
      "registration-A",
    );

    expect(next.registration).toBe("different");
  });

  it("changes nothing when the central row's registration column was emptied", () => {
    const next = centralSessionFactsOf(
      facts(),
      {
        status: "interrupted",
        termination_event_id: null,
        execution_registration_id: null,
      },
      "registration-A",
    );

    expect(next.registration).toBe("same");
  });

  it("does not turn a different registration back into same", () => {
    const next = centralSessionFactsOf(
      { ...facts(), registration: "different" },
      {
        status: "interrupted",
        termination_event_id: null,
        execution_registration_id: "registration-A",
      },
      "registration-A",
    );

    expect(next.registration).toBe("different");
  });
});

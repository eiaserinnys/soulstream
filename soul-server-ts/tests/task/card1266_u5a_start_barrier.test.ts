import pino from "pino";
import { describe, expect, it, vi } from "vitest";

import type { AgentProfile } from "../../src/agent_registry.js";
import type { SessionDB } from "../../src/db/session_db.js";
import { TaskExecutor } from "../../src/task/task_executor.js";
import type { Task, TaskRunnerRuntime } from "../../src/task/task_models.js";
import type { SessionBroadcaster } from "../../src/upstream/session_broadcaster.js";

import { makeEventPersistenceTestDouble } from "./event_persistence_test_double.js";

/**
 * 카드 #1266 U5a 바: 실행을 시작하는 모든 직접 길(새 위임, 도구 승인 재개, 도구 시작)은 슬롯을 잡기
 * 전에 시동 장벽(task.executionActivation)을 세운다. 장벽이 없으면 러너 스캔 판정이 뒤이은 턴의
 * 증거를 못 보고, 등록 거절이 경고 로그로만 남는다.
 */
const logger = pino({ level: "silent" });
const agent = {
  id: "claude-roselin",
  name: "Roselin",
  backend: "claude",
  workspace_dir: "/tmp/claude-roselin",
} as AgentProfile;

function makeTask(overrides: Partial<Task> = {}): Task {
  return {
    agentSessionId: "sess-u5a-barrier",
    prompt: "hi",
    status: "completed",
    terminationReason: "completed_ok",
    profileId: agent.id,
    createdAt: new Date("2026-11-14T01:00:00.000Z"),
    lastEventId: 7,
    lastReadEventId: 0,
    interventionQueue: [],
    ...overrides,
  };
}

function makeExecutor(options: {
  resolver?: { resolveExecutionWorkspace(id: string): Promise<string> };
  capabilityProfile?: "execution_registration" | "legacy_transition_only";
} = {}) {
  const double = makeEventPersistenceTestDouble(
    async () => undefined,
    [],
    { capabilityProfile: options.capabilityProfile ?? "execution_registration" },
  );
  const executor = new TaskExecutor(
    () => { throw new Error("no engine in this test"); },
    {
      updateSession: vi.fn().mockResolvedValue(undefined),
      setClaudeSessionId: vi.fn().mockResolvedValue(undefined),
    } as unknown as SessionDB,
    double.persistence,
    {
      emitEventEnvelope: vi.fn().mockResolvedValue(undefined),
      emitSessionUpdated: vi.fn().mockResolvedValue(undefined),
    } as unknown as SessionBroadcaster,
    logger,
    undefined, undefined, undefined, undefined, undefined, undefined, // 6~11
    undefined, // 12 runnerProcessFactory
    undefined, undefined, // 13~14
    options.resolver as never, // 15 worktreeResolver
  );
  return { executor, double };
}

describe("card #1266 U5a 바: the start barrier stands before the slot is held", () => {
  it("raises the barrier at once for a start that has to resolve its worktree first", () => {
    const resolver = { resolveExecutionWorkspace: vi.fn(() => new Promise<string>(() => undefined)) };
    const { executor } = makeExecutor({ resolver });
    const task = makeTask({ worktreeId: "wt-1" });

    void executor.startNewExecution(task, agent);

    expect(task.executionActivation).toBeDefined();
    expect(task.executionPromise).toBeDefined();
    expect(resolver.resolveExecutionWorkspace).toHaveBeenCalledWith("wt-1");
  });

  it("raises it right after a retained-runner release claim completes, before the worktree resolves", async () => {
    const resolver = { resolveExecutionWorkspace: vi.fn(() => new Promise<string>(() => undefined)) };
    const { executor } = makeExecutor({ resolver });
    const oldRunner = {
      engine: {} as never,
      dispatcher: { registrationId: () => "registration-old" } as never,
      eventPersistence: "runner",
    } as TaskRunnerRuntime;
    let release!: () => void;
    const completion = new Promise<void>((resolve) => { release = resolve; });
    const task = makeTask({
      worktreeId: "wt-1",
      runnerReleaseClaim: {
        runner: oldRunner,
        registrationId: "registration-old",
        completion,
        resolve: () => release(),
      },
    });

    void executor.startNewExecution(task, agent);
    await Promise.resolve();
    // 러너 해제 대기 중에는 아직 아무것도 시작하지 않는다(앞 단위의 동작).
    expect(task.executionActivation).toBeUndefined();

    task.runnerReleaseClaim = undefined;
    release();
    await vi.waitFor(() => expect(task.executionActivation).toBeDefined());
    expect(task.executionPromise).toBeDefined();
  });

  it("takes the barrier down and ends the task when the worktree cannot be resolved", async () => {
    const resolver = { resolveExecutionWorkspace: vi.fn(async () => { throw new Error("gone"); }) };
    const { executor } = makeExecutor({ resolver });
    const task = makeTask({ worktreeId: "wt-1" });

    await executor.startNewExecution(task, agent);

    expect(task.executionActivation).toBeUndefined();
    expect(task.status).toBe("error");
  });

  it("does not leave a barrier behind when the start throws before it begins", () => {
    const { executor } = makeExecutor();
    const task = makeTask({ worktreeId: "wt-1" });

    expect(() => executor.startNewExecution(task, agent)).toThrow(/WORKTREE_UNAVAILABLE/);

    expect(task.executionActivation).toBeUndefined();
  });

  it("never replaces a barrier that already stands; the overlapping start is refused", () => {
    const resolver = { resolveExecutionWorkspace: vi.fn(() => new Promise<string>(() => undefined)) };
    const { executor } = makeExecutor({ resolver });
    const standing = {
      promise: new Promise<void>(() => undefined),
      resolve: vi.fn(),
      reject: vi.fn(),
    } as never;
    const task = makeTask({ worktreeId: "wt-1", executionActivation: standing });

    expect(() => executor.startNewExecution(task, agent)).toThrow(/execution admission in flight/);

    expect(task.executionActivation).toBe(standing);
  });

  it("raises no barrier on a node that does not register executions", () => {
    const resolver = { resolveExecutionWorkspace: vi.fn(() => new Promise<string>(() => undefined)) };
    const { executor } = makeExecutor({ resolver, capabilityProfile: "legacy_transition_only" });
    const task = makeTask({ worktreeId: "wt-1" });

    void executor.startNewExecution(task, agent);

    expect(task.executionActivation).toBeUndefined();
    expect(task.executionPromise).toBeDefined();
  });
});

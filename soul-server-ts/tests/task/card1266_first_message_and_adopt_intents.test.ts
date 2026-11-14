import pino from "pino";
import { describe, expect, it, vi } from "vitest";

import type { AgentProfile } from "../../src/agent_registry.js";
import type { SessionDB } from "../../src/db/session_db.js";
import type { EnginePort, SSEEventPayload } from "../../src/engine/protocol.js";
import type { TaskRunnerRuntime } from "../../src/runner/task_runner_runtime.js";
import { TaskExecutor } from "../../src/task/task_executor.js";
import type { Task } from "../../src/task/task_models.js";
import type { SessionBroadcaster } from "../../src/upstream/session_broadcaster.js";
import {
  EventOutboxDeadLetterError,
  EventOutboxQuarantinedError,
} from "../../src/upstream/event_outbox_pump_protocol.js";

import { makeEventPersistenceTestDouble } from "./event_persistence_test_double.js";

/**
 * 카드 #1266 U2a 고침 B. 첫 메시지 호출과 잇기 호출(시동 복구 잇기, 붙은 러너 잇기)이
 * 응답 칸 결정 함수가 낸 정리 의도를 다 실행한다(docs/nodes/node-state.md 「호출과 칸마다
 * 기본 정리 의도」). 호출마다 영구 거절 한 칸과 다시 될 까닭이 없는 거절 한 칸을 본다.
 * 잇기의 러너 거둠과 중앙 세션 없음의 로컬 소유 정리는 응답 분류를 받은 러너 복구의 거둠이 한다.
 */

const agent: AgentProfile = {
  id: "codex-default",
  name: "Codex Default",
  backend: "codex",
  workspace_dir: "/tmp/codex-default",
};

function canonicalSession(status: string) {
  return {
    status,
    termination_reason: null,
    termination_detail: null,
    review_state: "not_required",
    last_assistant_text: null,
    termination_event_id: null,
    updated_at: "2026-11-13T00:00:00.000Z",
    last_event_id: 3,
  };
}

function makeExecutor(
  respond: () => Promise<unknown>,
  capabilityProfile: "legacy_transition_only" | "execution_registration",
) {
  const double = makeEventPersistenceTestDouble(undefined, [], { capabilityProfile });
  Object.assign(double.persistence, {
    enqueueRunningTransitionAndWaitForApplication: vi.fn(respond),
  });
  const execute = vi.fn(async function* (): AsyncIterable<SSEEventPayload> {});
  const engine = {
    backendId: "codex",
    workspaceDir: "/tmp/codex-default",
    execute,
    async interrupt() { return true; },
    async close() {},
  } as unknown as EnginePort;
  const executor = new TaskExecutor(
    () => engine,
    {
      updateSession: vi.fn(),
      setClaudeSessionId: vi.fn(),
      // 중앙 세션 한 줄이 있다.
      getSession: vi.fn(async () => ({ session_id: "sess-1" })),
    } as unknown as SessionDB,
    double.persistence,
    { emitEventEnvelope: vi.fn(), emitSessionUpdated: vi.fn() } as unknown as SessionBroadcaster,
    pino({ level: "silent" }),
  );
  const releaseLocalOwnership = vi.fn(async (_task: Task) => {});
  executor.setTerminationCleanupPorts({ releaseLocalOwnership });
  return { executor, double, execute, releaseLocalOwnership };
}

function terminalStatuses(double: ReturnType<typeof makeEventPersistenceTestDouble>): unknown[] {
  return double.enqueueTerminalTransitionAndWaitForApplication.mock.calls
    .map((call) => (call[2] as { status?: unknown } | undefined)?.status);
}

describe("card #1266 U2a first message runs every cleanup intent", () => {
  async function runFirstMessage(respond: () => Promise<unknown>) {
    const subject = makeExecutor(respond, "legacy_transition_only");
    const task: Task = {
      agentSessionId: "sess-1",
      prompt: "hi",
      status: "initializing",
      profileId: agent.id,
      createdAt: new Date("2026-11-13T00:00:00.000Z"),
      lastEventId: 0,
      lastReadEventId: 0,
      interventionQueue: [],
    };
    subject.executor.startNewExecution(task, agent);
    await task.executionPromise;
    return { ...subject, task };
  }

  it("abandons the attempt without overwriting the central state on a no-retry rejection", async () => {
    const subject = await runFirstMessage(async () => ({
      eventId: 4,
      applied: false,
      rejectionReason: "already_terminal",
      canonicalSession: canonicalSession("completed"),
    }));

    // 칸의 의도는 「이 시도를 그만둠」 하나다. 중앙 상태를 오류로 덮지 않는다.
    expect(subject.double.enqueueTerminalTransitionAndWaitForApplication).not.toHaveBeenCalled();
    expect(subject.execute).not.toHaveBeenCalled();
    expect(subject.task.runner).toBeUndefined();
    expect(subject.task.status).toBe("completed");
  });

  it("marks the central state as an error and releases local ownership on a permanent rejection without a central session", async () => {
    const subject = await runFirstMessage(async () => {
      throw new EventOutboxDeadLetterError(
        4, "SESSION_NOT_FOUND", "2026-11-13T00:00:01.000Z", "session sess-1 does not exist",
      );
    });

    expect(subject.releaseLocalOwnership).toHaveBeenCalledOnce();
    expect(terminalStatuses(subject.double)).toEqual(["error"]);
    expect(subject.execute).not.toHaveBeenCalled();
  });
});

describe("card #1266 U2a adoption runs every cleanup intent", () => {
  function adoptTask(): { task: Task; runner: TaskRunnerRuntime } {
    const runner = {
      engine: { backendId: "codex" } as unknown as EnginePort,
      dispatcher: {
        registrationId: () => "registration-1",
        recoverFrames: vi.fn(async function* () {}),
        hasActiveExecution: () => true,
        detachHost: vi.fn(async () => {}),
        releaseUnadoptedRecovery: vi.fn(async () => {}),
        close: vi.fn(async () => {}),
      } as never,
      eventPersistence: "runner",
    } as TaskRunnerRuntime;
    const task: Task = {
      agentSessionId: "sess-1",
      prompt: "hi",
      status: "running",
      profileId: agent.id,
      createdAt: new Date("2026-11-13T00:00:00.000Z"),
      lastEventId: 3,
      lastReadEventId: 0,
      interventionQueue: [],
    };
    return { task, runner };
  }

  async function startupAdopt(respond: () => Promise<unknown>) {
    const subject = makeExecutor(respond, "execution_registration");
    const { task, runner } = adoptTask();
    await expect(
      subject.executor.recoverRunnerExecution(task, agent, runner, "execute-1", "adopt"),
    ).rejects.toThrow();
    return { ...subject, task };
  }

  async function attachedAdopt(respond: () => Promise<unknown>) {
    const subject = makeExecutor(respond, "execution_registration");
    const { task, runner } = adoptTask();
    task.runner = runner;
    const answered = await subject.executor.adoptAttachedRunnerExecution(task, "execute-1");
    return { ...subject, task, answered };
  }

  const quarantined = async () => {
    throw new EventOutboxQuarantinedError(
      4, "INVALID_EVENT", "2026-11-13T00:00:01.000Z", "invalid event",
    );
  };
  const sessionMissing = async () => ({
    eventId: 4,
    applied: false,
    rejectionReason: "session_missing",
    canonicalSession: canonicalSession("running"),
    canonicalExecutionRegistration: null,
  });
  const ownerNodeChanged = async () => ({
    eventId: 4,
    applied: false,
    rejectionReason: "owner_node_changed",
    canonicalSession: canonicalSession("running"),
    canonicalExecutionRegistration: null,
  });

  it("startup adoption marks the central state as an error on a permanent rejection", async () => {
    const subject = await startupAdopt(quarantined);

    expect(terminalStatuses(subject.double)).toEqual(["error"]);
    expect(subject.releaseLocalOwnership).not.toHaveBeenCalled();
  });

  // 잇기의 다시 될 까닭이 없는 거절은 러너 거둠을 응답 분류로 러너 복구에 넘긴다. 중앙 세션이
  // 없을 때의 로컬 소유 정리도 그 거둠이 한다. 여기서 러너를 떼고 task를 잊으면 중앙 확인이
  // 세션을 보지 못해 러너 프로세스를 거두지 못한다.
  it("startup adoption leaves a no-retry rejection without a central session to the reap", async () => {
    const subject = makeExecutor(sessionMissing, "execution_registration");
    const { task, runner } = adoptTask();
    await expect(subject.executor.recoverRunnerExecution(
      task, agent, runner, "execute-1", "adopt",
    )).rejects.toMatchObject({ response: "terminal_rejection" });

    expect(subject.releaseLocalOwnership).not.toHaveBeenCalled();
    expect(task.runner).toBe(runner);
    expect(subject.double.enqueueTerminalTransitionAndWaitForApplication).not.toHaveBeenCalled();
  });

  it("attached adoption marks the central state as an error on a permanent rejection", async () => {
    const subject = await attachedAdopt(quarantined);

    expect(subject.answered).toMatchObject({ applied: false, response: "terminal_rejection" });
    expect(terminalStatuses(subject.double)).toEqual(["error"]);
    expect(subject.releaseLocalOwnership).not.toHaveBeenCalled();
  });

  it("attached adoption leaves a no-retry rejection without a central session to the reap", async () => {
    const subject = await attachedAdopt(sessionMissing);

    expect(subject.answered).toMatchObject({ applied: false, rejectionReason: "session_missing" });
    expect(subject.releaseLocalOwnership).not.toHaveBeenCalled();
    expect(subject.task.runner).toBeDefined();
    expect(subject.double.enqueueTerminalTransitionAndWaitForApplication).not.toHaveBeenCalled();
  });

  it("does not raise an error terminal for a permanent adoption rejection when the central session is gone", async () => {
    const subject = await attachedAdopt(async () => {
      throw new EventOutboxDeadLetterError(
        4, "SESSION_NOT_FOUND", "2026-11-13T00:00:01.000Z", "session sess-1 does not exist",
      );
    });

    expect(subject.answered).toMatchObject({ applied: false, response: "terminal_rejection" });
    expect(subject.double.enqueueTerminalTransitionAndWaitForApplication).not.toHaveBeenCalled();
    expect(subject.releaseLocalOwnership).not.toHaveBeenCalled();
  });

  it("does not overwrite the central state when the session moved to another owner node (R5)", async () => {
    const startup = await startupAdopt(ownerNodeChanged);
    const attached = await attachedAdopt(ownerNodeChanged);

    expect(startup.double.enqueueTerminalTransitionAndWaitForApplication).not.toHaveBeenCalled();
    expect(attached.double.enqueueTerminalTransitionAndWaitForApplication).not.toHaveBeenCalled();
    expect(startup.releaseLocalOwnership).not.toHaveBeenCalled();
    expect(attached.releaseLocalOwnership).not.toHaveBeenCalled();
  });
});

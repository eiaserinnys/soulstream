import pino from "pino";
import { describe, expect, it, vi } from "vitest";

import type { AgentProfile } from "../../src/agent_registry.js";
import type { SessionDB } from "../../src/db/session_db.js";
import type { EnginePort, SSEEventPayload } from "../../src/engine/protocol.js";
import type { TaskRunnerRuntime } from "../../src/runner/task_runner_runtime.js";
import {
  TaskExecutor,
  type RunnerProcessRuntimeFactory,
} from "../../src/task/task_executor.js";
import type { Task } from "../../src/task/task_models.js";
import type { SessionBroadcaster } from "../../src/upstream/session_broadcaster.js";
import {
  EventOutboxDeadLetterError,
  EventOutboxQuarantinedError,
} from "../../src/upstream/event_outbox_pump_protocol.js";

import { makeEventPersistenceTestDouble } from "./event_persistence_test_double.js";

const silentLogger = pino({ level: "silent" });

const agent: AgentProfile = {
  id: "codex-default",
  name: "Codex Default",
  backend: "codex",
  workspace_dir: "/tmp/codex-default",
};

const PROOF = {
  registrationId: "registration-new",
  pid: 4321,
  startIdentity: "start-new",
  executionCommandId: "execute-new",
};

function fakeEngine(): EnginePort {
  return {
    backendId: "codex",
    workspaceDir: "/tmp/codex-default",
    async *execute(): AsyncIterable<SSEEventPayload> {},
    async interrupt() { return true; },
    async close() {},
  };
}

function makeTask(): Task {
  return {
    agentSessionId: "sess-1",
    prompt: "hi",
    status: "initializing",
    profileId: agent.id,
    createdAt: new Date(),
    lastEventId: 0,
    lastReadEventId: 0,
    interventionQueue: [],
  };
}

function canonicalSession(status = "running") {
  return {
    status,
    termination_reason: null,
    termination_detail: null,
    review_state: "not_required",
    last_assistant_text: null,
    termination_event_id: null,
    updated_at: "2026-11-13T00:00:00.000Z",
    last_event_id: 10,
  };
}

function makeSubject(
  acquire: () => Promise<unknown>,
) {
  const double = makeEventPersistenceTestDouble();
  Object.assign(double.persistence, {
    recordExecutionRegistrationAndWaitForApplication: vi.fn(acquire),
  });
  const dispatcher = {
    dispatch: vi.fn(),
    executeFrames: vi.fn(async function* () {}),
    recoverFrames: vi.fn(async function* () {}),
    registrationId: vi.fn(() => PROOF.registrationId),
    prepareExecutionIdentity: vi.fn(async () => PROOF),
    rollbackExecutionIdentity: vi.fn(async () => {}),
    prepareSession: vi.fn(async () => {}),
    interrupt: vi.fn(async () => true),
    close: vi.fn(async () => {}),
    detachHost: vi.fn(async () => {}),
    releaseEventStreamRegistration: vi.fn(async () => {}),
    sendControlFrame: vi.fn(async () => true),
    waitForSessionAck: vi.fn(async () => 12),
  };
  const runner = {
    engine: fakeEngine(),
    dispatcher: dispatcher as never,
    eventPersistence: "runner",
  } as TaskRunnerRuntime;
  const executor = new TaskExecutor(
    () => fakeEngine(),
    { updateSession: vi.fn(), setClaudeSessionId: vi.fn(), getSession: vi.fn() } as unknown as SessionDB,
    double.persistence,
    { emitEventEnvelope: vi.fn(), emitSessionUpdated: vi.fn() } as unknown as SessionBroadcaster,
    silentLogger,
    undefined, undefined, undefined, undefined, undefined, undefined,
    vi.fn(() => runner) as unknown as RunnerProcessRuntimeFactory,
  );
  return { executor, double, dispatcher };
}

async function start(subject: ReturnType<typeof makeSubject>) {
  const task = makeTask();
  const execution = subject.executor.startNewExecution(task, agent);
  const activation = task.executionActivation!.promise;
  await execution;
  await expect(activation).rejects.toThrow();
  return task;
}

describe("card #1266 U2a registration rejection", () => {
  it("does not overwrite the new run's central state when the registration is stale", async () => {
    const subject = makeSubject(async () => ({
      eventId: 11,
      applied: false,
      canonicalSession: canonicalSession(),
      canonicalExecutionRegistration: {
        registrationId: "registration-other",
        executionCommandId: "execute-other",
      },
    }));
    const task = await start(subject);

    expect(subject.double.enqueueTerminalTransitionAndWaitForApplication).not.toHaveBeenCalled();
    expect(task.runner).toBeUndefined();
    expect(subject.dispatcher.executeFrames).not.toHaveBeenCalled();
  });

  it("does not overwrite the central state when the session moved to another owner node", async () => {
    const subject = makeSubject(async () => ({
      eventId: 11,
      applied: false,
      rejectionReason: "owner_node_changed",
      canonicalSession: canonicalSession(),
      canonicalExecutionRegistration: null,
    }));
    await start(subject);

    expect(subject.double.enqueueTerminalTransitionAndWaitForApplication).not.toHaveBeenCalled();
  });

  it("does not overwrite the central state of a dead-lettered stale registration", async () => {
    const subject = makeSubject(async () => {
      throw new EventOutboxDeadLetterError(
        9, "STALE_REGISTRATION", "2026-11-13T00:00:01.000Z", "stale registration",
      );
    });
    await start(subject);

    expect(subject.double.enqueueTerminalTransitionAndWaitForApplication).not.toHaveBeenCalled();
  });

  it("still marks the central state as an error when the rejected registration is ours", async () => {
    const subject = makeSubject(async () => {
      throw new EventOutboxQuarantinedError(
        9, "INVALID_EVENT", "2026-11-13T00:00:01.000Z", "invalid event",
      );
    });
    const task = await start(subject);

    expect(subject.double.enqueueTerminalTransitionAndWaitForApplication).toHaveBeenCalledOnce();
    expect(task.status).toBe("error");
  });

  it.each([
    {
      name: "a stale registration",
      canonicalExecutionRegistration: {
        registrationId: "registration-other",
        executionCommandId: "execute-other",
      },
      rejectionReason: undefined,
    },
    {
      name: "a moved owner node",
      canonicalExecutionRegistration: null,
      rejectionReason: "owner_node_changed",
    },
  ])("forgets the created task that $name left running with nothing behind it", async ({
    canonicalExecutionRegistration,
    rejectionReason,
  }) => {
    const subject = makeSubject(async () => ({
      eventId: 11,
      applied: false,
      ...(rejectionReason ? { rejectionReason } : {}),
      canonicalSession: canonicalSession("running"),
      canonicalExecutionRegistration,
    }));
    const forgetTask = vi.fn();
    subject.executor.setTerminationCleanupPorts({ forgetTask });
    // 생성 길은 activation 없이 실행을 시작한다(upstream/task_runtime_commands.ts).
    const task = await start(subject);

    // 접힌 시도가 task를 running으로 남기면 이 노드가 돌리지 않는 세션을 실행 중으로
    // 알린다. 중앙 상태는 덮지 않고 로컬 소유만 정리한다(R5).
    expect(forgetTask).toHaveBeenCalledWith(
      expect.objectContaining({ agentSessionId: "sess-1" }),
    );
    expect(task.runner).toBeUndefined();
    expect(subject.double.enqueueTerminalTransitionAndWaitForApplication).not.toHaveBeenCalled();
  });

  it("keeps a reasonless rejection on the old fail-the-attempt path", async () => {
    const subject = makeSubject(async () => ({
      eventId: 11,
      applied: false,
      canonicalSession: canonicalSession(),
      canonicalExecutionRegistration: null,
    }));
    const task = await start(subject);

    expect(subject.double.enqueueTerminalTransitionAndWaitForApplication).toHaveBeenCalledOnce();
    expect(task.status).toBe("error");
    expect(subject.dispatcher.rollbackExecutionIdentity).toHaveBeenCalledWith(PROOF);
  });
});

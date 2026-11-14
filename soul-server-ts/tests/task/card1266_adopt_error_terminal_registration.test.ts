import pino from "pino";
import { describe, expect, it, vi } from "vitest";

import type { SessionDB } from "../../src/db/session_db.js";
import type { EnginePort } from "../../src/engine/protocol.js";
import { TaskExecutor } from "../../src/task/task_executor.js";
import type { Task } from "../../src/task/task_models.js";
import { EventOutboxDeadLetterError } from "../../src/upstream/event_outbox_pump_protocol.js";
import type { SessionBroadcaster } from "../../src/upstream/session_broadcaster.js";

import { makeEventPersistenceTestDouble } from "./event_persistence_test_double.js";

/**
 * 카드 #1266 U2b 8-다. 시동 복구 잇기가 영구 거절되어 task를 오류 종료로 올릴 때, 수화된 실행 등록이
 * 없어도(executionRegistration 없음) 거절된 그 러너 등록으로 종료를 지켜야 한다. 등록 없이 올라간
 * 종료는 낡은 등록의 오류가 새 실행의 중앙 상태를 덮는 길이 된다(R5).
 */
function setup(options: { executionRegistration?: Task["executionRegistration"]; runnerRegistrationId?: string | null } = {}) {
  const double = makeEventPersistenceTestDouble();
  const enqueueTerminal = vi.fn(async () => ({
    eventId: 9,
    applied: true,
    canonicalSession: {
      status: "error", termination_reason: "error_aborted", termination_detail: "x",
      review_state: "not_required", last_assistant_text: null,
      termination_event_id: 9, updated_at: "2026-11-14T00:00:00.000Z", last_event_id: 9,
    },
    canonicalExecutionRegistration: null,
  }));
  Object.assign(double.persistence, {
    enqueueRunningTransitionAndWaitForApplication: vi.fn(async () => {
      throw new EventOutboxDeadLetterError(4, "REPEATED_FAILURE", "2026-11-14T00:00:01.000Z", "repeated failure");
    }),
    enqueueTerminalTransitionAndWaitForApplication: enqueueTerminal,
  });
  const engine = {
    backendId: "codex", workspaceDir: "/tmp/a", async *execute() {},
    async interrupt() { return true; }, async close() {},
  } as unknown as EnginePort;
  const executor = new TaskExecutor(
    () => engine,
    { updateSession: vi.fn(), getSession: vi.fn() } as unknown as SessionDB,
    double.persistence,
    { emitEventEnvelope: vi.fn(), emitSessionUpdated: vi.fn() } as unknown as SessionBroadcaster,
    pino({ level: "silent" }),
  );
  const runnerRegistrationId = options.runnerRegistrationId === undefined ? "registration-adopt" : options.runnerRegistrationId;
  const task: Task = {
    agentSessionId: "sess-1",
    prompt: "hi",
    status: "running",
    createdAt: new Date("2026-11-14T00:00:00.000Z"),
    lastEventId: 3,
    lastReadEventId: 0,
    interventionQueue: [],
    ...(options.executionRegistration ? { executionRegistration: options.executionRegistration } : {}),
    runner: {
      engine,
      dispatcher: { registrationId: () => runnerRegistrationId } as never,
      eventPersistence: "runner",
    },
  };
  return { executor, task, enqueueTerminal };
}

describe("card #1266 U2b the error terminal of a rejected adoption keeps R5", () => {
  it("guards the terminal with the rejected runner registration when no execution registration was hydrated", async () => {
    const subject = setup();

    await subject.executor.adoptAttachedRunnerExecution(subject.task, "execute-1");

    expect(subject.enqueueTerminal).toHaveBeenCalledOnce();
    expect(subject.enqueueTerminal.mock.calls[0]?.[3]).toBe("registration-adopt");
  });

  it("keeps the hydrated execution registration when there is one", async () => {
    const subject = setup({ executionRegistration: { registrationId: "registration-hydrated", executionCommandId: "execute-1" } });

    await subject.executor.adoptAttachedRunnerExecution(subject.task, "execute-1");

    expect(subject.enqueueTerminal.mock.calls[0]?.[3]).toBe("registration-hydrated");
  });

  it("sends no registration when neither the task nor the runner has one", async () => {
    const subject = setup({ runnerRegistrationId: null });

    await subject.executor.adoptAttachedRunnerExecution(subject.task, "execute-1");

    expect(subject.enqueueTerminal.mock.calls[0]).toHaveLength(3);
  });
});

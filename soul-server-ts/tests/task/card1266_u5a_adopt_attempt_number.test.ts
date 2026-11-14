import pino from "pino";
import { describe, expect, it, vi } from "vitest";

import type { SessionDB } from "../../src/db/session_db.js";
import type { EnginePort } from "../../src/engine/protocol.js";
import type { SessionBroadcaster } from "../../src/upstream/session_broadcaster.js";
import { TaskExecutor } from "../../src/task/task_executor.js";
import type { Task } from "../../src/task/task_models.js";

import { makeEventPersistenceTestDouble } from "./event_persistence_test_double.js";

/**
 * 카드 #1266 U5a 마(설계 정본 card1218 design.md N8): 주기 중앙 확인이 다시 보내는 잇기는 판정마다
 * 새 시도 번호를 단다. 같은 번호를 다시 보내면 서버에 저장된 앞 거절이 그대로 재생된다.
 */
function makeSubject(rejection: Record<string, unknown> = {}) {
  const double = makeEventPersistenceTestDouble();
  Object.assign(double.persistence, {
    enqueueRunningTransitionAndWaitForApplication: vi.fn(async () => ({
      eventId: 5,
      applied: false,
      rejectionReason: "worktree_not_ready",
      ...rejection,
      canonicalSession: {
        status: "completed",
        termination_reason: null,
        termination_detail: null,
        review_state: "not_required",
        last_assistant_text: null,
        termination_event_id: null,
        updated_at: "2026-11-14T00:00:00.000Z",
        last_event_id: 3,
      },
    })),
  });
  const engine = {
    backendId: "codex",
    workspaceDir: "/tmp/a",
    async *execute() {},
    async interrupt() { return true; },
    async close() {},
  } as unknown as EnginePort;
  const executor = new TaskExecutor(
    () => engine,
    { updateSession: vi.fn(), getSession: vi.fn() } as unknown as SessionDB,
    double.persistence,
    { emitEventEnvelope: vi.fn(), emitSessionUpdated: vi.fn() } as unknown as SessionBroadcaster,
    pino({ level: "silent" }),
  );
  const task: Task = {
    agentSessionId: "sess-u5a-adopt",
    prompt: "hi",
    status: "running",
    createdAt: new Date(),
    lastEventId: 3,
    lastReadEventId: 0,
    interventionQueue: [],
    runner: {
      engine,
      dispatcher: { registrationId: () => "registration-1" } as never,
      eventPersistence: "runner",
    },
  };
  return { executor, task, double };
}

describe("card #1266 U5a 마: every re-adoption judgment carries a new attempt number", () => {
  it("sends a different transition id each time the same attached runner is adopted again", async () => {
    const subject = makeSubject();
    const send = subject.double.persistence
      .enqueueRunningTransitionAndWaitForApplication as unknown as ReturnType<typeof vi.fn>;

    await subject.executor.adoptAttachedRunnerExecution(subject.task, "execute-1");
    await subject.executor.adoptAttachedRunnerExecution(subject.task, "execute-1");

    expect(send).toHaveBeenCalledTimes(2);
    const ids = send.mock.calls.map((call) => (call[1] as { transitionId: string }).transitionId);
    expect(ids[0]).toMatch(/^adopt:execute-1:/);
    expect(ids[1]).toMatch(/^adopt:execute-1:/);
    expect(ids[0]).not.toBe(ids[1]);
    expect(send.mock.calls[0]![1]).toMatchObject({ registrationId: "registration-1" });
  });

  it("marks the rejection of another registration's transition so recovery does not repeat it", async () => {
    const subject = makeSubject({
      rejectionReason: "already_terminal",
      canonicalExecutionRegistration: {
        registrationId: "registration-other",
        executionCommandId: "execute-other",
      },
    });

    const answered = await subject.executor.adoptAttachedRunnerExecution(subject.task, "execute-1");

    expect(answered).toMatchObject({
      applied: false,
      rejectionReason: "already_terminal",
      response: "retryable_rejection",
      staleRegistration: true,
    });
  });

  it("does not mark a rejection that this runner's own registration can outlast", async () => {
    const subject = makeSubject();

    const answered = await subject.executor.adoptAttachedRunnerExecution(subject.task, "execute-1");

    expect(answered).toMatchObject({ applied: false, rejectionReason: "worktree_not_ready" });
    expect(answered).not.toHaveProperty("staleRegistration");
  });
});

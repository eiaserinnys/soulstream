import pino from "pino";
import { describe, expect, it, vi } from "vitest";

import { TaskManager } from "../../src/task/task_manager.js";
import type { Task } from "../../src/task/task_models.js";

import { makeEventPersistenceTestDouble } from "./event_persistence_test_double.js";

/**
 * 카드 #1266 U2a. 매니저 쪽 종료 호출(멈춤, 삭제, 외부 완료, 러너 복구의 닫힌 기록)도
 * 실행기 쪽과 같은 판정을 탄다: 거절되면 중앙 세션 없음을 확인해 로컬 소유를 정리하고,
 * 거절된 종료의 등록 은퇴 포트를 부른다.
 */

function makeTask(): Task {
  return {
    agentSessionId: "sess-1",
    prompt: "hi",
    status: "running",
    createdAt: new Date("2026-11-13T00:00:00.000Z"),
    executionRegistration: {
      registrationId: "registration-1",
      executionCommandId: "execute-1",
    },
    lastEventId: 7,
    lastReadEventId: 0,
    interventionQueue: [],
  };
}

const runningCanonical = {
  status: "running",
  termination_reason: null,
  termination_detail: null,
  review_state: "not_required",
  last_assistant_text: null,
  termination_event_id: null,
  updated_at: "2026-11-13T01:00:00.000Z",
  last_event_id: 7,
};

function makeSubject(getSession: () => Promise<unknown>) {
  const persistence = makeEventPersistenceTestDouble(undefined, [], {
    capabilityProfile: "legacy_transition_only",
  });
  persistence.enqueueTerminalTransitionAndWaitForApplication.mockResolvedValue({
    eventId: 8,
    applied: false,
    canonicalSession: runningCanonical,
    canonicalExecutionRegistration: null,
  } as never);
  const db = { getSession: vi.fn(getSession) };
  const manager = new TaskManager(
    "node-a",
    db as never,
    {} as never,
    pino({ level: "silent" }),
    persistence.persistence,
  );
  const task = makeTask();
  (manager as unknown as { tasks: Map<string, Task> }).tasks.set(task.agentSessionId, task);
  return { manager, db, task, persistence };
}

describe("card #1266 U2a manager-side terminal rejection", () => {
  it("confirms the central session and releases local ownership when it is gone", async () => {
    const subject = makeSubject(async () => null);

    await subject.manager.projectClosedRunner(subject.task, "runner closed");

    expect(subject.db.getSession).toHaveBeenCalledWith("sess-1");
    expect(subject.manager.getTask("sess-1")).toBeUndefined();
    expect(subject.task.executionRegistration).toBeUndefined();
  });

  it("keeps the task when the central session still exists", async () => {
    const subject = makeSubject(async () => ({ id: "sess-1" }));

    await subject.manager.projectClosedRunner(subject.task, "runner closed");

    expect(subject.db.getSession).toHaveBeenCalledWith("sess-1");
    expect(subject.manager.getTask("sess-1")).toBe(subject.task);
  });

  it("retires the registration of a terminal rejected for good through the wired port", async () => {
    const subject = makeSubject(async () => ({ id: "sess-1" }));
    const retire = vi.fn(async () => {});
    subject.manager.setTerminationCleanupPorts({ retireRejectedRegistration: retire });
    subject.persistence.enqueueTerminalTransitionAndWaitForApplication.mockResolvedValue({
      eventId: 8,
      applied: false,
      canonicalSession: { ...runningCanonical, status: "interrupted" },
      canonicalExecutionRegistration: null,
    } as never);

    await subject.manager.projectClosedRunner(subject.task, "runner closed");

    expect(retire).toHaveBeenCalledWith(subject.task, "registration-1");
  });
});

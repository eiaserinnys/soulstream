import pino from "pino";
import { describe, expect, it, vi } from "vitest";

import { AutoResumeTransition } from "../../src/task/task_auto_resume_transition.js";
import { TaskLifecycleTransition } from "../../src/task/task_lifecycle_transition.js";
import { NodeResponseRejectedError } from "../../src/task/state/node_response_handling.js";
import type { Task } from "../../src/task/task_models.js";

import { makeEventPersistenceTestDouble } from "./event_persistence_test_double.js";

/**
 * 카드 #1266 U2a. 재개 호출과 재개 보정 종료 호출도 응답 칸 결정 함수가 낸 정리 의도
 * (로컬 소유 정리, 미결 닫기)를 실행하고, 중앙 상태는 오류로 덮지 않는다.
 */

const silentLogger = pino({ level: "silent" });

function makeTask(overrides: Partial<Task> = {}): Task {
  return {
    agentSessionId: "s1",
    prompt: "original prompt",
    status: "completed",
    profileId: "codex-default",
    createdAt: new Date("2026-05-23T01:00:00.000Z"),
    completedAt: new Date("2026-05-23T01:05:00.000Z"),
    lastEventId: 7,
    terminalEventId: 6,
    lastReadEventId: 3,
    terminationReason: "completed_ok",
    terminationEventRecorded: true,
    interventionQueue: [],
    metadata: [],
    ...overrides,
  };
}

const canonicalSession = (status: string) => ({
  status,
  termination_reason: status === "completed" ? "completed_ok" : null,
  termination_detail: null,
  review_state: "not_required",
  last_assistant_text: null,
  termination_event_id: status === "completed" ? 6 : null,
  updated_at: "2026-08-11T00:00:00.000Z",
  last_event_id: 9,
});

function makeSubject(readCentralSession?: () => Promise<unknown>) {
  const forgetTask = vi.fn();
  const closePending = vi.fn(async () => {});
  const lifecycle = new TaskLifecycleTransition({
    logger: silentLogger,
    forgetTask,
    closeSettlementPending: closePending,
    ...(readCentralSession ? { readCentralSession } : {}),
  } as never);
  const persistence = makeEventPersistenceTestDouble(undefined, [], {
    capabilityProfile: "legacy_transition_only",
  });
  const settle = vi.fn(async (task: Task, verdict) =>
    await lifecycle.settleRejection(task, verdict, null));
  const transition = new AutoResumeTransition({
    logger: silentLogger,
    persistence: persistence.persistence,
    settleRejection: settle,
  });
  return { transition, persistence, forgetTask, closePending, settle };
}

describe("card #1266 U2a resume rejection", () => {
  it("releases local ownership and carries the verdict when the server reports the session missing", async () => {
    const subject = makeSubject();
    subject.persistence.enqueueRunningTransitionAndWaitForApplication.mockResolvedValueOnce({
      eventId: 9,
      applied: false,
      rejectionReason: "session_missing",
      canonicalSession: canonicalSession("completed"),
    });
    const task = makeTask();

    const error = await subject.transition
      .resume(task, { text: "again", user: "u" }, vi.fn())
      .catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(NodeResponseRejectedError);
    const verdict = (error as NodeResponseRejectedError).verdict;
    expect(verdict.facts.call).toBe("resume");
    expect(verdict.decision.intents).toContain("release_local_ownership");
    // 중앙 상태를 오류로 덮지 않는다: 이 호출은 종료 사건을 올리지 않는다.
    expect(subject.persistence.enqueueTerminalTransitionAndWaitForApplication)
      .not.toHaveBeenCalled();
    expect(subject.forgetTask).toHaveBeenCalledWith("s1");
  });

  it("confirms the central session before releasing when the rejection carries no reason", async () => {
    const subject = makeSubject(async () => null);
    subject.persistence.enqueueRunningTransitionAndWaitForApplication.mockResolvedValueOnce({
      eventId: 9,
      applied: false,
      canonicalSession: canonicalSession("completed"),
    });

    await expect(subject.transition.resume(
      makeTask(),
      { text: "again", user: "u" },
      vi.fn(),
    )).rejects.toBeInstanceOf(NodeResponseRejectedError);

    expect(subject.forgetTask).toHaveBeenCalledWith("s1");
  });

  it("keeps local ownership when the central session is present", async () => {
    const subject = makeSubject(async () => ({ id: "s1" }));
    subject.persistence.enqueueRunningTransitionAndWaitForApplication.mockResolvedValueOnce({
      eventId: 9,
      applied: false,
      canonicalSession: canonicalSession("completed"),
    });

    await expect(subject.transition.resume(
      makeTask(),
      { text: "again", user: "u" },
      vi.fn(),
    )).rejects.toBeInstanceOf(NodeResponseRejectedError);

    expect(subject.forgetTask).not.toHaveBeenCalled();
  });

  it("settles a rejected resume compensation terminal through the same verdict path", async () => {
    const subject = makeSubject(async () => null);
    subject.persistence.enqueueTerminalTransitionAndWaitForApplication.mockResolvedValueOnce({
      eventId: 10,
      applied: false,
      canonicalSession: canonicalSession("completed"),
    });
    let activation!: NonNullable<Task["executionActivation"]>;

    await subject.transition.resume(
      makeTask(),
      { text: "again", user: "u" },
      (_resumed, started) => {
        activation = started!;
        activation.reject(new Error("admission failed"));
      },
    );
    await activation.promise.catch(() => undefined);

    await vi.waitFor(() => expect(subject.forgetTask).toHaveBeenCalledWith("s1"));
    expect(subject.settle).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        facts: expect.objectContaining({ call: "resume_compensation_terminal" }),
      }),
    );
  });
});

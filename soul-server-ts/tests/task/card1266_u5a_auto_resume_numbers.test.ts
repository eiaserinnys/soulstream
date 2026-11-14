import pino from "pino";
import { describe, expect, it, vi } from "vitest";

import { AutoResumeTransition } from "../../src/task/task_auto_resume_transition.js";
import { instructionNumberOf } from "../../src/task/state/node_instruction_decision.js";
import { enqueueInterventionOnce } from "../../src/task/task_intervention_queue.js";
import type { InterventionMessage, Task } from "../../src/task/task_models.js";
import { NodeResponseRejectedError } from "../../src/task/state/node_response_handling.js";

import { makeEventPersistenceTestDouble } from "./event_persistence_test_double.js";

/**
 * 카드 #1266 U5a 다: 노드가 러너에 넘기는 모든 지시는 어느 길로 들어왔든 번호를 갖는다.
 * 자동 재개 길은 장부 번호 없는 메시지를 큐에 넣으면서 번호를 채우지 않았고, 응답 맥락에는
 * 등록 번호가 없어 낡은 등록의 거절을 알아보지 못했다.
 */
const silentLogger = pino({ level: "silent" });

function makeTask(overrides: Partial<Task> = {}): Task {
  return {
    agentSessionId: "s-u5a",
    prompt: "original prompt",
    status: "completed",
    profileId: "codex-default",
    createdAt: new Date("2026-11-14T01:00:00.000Z"),
    completedAt: new Date("2026-11-14T01:05:00.000Z"),
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
  updated_at: "2026-11-14T00:00:00.000Z",
  last_event_id: 9,
});

function makeSubject() {
  const persistence = makeEventPersistenceTestDouble(undefined, [], {
    capabilityProfile: "legacy_transition_only",
  });
  const settle = vi.fn(async (_task: Task, verdict) => verdict);
  const transition = new AutoResumeTransition({
    logger: silentLogger,
    persistence: persistence.persistence,
    settleRejection: settle,
  });
  return { transition, persistence, settle };
}

describe("card #1266 U5a 다: the auto-resume path numbers the instruction it queues", () => {
  it("gives a message with no ledger number an instruction number before it is queued", async () => {
    const subject = makeSubject();
    const task = makeTask();
    const message: InterventionMessage = { text: "again", user: "u" };

    await subject.transition.resume(task, message, vi.fn());

    expect(task.interventionQueue).toEqual([message]);
    const number = instructionNumberOf(task.interventionQueue[0]!);
    expect(typeof number).toBe("string");
    expect(number!.length).toBeGreaterThan(0);
  });

  it("keeps the ledger delivery id as the number and does not add a second one", async () => {
    const subject = makeSubject();
    const task = makeTask();
    const message: InterventionMessage = { text: "again", user: "u", deliveryId: "delivery-1" };

    await subject.transition.resume(task, message, vi.fn());

    expect(instructionNumberOf(task.interventionQueue[0]!)).toBe("delivery-1");
    expect(task.interventionQueue[0]!.runnerInterventionId).toBeUndefined();
  });

  it("numbers a queued message that resumes after terminal once, without queueing it twice", async () => {
    const subject = makeSubject();
    const task = makeTask();
    const message: InterventionMessage = { text: "queued while terminal", user: "u" };
    task.interventionQueue.push(message);

    await expect(subject.transition.resumeQueuedAfterTerminal(task, vi.fn())).resolves.toBe(true);

    expect(task.interventionQueue).toHaveLength(1);
    expect(task.interventionQueue[0]).toBe(message);
    expect(instructionNumberOf(message)).toBeDefined();
  });

  it("numbers every message that enters the queue, whatever the route", () => {
    const task = makeTask();
    const plain: InterventionMessage = { text: "a", user: "u" };
    const withLedger: InterventionMessage = { text: "b", user: "u", deliveryId: "d-2" };
    const numbered: InterventionMessage = { text: "c", user: "u", runnerInterventionId: "n-3" };

    enqueueInterventionOnce(task, plain);
    enqueueInterventionOnce(task, withLedger);
    enqueueInterventionOnce(task, numbered);

    expect(task.interventionQueue.map(instructionNumberOf)).toEqual(
      expect.arrayContaining([expect.any(String), "d-2", "n-3"]),
    );
    expect(task.interventionQueue.every((m) => instructionNumberOf(m) !== undefined)).toBe(true);
    // 같은 객체를 다시 넣어도 번호가 바뀌거나 중복되지 않는다.
    const before = plain.runnerInterventionId;
    enqueueInterventionOnce(task, plain);
    expect(plain.runnerInterventionId).toBe(before);
    expect(task.interventionQueue).toHaveLength(3);
  });
});

describe("card #1266 U5a 다: the response context of a resume carries the registration number", () => {
  it("tells a stale registration's rejected resume apart from the live registration", async () => {
    const subject = makeSubject();
    subject.persistence.enqueueRunningTransitionAndWaitForApplication.mockResolvedValueOnce({
      eventId: 9,
      applied: false,
      rejectionReason: "already_terminal",
      canonicalSession: canonicalSession("completed"),
      canonicalExecutionRegistration: {
        registrationId: "registration-new",
        executionCommandId: "execute-new",
      },
    });
    const task = makeTask({
      executionRegistration: {
        registrationId: "registration-old",
        executionCommandId: "execute-old",
      },
    });

    const error = await subject.transition
      .resume(task, { text: "again", user: "u" }, vi.fn())
      .catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(NodeResponseRejectedError);
    const verdict = (error as NodeResponseRejectedError).verdict;
    expect(verdict.facts.call).toBe("resume");
    expect(verdict.facts.registration).toBe("different");
    expect(verdict.decision.intents).not.toContain("mark_central_error");
  });

  it("keeps comparing nothing when the task had no registration at all", async () => {
    const subject = makeSubject();
    subject.persistence.enqueueRunningTransitionAndWaitForApplication.mockResolvedValueOnce({
      eventId: 9,
      applied: false,
      rejectionReason: "already_terminal",
      canonicalSession: canonicalSession("completed"),
      canonicalExecutionRegistration: {
        registrationId: "registration-new",
        executionCommandId: "execute-new",
      },
    });

    const error = await subject.transition
      .resume(makeTask(), { text: "again", user: "u" }, vi.fn())
      .catch((caught: unknown) => caught);

    expect((error as NodeResponseRejectedError).verdict.facts.registration).toBe("same");
  });

  it("carries the registration number into the rejected resume compensation terminal as well", async () => {
    const subject = makeSubject();
    subject.persistence.enqueueTerminalTransitionAndWaitForApplication.mockResolvedValueOnce({
      eventId: 10,
      applied: false,
      canonicalSession: canonicalSession("completed"),
      canonicalExecutionRegistration: {
        registrationId: "registration-new",
        executionCommandId: "execute-new",
      },
    });
    let activation!: NonNullable<Task["executionActivation"]>;
    const task = makeTask({
      executionRegistration: {
        registrationId: "registration-old",
        executionCommandId: "execute-old",
      },
    });

    await subject.transition.resume(
      task,
      { text: "again", user: "u" },
      (_resumed, started) => {
        activation = started!;
        activation.reject(new Error("admission failed"));
      },
    );
    await activation.promise.catch(() => undefined);

    await vi.waitFor(() => expect(subject.settle).toHaveBeenCalled());
    const verdict = subject.settle.mock.calls.at(-1)![1];
    expect(verdict.facts.call).toBe("resume_compensation_terminal");
    expect(verdict.facts.registration).toBe("different");
  });
});

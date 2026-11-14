import pino from "pino";
import { describe, expect, it, vi } from "vitest";

import { TaskLifecycleTransition } from "../../src/task/task_lifecycle_transition.js";
import type { Task } from "../../src/task/task_models.js";
import {
  judgeNodeResponse,
  nodeResponseFactsFromApplication,
} from "../../src/task/state/node_response_handling.js";
import { EventOutboxDeadLetterError, EventOutboxQuarantinedError }
  from "../../src/upstream/event_outbox_pump_protocol.js";

const silentLogger = pino({ level: "silent" });
const EVENT_ID = 8;

function makeTask(overrides: Partial<Task> = {}): Task {
  return {
    agentSessionId: "sess-1",
    prompt: "hi",
    status: "completed",
    terminationReason: "completed_ok",
    completedAt: new Date("2026-11-13T01:00:00.000Z"),
    createdAt: new Date("2026-11-13T00:00:00.000Z"),
    callerSessionId: "parent-session",
    executionRegistration: {
      registrationId: "registration-1",
      executionCommandId: "execute-1",
    },
    lastEventId: 7,
    lastReadEventId: 0,
    interventionQueue: [],
    ...overrides,
  };
}

function canonical(terminationEventId: number | null, status = "completed") {
  return {
    status,
    termination_reason: terminationEventId === null ? null : "completed_ok",
    termination_detail: null,
    review_state: "not_required",
    last_assistant_text: null,
    termination_event_id: terminationEventId,
    updated_at: "2026-11-13T01:00:00.000Z",
    last_event_id: terminationEventId ?? 7,
  };
}

function makeSubject(
  respond: () => Promise<unknown> | unknown,
  options: { probe?: () => Promise<unknown>; retire?: boolean } = {},
) {
  const enqueue = vi.fn(async (..._args: unknown[]) => await respond());
  const notify = vi.fn(async () => {});
  const closePending = vi.fn(async () => {});
  const release = vi.fn(async (..._args: unknown[]) => {});
  const retire = vi.fn(async (..._args: unknown[]) => {});
  const transition = new TaskLifecycleTransition({
    logger: silentLogger,
    persistence: { enqueueTerminalTransitionAndWaitForApplication: enqueue } as never,
    completionNotifier: { notify },
    closeSettlementPending: closePending,
    releaseLocalOwnership: release,
    ...(options.probe ? { readCentralSession: options.probe } : {}),
    ...(options.retire ? { retireRejectedRegistration: retire } : {}),
  } as never);
  return { transition, enqueue, notify, closePending, release, retire };
}

const rejected = (
  canonicalSession: ReturnType<typeof canonical>,
  extra: Record<string, unknown> = {},
) => ({
  eventId: EVENT_ID,
  applied: false,
  canonicalSession,
  canonicalExecutionRegistration: null,
  ...extra,
});

describe("card #1266 U2a terminal rejection", () => {
  it("marks the rejected registration for retirement and sends no completion report after a permanent rejection", async () => {
    const subject = makeSubject(() => {
      throw new EventOutboxDeadLetterError(
        8, "REPEATED_FAILURE", "2026-11-13T01:00:01.000Z", "repeated failure",
      );
    });
    const task = makeTask();

    const result = await subject.transition.persistExecutorFinalState(task, true);
    await subject.transition.notifyCompletionIfApplied(task, result);

    expect(result.terminalTransitionApplied).toBe(false);
    expect(subject.closePending).toHaveBeenCalledOnce();
    expect(task.rejectedTerminationRegistrationId).toBe("registration-1");
    expect(subject.release).not.toHaveBeenCalled();
    expect(subject.notify).not.toHaveBeenCalled();
  });

  it("treats a quarantined terminal like a permanent rejection", async () => {
    const subject = makeSubject(() => {
      throw new EventOutboxQuarantinedError(
        8, "INVALID_EVENT", "2026-11-13T01:00:01.000Z", "invalid event",
      );
    });
    const task = makeTask();
    const result = await subject.transition.persistExecutorFinalState(task, true);
    expect(result.terminalTransitionApplied).toBe(false);
    expect(task.rejectedTerminationRegistrationId).toBe("registration-1");
  });

  it("settles a rejection as applied when the canonical termination event is ours", async () => {
    const subject = makeSubject(() => rejected(canonical(EVENT_ID)));
    const task = makeTask();

    const result = await subject.transition.persistExecutorFinalState(task, true);
    await subject.transition.notifyCompletionIfApplied(task, result);

    expect(result.terminalTransitionApplied).toBe(true);
    expect(subject.closePending).not.toHaveBeenCalled();
    expect(task.rejectedTerminationRegistrationId).toBeUndefined();
    expect(subject.notify).toHaveBeenCalledOnce();
  });

  it("settles a dead-lettered terminal as applied when the canonical termination event is ours", async () => {
    // 응답 길과 사유는 보지 않는다. 정본 투영이 우리 종료이면 적용됨이다.
    const subject = makeSubject(() => rejected(canonical(EVENT_ID), {
      rejectionReason: "already_terminal",
    }));
    const result = await subject.transition.persistExecutorFinalState(makeTask(), true);
    expect(result.terminalTransitionApplied).toBe(true);
    expect(subject.closePending).not.toHaveBeenCalled();
  });

  it("marks the registration for retirement without resubmitting when another termination already exists", async () => {
    const subject = makeSubject(() => rejected(canonical(5)));
    const task = makeTask();

    const result = await subject.transition.persistExecutorFinalState(task, true);

    expect(result.terminalTransitionApplied).toBe(false);
    expect(subject.closePending).toHaveBeenCalledOnce();
    expect(task.rejectedTerminationRegistrationId).toBe("registration-1");
    expect(subject.notify).not.toHaveBeenCalled();
  });

  it("keeps a reasonless rejection without a canonical termination retryable", async () => {
    const subject = makeSubject(() => rejected(canonical(null, "running")));
    const task = makeTask();
    const result = await subject.transition.persistExecutorFinalState(task, true);
    expect(result.terminalTransitionApplied).toBe(false);
    expect(subject.closePending).not.toHaveBeenCalled();
    expect(task.rejectedTerminationRegistrationId).toBeUndefined();
    expect(subject.release).not.toHaveBeenCalled();
  });

  it("closes the settlement and releases local ownership when the central session is confirmed gone", async () => {
    const subject = makeSubject(
      () => rejected(canonical(null, "running")),
      { probe: async () => null },
    );
    const task = makeTask();

    const result = await subject.transition.persistExecutorFinalState(task, true);

    expect(result.terminalTransitionApplied).toBe(false);
    expect(subject.closePending).toHaveBeenCalledOnce();
    expect(subject.release).toHaveBeenCalledWith(task);
    expect(task.rejectedTerminationRegistrationId).toBeUndefined();
  });

  it("does not read the central session again when the rejection is already settled", async () => {
    const probe = vi.fn(async () => null);
    const subject = makeSubject(() => rejected(canonical(EVENT_ID)), { probe });
    await subject.transition.persistExecutorFinalState(makeTask(), true);
    expect(probe).not.toHaveBeenCalled();
  });

  it("does not let a failing cleanup port break the finalization", async () => {
    const subject = makeSubject(() => rejected(canonical(5)));
    subject.closePending.mockRejectedValueOnce(new Error("close failed"));
    await expect(subject.transition.persistExecutorFinalState(makeTask(), true))
      .resolves.toMatchObject({ terminalTransitionApplied: false });
  });

  it("keeps the semantic dedupe key of a rejected terminal across resends", async () => {
    const subject = makeSubject(() => rejected(canonical(null, "completed")));
    const task = makeTask();

    await subject.transition.persistExecutorFinalState(task, true);
    // 복구가 다시 올릴 때마다 completedAt이 새로 찍히고 등록은 이미 지워져 있다.
    task.completedAt = new Date("2026-11-13T01:00:15.000Z");
    task.terminationEventRecorded = false;
    task.status = "completed";
    await subject.transition.persistExecutorFinalState(task, true);
    task.completedAt = new Date("2026-11-13T01:00:30.000Z");
    task.terminationEventRecorded = false;
    task.status = "completed";
    await subject.transition.persistExecutorFinalState(task, true);

    const keys = subject.enqueue.mock.calls.map(
      (call) => (call[1] as { _dedupe_key: string })._dedupe_key,
    );
    expect(keys).toHaveLength(3);
    expect(new Set(keys).size).toBe(1);
  });
});

describe("card #1266 U2a rejected terminal retirement timing", () => {
  it("retires the rejected registration on disk when the rejection arrives and no runner is attached", async () => {
    const subject = makeSubject(() => rejected(canonical(5)), { retire: true });
    const task = makeTask();

    await subject.transition.persistExecutorFinalState(task, true);

    expect(subject.retire).toHaveBeenCalledOnce();
    expect(subject.retire).toHaveBeenCalledWith(task, "registration-1");
  });

  it("waits for the finalizer to decide the attached runner before retiring the registration", async () => {
    const subject = makeSubject(() => rejected(canonical(5)), { retire: true });
    const task = makeTask({ runner: { dispatcher: {} } as never });

    await subject.transition.persistExecutorFinalState(task, true);
    expect(subject.retire).not.toHaveBeenCalled();

    task.runner = undefined;
    await subject.transition.retireRejectedTerminal(task);
    expect(subject.retire).toHaveBeenCalledOnce();
    expect(subject.retire).toHaveBeenCalledWith(task, "registration-1");
  });

  it("does not retire a runner that is retained for detached work", async () => {
    const subject = makeSubject(() => rejected(canonical(5)), { retire: true });
    const task = makeTask({ runner: { dispatcher: {} } as never });

    await subject.transition.persistExecutorFinalState(task, true);
    task.runnerRetainedForDetachedWork = true;
    await subject.transition.retireRejectedTerminal(task);

    expect(subject.retire).not.toHaveBeenCalled();
    expect(task.rejectedTerminationRegistrationId).toBe("registration-1");
  });

  it("keeps the mark for the next scan when the retirement fails", async () => {
    const subject = makeSubject(() => rejected(canonical(5)), { retire: true });
    subject.retire.mockRejectedValueOnce(new Error("retire failed"));
    const task = makeTask();

    await expect(subject.transition.persistExecutorFinalState(task, true))
      .resolves.toMatchObject({ terminalTransitionApplied: false });
    expect(task.rejectedTerminationRegistrationId).toBe("registration-1");
  });
});

describe("card #1266 U2a rejection of a session the server already closed", () => {
  // 운영 첫 거절의 꼴: 사유 없음, termination_event_id null, 서버 세션은 이미 interrupted.
  const serverClosed = () => rejected({
    ...canonical(null, "interrupted"),
    termination_reason: "killed",
    termination_detail: "node_disconnect_timeout",
  });

  it("does not resubmit it and retires the registration instead of staying retryable", async () => {
    const subject = makeSubject(serverClosed, { retire: true });
    const task = makeTask({ status: "error", terminationReason: "killed" });

    const result = await subject.transition.persistExecutorFinalState(task, true);

    expect(result.terminalTransitionApplied).toBe(false);
    expect(subject.closePending).toHaveBeenCalledOnce();
    expect(subject.retire).toHaveBeenCalledWith(task, "registration-1");
  });

  it("does not call it another termination when the canonical projection carries no session status", () => {
    const application = {
      eventId: EVENT_ID,
      applied: false,
      canonicalSession: { termination_event_id: null },
    };
    const facts = nodeResponseFactsFromApplication({ call: "termination" }, application);
    expect(facts.termination).toBe("absent");
    expect(judgeNodeResponse(facts).decision.cell).toBe("retryable");

    const withStatus = nodeResponseFactsFromApplication(
      { call: "termination" },
      { ...application, canonicalSession: { termination_event_id: null, status: "interrupted" } },
    );
    expect(withStatus.termination).toBe("different");
    expect(judgeNodeResponse(withStatus).decision.cell).toBe("no_retry");
  });
});

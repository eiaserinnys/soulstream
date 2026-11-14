import pino from "pino";
import { describe, expect, it, vi } from "vitest";

import type { SessionDB } from "../../src/db/session_db.js";
import type { EnginePort } from "../../src/engine/protocol.js";
import { TaskExecutor } from "../../src/task/task_executor.js";
import type { Task } from "../../src/task/task_models.js";
import { classifyRunnerAdoptRejection } from "../../src/task/state/node_adopt_rejection.js";
import type { NodeAdoptionApplication } from "../../src/task/state/node_response_handling.js";
import type { CompletionNotifier } from "../../src/task/completion_notifier.js";
import { EventOutboxDeadLetterError } from "../../src/upstream/event_outbox_pump_protocol.js";
import type { SessionBroadcaster } from "../../src/upstream/session_broadcaster.js";

import { makeEventPersistenceTestDouble } from "./event_persistence_test_double.js";

/**
 * 카드 #1266 U5c 할 것 6. 다른 세션이 워크트리를 쥐어 잇기가 거절되면(worktree_busy) 합의 모형처럼
 * 다시 될 까닭이 없는 거절로 보고 러너를 거둔다(M:406-412). orch는 기록된 끝남보다 점유를 먼저 보므로
 * 노드가 중앙 세션 줄로 가른다. 끝남이 기록된 세션은 러너만 거두고, 끊김 중단(종료 기록 없는 interrupted)
 * 세션은 M처럼 오류 종료를 올린다. 「준비 안 됨」과 사유 없는 거절은 다시 될 수 있는 거절로 남는다.
 */

interface CentralRow {
  status: string;
  termination_event_id: number | null;
}

const RECORDED_END: CentralRow = { status: "completed", termination_event_id: 7 };
const DISCONNECT_INTERRUPTED: CentralRow = { status: "interrupted", termination_event_id: null };

function setup(
  rejectionReason: string | undefined,
  central: CentralRow,
  adoptError?: Error,
) {
  const double = makeEventPersistenceTestDouble();
  const enqueueTerminal = vi.fn(async (..._args: unknown[]) => ({
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
      if (adoptError) throw adoptError;
      return {
      eventId: 5,
      applied: false,
      ...(rejectionReason === undefined ? {} : { rejectionReason }),
      canonicalSession: {
        ...central,
        termination_reason: null,
        termination_detail: null,
        review_state: "not_required",
        last_assistant_text: null,
        updated_at: "2026-11-14T00:00:00.000Z",
        last_event_id: 5,
      },
      };
    }),
    enqueueTerminalTransitionAndWaitForApplication: enqueueTerminal,
  });
  const engine = {
    backendId: "codex", workspaceDir: "/tmp/a", async *execute() {},
    async interrupt() { return true; }, async close() {},
  } as unknown as EnginePort;
  const getSession = vi.fn(async () => ({ session_id: "sess-1", node_id: "node-a", ...central }));
  const notify = vi.fn(async (_task: Task) => ({ kind: "registered" as const }));
  const executor = new TaskExecutor(
    () => engine,
    { updateSession: vi.fn(), getSession } as unknown as SessionDB,
    double.persistence,
    { emitEventEnvelope: vi.fn(), emitSessionUpdated: vi.fn() } as unknown as SessionBroadcaster,
    pino({ level: "silent" }),
    undefined,
    { notify } as unknown as CompletionNotifier,
  );
  const task: Task = {
    agentSessionId: "sess-1",
    prompt: "hi",
    status: "running",
    createdAt: new Date("2026-11-14T00:00:00.000Z"),
    lastEventId: 3,
    lastReadEventId: 0,
    interventionQueue: [],
    callerSessionId: "parent-session",
    runner: {
      engine,
      dispatcher: { registrationId: () => "registration-adopt" } as never,
      eventPersistence: "runner",
    },
  };
  return { executor, task, enqueueTerminal, getSession, notify };
}

/** 러너 복구가 읽는 분류다(runner_recovery_coordinator recordCentralAdoptionResponse). */
function responseOf(application: NodeAdoptionApplication): string {
  return application.response ?? classifyRunnerAdoptRejection(application.rejectionReason);
}

describe("card #1266 U5c an adoption rejected because the worktree is busy", () => {
  it.each([RECORDED_END, DISCONNECT_INTERRUPTED])("retries after a central read failure, then settles the readable row %j", async (central) => {
    const subject = setup("worktree_busy", central);
    subject.getSession.mockRejectedValueOnce(new Error("central unavailable"));

    const unread = await subject.executor.adoptAttachedRunnerExecution(subject.task, "execute-1");

    expect(responseOf(unread)).toBe("retryable_rejection");
    expect(subject.task.runner).toBeDefined();
    expect(subject.enqueueTerminal).not.toHaveBeenCalled();
    expect(subject.notify).not.toHaveBeenCalled();

    const readable = await subject.executor.adoptAttachedRunnerExecution(subject.task, "execute-1");
    expect(responseOf(readable)).toBe("terminal_rejection");
    expect(subject.getSession).toHaveBeenCalledTimes(2);
    expect(subject.enqueueTerminal).toHaveBeenCalledTimes(central === DISCONNECT_INTERRUPTED ? 1 : 0);
    expect(subject.notify).toHaveBeenCalledTimes(central === DISCONNECT_INTERRUPTED ? 1 : 0);
  });

  it("reaps without raising a terminal when the central session already recorded its end", async () => {
    const subject = setup("worktree_busy", RECORDED_END);

    const application = await subject.executor.adoptAttachedRunnerExecution(subject.task, "execute-1");

    expect(application.applied).toBe(false);
    expect(responseOf(application)).toBe("terminal_rejection");
    expect(subject.getSession).toHaveBeenCalledWith("sess-1");
    expect(subject.enqueueTerminal).not.toHaveBeenCalled();
    expect(subject.notify).not.toHaveBeenCalled();
    expect(subject.task.status).toBe("running");
  });

  it("reaps and raises the error terminal when the central session was interrupted by a disconnect", async () => {
    const subject = setup("worktree_busy", DISCONNECT_INTERRUPTED);

    const application = await subject.executor.adoptAttachedRunnerExecution(subject.task, "execute-1");

    expect(responseOf(application)).toBe("terminal_rejection");
    expect(subject.enqueueTerminal).toHaveBeenCalledOnce();
    expect(subject.enqueueTerminal.mock.calls[0]?.[3]).toBe("registration-adopt");
    // 세션을 닫는 종료라 기다리는 부모에게 완료를 알린다(M:239-240, :357-365, :415-417, :310-313).
    expect(subject.notify).toHaveBeenCalledOnce();
    expect(subject.notify.mock.calls[0]?.[0]).toBe(subject.task);
  });

  it("keeps a permanent rejection's central error mark without a completion notice", async () => {
    const subject = setup(undefined, DISCONNECT_INTERRUPTED, new EventOutboxDeadLetterError(
      4, "REPEATED_FAILURE", "2026-11-14T00:00:01.000Z", "repeated failure",
    ));

    await subject.executor.adoptAttachedRunnerExecution(subject.task, "execute-1");

    expect(subject.enqueueTerminal).toHaveBeenCalledOnce();
    expect(subject.notify).not.toHaveBeenCalled();
  });

  it.each([
    ["worktree_not_ready", "worktree_not_ready"],
    ["no reason (old server)", undefined],
  ])("keeps a %s rejection retryable and does not reap or raise a terminal", async (_name, reason) => {
    for (const central of [RECORDED_END, DISCONNECT_INTERRUPTED]) {
      const subject = setup(reason, central);

      const application = await subject.executor.adoptAttachedRunnerExecution(subject.task, "execute-1");

      expect(responseOf(application)).toBe("retryable_rejection");
      expect(subject.enqueueTerminal).not.toHaveBeenCalled();
      expect(subject.notify).not.toHaveBeenCalled();
      expect(subject.task.runner).toBeDefined();
    }
  });
});

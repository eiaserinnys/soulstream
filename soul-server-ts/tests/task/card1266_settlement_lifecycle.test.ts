import { describe, expect, it, vi } from "vitest";

import type { EnginePort } from "../../src/engine/protocol.js";
import { InProcessRunnerCommandDispatcher } from "../../src/runner/runner_command_dispatcher.js";

import { TaskLifecycleTransition, type TerminationCleanupPorts } from "../../src/task/task_lifecycle_transition.js";
import { terminalDedupeKeyOf } from "../../src/task/task_termination.js";
import type { Task } from "../../src/task/task_models.js";
import { EventOutboxDeadLetterError } from "../../src/upstream/event_outbox_pump_protocol.js";

import {
  DEDUPE_KEY,
  SESSION_ID,
  centralRow,
  makeNotifier,
  makeOutbox,
  makeOutboxDirectory,
  makeStore,
  makeSweeper,
  makeTask,
  silentLogger,
} from "./card1266_settlement_harness.js";
import type { CompletionSettlementStore } from "../../src/task/completion_settlement_store.js";

const EVENT_ID = 41;

function activeTask(overrides: Partial<Task> = {}): Task {
  return makeTask({
    status: "running",
    terminationReason: undefined,
    terminationEventRecorded: false,
    terminalEventId: undefined,
    terminalDedupeIdentity: undefined,
    completedAt: undefined,
    ...overrides,
  });
}

function canonical(termination: number | null, status = "completed") {
  return {
    status,
    termination_reason: termination === null ? null : "completed_ok",
    termination_detail: null,
    review_state: "not_required",
    last_assistant_text: "child final answer",
    termination_event_id: termination,
    updated_at: "2026-11-14T00:05:00.000Z",
    last_event_id: termination ?? 40,
  };
}

const applied = (id = EVENT_ID) => ({
  eventId: id, applied: true, canonicalSession: canonical(id), canonicalExecutionRegistration: null,
});

/** 아웃박스에 붙은 직후의 좌표를 콜백으로 알리는 가짜 영속 계층이다. */
function makePersistence(
  store: CompletionSettlementStore,
  respond: () => unknown | Promise<unknown>,
  seen: { atAppend: unknown[]; afterAppend: unknown[]; afterAck: unknown[] } = { atAppend: [], afterAppend: [], afterAck: [] },
) {
  const enqueue = vi.fn(async (...args: unknown[]) => {
    seen.atAppend.push(await store.list());
    const onAppended = args[4] as ((record: unknown) => Promise<void>) | undefined;
    if (respond.name !== "appendFails") {
      await onAppended?.({ stream_id: "stream-1", source_seq: 5 });
      seen.afterAppend.push(await store.list());
    }
    const response = await respond();
    seen.afterAck.push(await store.list());
    return response;
  });
  return { enqueue, seen, persistence: { enqueueTerminalTransitionAndWaitForApplication: enqueue } as never };
}

async function makeSubject(options: {
  respond: () => unknown | Promise<unknown>;
  rows?: Map<string, Record<string, unknown>>;
  directory?: string;
  extraPorts?: Partial<TerminationCleanupPorts>;
  v2?: boolean;
  /** 아웃박스에 이미 있는 줄을 흉내 낸다(붙이기가 줄을 쓴 뒤 던진 경우). */
  outbox?: { findBySemanticDedupeKey(key: string): Promise<unknown | null> };
  storeNow?: () => number;
}) {
  const directory = options.directory ?? await makeOutboxDirectory();
  const store = makeStore(directory, options.storeNow, options.outbox);
  const rows = options.rows ?? new Map<string, Record<string, unknown>>();
  const harness = makeNotifier(rows);
  const persistence = makePersistence(store, options.respond);
  const order: string[] = [];
  const transition = new TaskLifecycleTransition({
    logger: silentLogger,
    persistence: persistence.persistence,
    completionNotifier: harness.notifier,
    settlement: store,
    closeSettlementPending: async (task) => {
      order.push("close");
      const key = terminalDedupeKeyOf(task);
      if (key) await store.close(key);
    },
    retireRejectedRegistration: async () => { order.push("retire"); },
    ...options.extraPorts,
  } as never);
  return { directory, store, rows, transition, order, ...harness, ...persistence };
}

describe("card #1266 U2b settlement: written before the outbox append", () => {
  it("persists the entry before the append, adds the outbox coordinate after it, the event number after the ack, and closes it once registered", async () => {
    const subject = await makeSubject({ respond: () => applied() });
    const task = activeTask();
    task.status = "completed";
    task.terminationReason = "completed_ok";
    task.completedAt = new Date("2026-11-14T00:05:00.000Z");

    const result = await subject.transition.persistExecutorFinalState(task, true, { settleCompletion: true });

    const entryAt = (snapshot: unknown) => (snapshot as Array<Record<string, unknown>>)[0];
    expect(entryAt(subject.seen.atAppend[0])).toMatchObject({ sessionId: SESSION_ID, dedupeKey: DEDUPE_KEY, registrationId: "registration-1", executionCommandId: "execute-1" });
    expect(entryAt(subject.seen.atAppend[0])?.sourceSeq).toBeUndefined();
    expect(entryAt(subject.seen.afterAppend[0])).toMatchObject({ streamId: "stream-1", sourceSeq: 5 });
    expect(entryAt(subject.seen.afterAck[0])).toMatchObject({ sourceSeq: 5 });
    expect(result.settlementKey).toBe(DEDUPE_KEY);
    // 응답을 받은 뒤에는 적용된 종료 사건 번호가 덧붙고, 등록 전에는 남아 있다.
    expect(await subject.store.list()).toEqual([
      expect.objectContaining({ sourceSeq: 5, terminationEventId: EVENT_ID }),
    ]);

    await subject.transition.notifyCompletionIfApplied(task, result);

    expect(subject.repository.register).toHaveBeenCalledTimes(1);
    expect(await subject.store.list()).toEqual([]);
  });

  it("removes the entry when the append itself throws, since nothing went to the outbox", async () => {
    const subject = await makeSubject({
      respond: async function appendFails() { throw new Error("disk full"); },
    });
    const task = makeTask({ terminationEventRecorded: false, status: "completed" });

    await expect(subject.transition.persistExecutorFinalState(task, true, { settleCompletion: true }))
      .rejects.toThrow("disk full");

    // 붙이려던 때에는 미결이 있었고, 붙이기가 던져 지웠다.
    expect(subject.seen.atAppend[0]).toHaveLength(1);
    expect(await subject.store.list()).toEqual([]);
  });

  it("keeps the entry when a resend's append throws but an earlier attempt of the same terminal may already be in the outbox", async () => {
    const subject = await makeSubject({
      respond: async function appendFails() { throw new Error("disk full"); },
    });
    const task = makeTask({ terminationEventRecorded: false, status: "completed" });
    // 앞 시도가 이미 미결을 남겼다(그 시도의 줄은 아웃박스에 있을 수 있다).
    await subject.store.begin({
      sessionId: SESSION_ID, dedupeKey: DEDUPE_KEY, registrationId: "registration-1", executionCommandId: "execute-1",
    });
    subject.store.release(DEDUPE_KEY);

    await expect(subject.transition.persistExecutorFinalState(task, true, { settleCompletion: true }))
      .rejects.toThrow("disk full");

    expect(await subject.store.listUnheld()).toHaveLength(1);
  });

  it("does not let the sweep register while the normal path is still waiting for the ack, however long the wait is", async () => {
    let tick = 1_000;
    const holder: { sweep?: () => Promise<void> } = {};
    const subject = await makeSubject({
      storeNow: () => tick,
      respond: async () => {
        // 응답을 오래 기다리는 사이 주기 훑기가 돈다(예전에는 10분 뒤에 쥠이 풀렸다).
        tick += 60 * 60_000;
        await holder.sweep!();
        return applied();
      },
    });
    const outbox = makeOutbox();
    outbox.ackedSeq = 5;
    const sweeper = makeSweeper({
      store: subject.store, outbox, central: async () => centralRow(), notifier: subject.notifier, now: () => tick,
    });
    holder.sweep = () => sweeper.sweepOnce();
    const task = makeTask({ terminationEventRecorded: false });

    const result = await subject.transition.persistExecutorFinalState(task, true, { settleCompletion: true });

    expect(subject.repository.register).not.toHaveBeenCalled();
    await subject.transition.notifyCompletionIfApplied(task, result);
    expect(subject.repository.register).toHaveBeenCalledTimes(1);
    expect(await subject.store.list()).toEqual([]);
  });

  it("keeps the entry when the append wrote its line and then threw (metadata write), instead of deleting it", async () => {
    const subject = await makeSubject({
      respond: async function appendFails() { throw new Error("metadata write failed"); },
      // 줄은 datasync까지 갔으므로 아웃박스에 있다.
      outbox: { findBySemanticDedupeKey: async (key) => (key === DEDUPE_KEY ? { source_seq: 5 } : null) },
    });
    const task = makeTask({ terminationEventRecorded: false, status: "completed" });

    await expect(subject.transition.persistExecutorFinalState(task, true, { settleCompletion: true }))
      .rejects.toThrow("metadata write failed");

    expect(await subject.store.list()).toHaveLength(1);
    expect(await subject.store.listUnheld()).toHaveLength(1);
  });

  it("releases the normal path's hold when the projection of the applied response throws, so the sweep is not blocked until restart", async () => {
    const subject = await makeSubject({
      respond: () => ({ eventId: EVENT_ID, applied: true, canonicalSession: null, canonicalExecutionRegistration: null }),
    });
    const task = makeTask({ terminationEventRecorded: false });

    await expect(subject.transition.persistExecutorFinalState(task, true, { settleCompletion: true }))
      .rejects.toThrow();

    expect(await subject.store.list()).toHaveLength(1);
    expect(subject.store.isSessionHeld(SESSION_ID)).toBe(false);
    expect(await subject.store.listUnheld()).toHaveLength(1);
  });

  it("keeps the entry and hands it to the sweep when the wait for the ack throws after the append", async () => {
    const subject = await makeSubject({ respond: () => { throw new Error("ack wait timed out"); } });
    const task = makeTask({ terminationEventRecorded: false });

    await expect(subject.transition.persistExecutorFinalState(task, true, { settleCompletion: true }))
      .rejects.toThrow("ack wait timed out");

    expect(await subject.store.list()).toHaveLength(1);
    expect(await subject.store.listUnheld()).toHaveLength(1);
  });

  it("writes no entry for a terminal that carries no completion duty", async () => {
    const subject = await makeSubject({ respond: () => applied() });

    await subject.transition.persistExecutorFinalState(makeTask({ terminationEventRecorded: false }), true);

    expect(await subject.store.list()).toEqual([]);
  });

  it("writes the entry without relying on a runner registration or a held runner (before any runner started, and while retained)", async () => {
    const withoutRegistration = await makeSubject({ respond: () => applied() });
    await withoutRegistration.transition.persistExecutorFinalState(
      makeTask({
        terminationEventRecorded: false,
        executionRegistration: undefined,
        terminalDedupeIdentity: undefined,
        completedAt: new Date("2026-11-14T00:05:00.000Z"),
      }),
      true,
      { settleCompletion: true },
    );
    expect(await withoutRegistration.store.list()).toEqual([
      expect.objectContaining({ registrationId: null, executionCommandId: null, dedupeKey: `session_terminal:${SESSION_ID}:completed_at:2026-11-14T00:05:00.000Z` }),
    ]);

    const retained = await makeSubject({ respond: () => applied() });
    await retained.transition.persistExecutorFinalState(
      makeTask({ terminationEventRecorded: false, runnerRetainedForDetachedWork: true, runner: {} as never }),
      true,
      { settleCompletion: true },
    );
    expect(await retained.store.list()).toHaveLength(1);
  });
});

describe("card #1266 U2b settlement: closing on the normal path", () => {
  it("keeps the entry when the registration must be redone and the next sweep registers it exactly once", async () => {
    const subject = await makeSubject({ respond: () => applied() });
    subject.repository.register.mockRejectedValueOnce(new Error("store unavailable"));
    const task = makeTask({ terminationEventRecorded: false });

    const result = await subject.transition.persistExecutorFinalState(task, true, { settleCompletion: true });
    const notified = await subject.transition.notifyCompletionIfApplied(task, result);

    expect(notified).toBe(false);
    expect(await subject.store.listUnheld()).toHaveLength(1);

    const outbox = makeOutbox();
    outbox.ackedSeq = 5;
    const sweeper = makeSweeper({
      store: subject.store, outbox, central: async () => centralRow(), notifier: subject.notifier,
    });
    await sweeper.sweepOnce();
    await sweeper.sweepOnce();

    expect(subject.rows.size).toBe(1);
    expect(await subject.store.list()).toEqual([]);
  });

  it.each([
    ["notifyCompletion is off", { notifyCompletion: false }],
    ["the caller is the session itself", { callerSessionId: SESSION_ID }],
  ])("closes the entry and sends nothing when %s", async (_name, overrides) => {
    const subject = await makeSubject({ respond: () => applied() });
    const task = makeTask({ terminationEventRecorded: false, ...overrides });

    const result = await subject.transition.persistExecutorFinalState(task, true, { settleCompletion: true });
    expect(await subject.store.list()).toHaveLength(1);
    await subject.transition.notifyCompletionIfApplied(task, result);

    expect(subject.repository.register).not.toHaveBeenCalled();
    expect(await subject.store.list()).toEqual([]);
  });

  it("closes the entry when the task has no caller at all", async () => {
    const subject = await makeSubject({ respond: () => applied() });
    const task = makeTask({ terminationEventRecorded: false, callerSessionId: undefined });

    const result = await subject.transition.persistExecutorFinalState(task, true, { settleCompletion: true });
    expect(await subject.store.list()).toHaveLength(1);
    await subject.transition.notifyCompletionIfApplied(task, result);

    expect(await subject.store.list()).toEqual([]);
  });

  it("closes the entry after the next generation continues and keeps it when only the settlement of the skip was never called", async () => {
    const subject = await makeSubject({ respond: () => applied() });
    const task = makeTask({ terminationEventRecorded: false });

    const result = await subject.transition.persistExecutorFinalState(task, true, { settleCompletion: true });
    expect(await subject.store.list()).toHaveLength(1);
    await subject.transition.settleSkippedCompletion(task, result);

    expect(await subject.store.list()).toEqual([]);
    expect(subject.repository.register).not.toHaveBeenCalled();
  });

  it("leaves a terminal that was not applied pending for the sweep without notifying", async () => {
    const subject = await makeSubject({ respond: () => ({ eventId: 9, applied: false, canonicalSession: canonical(null, "running"), canonicalExecutionRegistration: null }) });
    const task = makeTask({ terminationEventRecorded: false });

    const result = await subject.transition.persistExecutorFinalState(task, true, { settleCompletion: true });
    await subject.transition.notifyCompletionIfApplied(task, result);

    expect(result.terminalTransitionApplied).toBe(false);
    expect(subject.repository.register).not.toHaveBeenCalled();
    expect(await subject.store.listUnheld()).toHaveLength(1);
  });

  it("notifies a human stop as an ordinary completion and closes its entry", async () => {
    const subject = await makeSubject({
      respond: () => ({
        eventId: EVENT_ID,
        applied: true,
        canonicalSession: { ...canonical(EVENT_ID, "interrupted"), termination_reason: "killed", termination_detail: "user_stop" },
        canonicalExecutionRegistration: null,
      }),
    });
    const engine = { interrupt: vi.fn(async () => true), close: vi.fn(async () => {}) } as unknown as EnginePort;
    const task = activeTask({ runner: { engine, dispatcher: new InProcessRunnerCommandDispatcher(engine) } as never });

    await subject.transition.cancelRunningTask(task);

    expect(subject.repository.register).toHaveBeenCalledTimes(1);
    const registered = subject.repository.register.mock.calls[0]?.[0] as { payload: { text: string } };
    expect(registered.payload.text).toContain("사람이 멈춤");
    expect(await subject.store.list()).toEqual([]);
  });
});

describe("card #1266 U2b settlement: permanent rejection closes the settlement before the registration retires", () => {
  it("closes first, then retires the rejected registration, and sends no completion", async () => {
    const subject = await makeSubject({
      respond: () => { throw new EventOutboxDeadLetterError(8, "REPEATED_FAILURE", "2026-11-14T00:00:01.000Z", "repeated failure"); },
    });
    const task = makeTask({ terminationEventRecorded: false });

    const result = await subject.transition.persistExecutorFinalState(task, true, { settleCompletion: true });
    await subject.transition.notifyCompletionIfApplied(task, result);

    expect(subject.seen.atAppend[0]).toHaveLength(1);
    // 거절을 정리하는 안에서 닫기가 먼저고 그 뒤에 등록 은퇴다.
    expect(subject.order).toEqual(["close", "retire"]);
    expect(await subject.store.list()).toEqual([]);
    expect(subject.repository.register).not.toHaveBeenCalled();
  });

  it("closes without a delivery when the central session is gone", async () => {
    const subject = await makeSubject({
      respond: () => ({ eventId: 9, applied: false, canonicalSession: canonical(null, "running"), canonicalExecutionRegistration: null }),
      extraPorts: { readCentralSession: async () => null, releaseLocalOwnership: async () => {} },
    });
    const task = makeTask({ terminationEventRecorded: false });

    await subject.transition.persistExecutorFinalState(task, true, { settleCompletion: true });

    expect(subject.seen.atAppend[0]).toHaveLength(1);
    expect(subject.order).toContain("close");
    expect(await subject.store.list()).toEqual([]);
    expect(subject.repository.register).not.toHaveBeenCalled();
  });

  it("closes without a delivery when another terminal is already applied", async () => {
    const subject = await makeSubject({
      respond: () => ({ eventId: 9, applied: false, canonicalSession: canonical(5), canonicalExecutionRegistration: null }),
    });
    const task = makeTask({ terminationEventRecorded: false });

    const result = await subject.transition.persistExecutorFinalState(task, true, { settleCompletion: true });
    await subject.transition.notifyCompletionIfApplied(task, result);

    expect(subject.seen.atAppend[0]).toHaveLength(1);
    expect(await subject.store.list()).toEqual([]);
    expect(subject.repository.register).not.toHaveBeenCalled();
  });
});

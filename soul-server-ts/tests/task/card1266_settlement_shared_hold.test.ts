import { describe, expect, it, vi } from "vitest";

import type { CompletionSettlementStore } from "../../src/task/completion_settlement_store.js";
import { TaskLifecycleTransition } from "../../src/task/task_lifecycle_transition.js";
import type { Task } from "../../src/task/task_models.js";
import { TaskRunnerRecovery } from "../../src/task/task_runner_recovery.js";

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

/**
 * 카드 #1266 U2b. 종료 키는 task의 종료마다 고정이라, 진행 중인 사람의 멈춤과 실행 마무리
 * (task_executor의 finally가 멈춤을 기다리지 않고 _finalize를 부른다)가 같은 키로 함께 종료를
 * 올릴 수 있다. 아웃박스는 같은 키의 줄을 두 번 붙이고 두 길 모두 응답까지 간다. 한 길이 놓거나
 * 실패해도 다른 길의 쥠과 미결이 남아야 한다.
 */

const EVENT_ID = 41;

function applied() {
  return {
    eventId: EVENT_ID,
    applied: true,
    canonicalSession: {
      status: "completed",
      termination_reason: "completed_ok",
      termination_detail: null,
      review_state: "not_required",
      last_assistant_text: "child final answer",
      termination_event_id: EVENT_ID,
      updated_at: "2026-11-14T00:05:00.000Z",
      last_event_id: EVENT_ID,
    },
    canonicalExecutionRegistration: null,
  };
}

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

type OnAppended = (record: { stream_id: string; source_seq: number }) => Promise<void>;
type Step = (onAppended: OnAppended | undefined) => Promise<unknown>;

/** 부를 때마다 차례로 다음 단계를 쓰는 가짜 영속 계층이다. */
async function makeSubject(steps: Step[]) {
  const directory = await makeOutboxDirectory();
  const store = makeStore(directory);
  const rows = new Map<string, Record<string, unknown>>();
  const harness = makeNotifier(rows);
  const enqueue = vi.fn(async (...args: unknown[]) => await steps.shift()!(args[4] as OnAppended | undefined));
  const transition = new TaskLifecycleTransition({
    logger: silentLogger,
    persistence: { enqueueTerminalTransitionAndWaitForApplication: enqueue },
    completionNotifier: harness.notifier,
    settlement: store,
  } as never);
  return { directory, store, rows, transition, enqueue, ...harness };
}

function endingTask(overrides: Partial<Task> = {}): Task {
  return makeTask({ terminationEventRecorded: false, ...overrides });
}

async function sweepWith(store: CompletionSettlementStore, notifier: ReturnType<typeof makeNotifier>["notifier"]) {
  const outbox = makeOutbox();
  outbox.ackedSeq = 10;
  await makeSweeper({ store, outbox, central: async () => centralRow(), notifier }).sweepOnce();
}

describe("card #1266 U2b two paths raise the same terminal key at once", () => {
  it("keeps the other path's hold when the first path lets go, so the sweep does not register behind the path still waiting", async () => {
    const first = deferred();
    const second = deferred();
    const subject = await makeSubject([
      async (onAppended) => {
        await onAppended?.({ stream_id: "stream-1", source_seq: 5 });
        // 둘째 길이 같은 키로 올리기 시작할 때까지 응답이 오지 않는다.
        await first.promise;
        return applied();
      },
      async (onAppended) => {
        await second.promise;
        await onAppended?.({ stream_id: "stream-1", source_seq: 6 });
        return applied();
      },
    ]);
    const task = endingTask();
    // 마무리 길이 먼저 종료를 올리다 응답을 기다리고, 사람의 멈춤이 같은 키로 뒤따른다.
    const stopPath = (async () => {
      await vi.waitFor(() => expect(subject.enqueue).toHaveBeenCalledTimes(1));
      return await subject.transition.persistExecutorFinalState(task, true, { settleCompletion: true });
    })();
    const finalizePath = subject.transition.persistExecutorFinalState(task, true, { settleCompletion: true });
    await vi.waitFor(() => expect(subject.enqueue).toHaveBeenCalledTimes(2));
    first.resolve();
    const finalized = await finalizePath;

    // 마무리 길이 등록하지 못하고 쥠만 놓았다(마무리 단계의 finally).
    subject.transition.releaseSettlementHold(finalized);
    expect(subject.store.isSessionHeld(SESSION_ID)).toBe(true);
    await sweepWith(subject.store, subject.notifier);
    expect(subject.repository.register).not.toHaveBeenCalled();

    second.resolve();
    const stopped = await stopPath;
    await subject.transition.notifyCompletionIfApplied(task, stopped);
    subject.transition.releaseSettlementHold(stopped);

    expect(subject.repository.register).toHaveBeenCalledTimes(1);
    expect(subject.store.isSessionHeld(SESSION_ID)).toBe(false);
    expect(await subject.store.list()).toEqual([]);
  });

  it("does not delete the pending the other path still needs when the first path's append throws before writing", async () => {
    const firstMayFail = deferred();
    const second = deferred();
    const subject = await makeSubject([
      async () => {
        await firstMayFail.promise;
        throw new Error("disk full");
      },
      async (onAppended) => {
        await second.promise;
        await onAppended?.({ stream_id: "stream-1", source_seq: 6 });
        return applied();
      },
    ]);
    const task = endingTask();
    const firstPath = subject.transition.persistExecutorFinalState(task, true, { settleCompletion: true });
    const secondPath = (async () => {
      await vi.waitFor(() => expect(subject.enqueue).toHaveBeenCalledTimes(1));
      return await subject.transition.persistExecutorFinalState(task, true, { settleCompletion: true });
    })();
    await vi.waitFor(() => expect(subject.enqueue).toHaveBeenCalledTimes(2));

    firstMayFail.resolve();
    await expect(firstPath).rejects.toThrow("disk full");
    // 둘째 길이 아직 붙이지 않았어도 그 길의 미결은 남는다.
    expect(await subject.store.list()).toHaveLength(1);
    expect(subject.store.isSessionHeld(SESSION_ID)).toBe(true);

    second.resolve();
    const result = await secondPath;
    // 둘째 길이 붙인 좌표와 적용 번호가 덧붙는다(재시작해도 훑기가 이어 받는다).
    expect(await makeStore(subject.directory).list()).toEqual([
      expect.objectContaining({ dedupeKey: DEDUPE_KEY, sourceSeq: 6, terminationEventId: EVENT_ID }),
    ]);
    await subject.transition.notifyCompletionIfApplied(task, result);
    subject.transition.releaseSettlementHold(result);
    expect(subject.repository.register).toHaveBeenCalledTimes(1);
    expect(await subject.store.list()).toEqual([]);
  });

  it("keeps the pending while the other path holds when the first path settles, and removes it when the last path settles", async () => {
    const first = deferred();
    const second = deferred();
    const subject = await makeSubject([
      async (onAppended) => {
        await onAppended?.({ stream_id: "stream-1", source_seq: 5 });
        // 둘째 길이 같은 키로 올리기 시작할 때까지 응답이 오지 않는다.
        await first.promise;
        return applied();
      },
      async (onAppended) => {
        await second.promise;
        await onAppended?.({ stream_id: "stream-1", source_seq: 6 });
        return applied();
      },
    ]);
    const task = endingTask();
    const stopPath = (async () => {
      await vi.waitFor(() => expect(subject.enqueue).toHaveBeenCalledTimes(1));
      return await subject.transition.persistExecutorFinalState(task, true, { settleCompletion: true });
    })();
    const finalizePath = subject.transition.persistExecutorFinalState(task, true, { settleCompletion: true });
    await vi.waitFor(() => expect(subject.enqueue).toHaveBeenCalledTimes(2));
    first.resolve();
    const finalized = await finalizePath;

    await subject.transition.notifyCompletionIfApplied(task, finalized);
    subject.transition.releaseSettlementHold(finalized);
    expect(await subject.store.list()).toHaveLength(1);
    expect(subject.store.isSessionHeld(SESSION_ID)).toBe(true);

    second.resolve();
    const stopped = await stopPath;
    await subject.transition.notifyCompletionIfApplied(task, stopped);
    subject.transition.releaseSettlementHold(stopped);

    expect(await subject.store.list()).toEqual([]);
    expect(subject.store.isSessionHeld(SESSION_ID)).toBe(false);
    // 같은 종료의 관계 키라 두 번째 등록은 「이미 등록됨」이다.
    expect([...subject.rows.values()]).toHaveLength(1);
  });
});

describe("card #1266 U2b runner recovery lets go of the settlement hold even when the completion notice throws", () => {
  for (const route of ["markFailure", "projectClosed"] as const) {
    it(`${route} releases the hold in a finally`, async () => {
      const subject = await makeSubject([
        async (onAppended) => {
          await onAppended?.({ stream_id: "stream-1", source_seq: 5 });
          return applied();
        },
      ]);
      vi.spyOn(subject.transition, "notifyCompletionIfApplied")
        .mockRejectedValue(new Error("notice failed"));
      const task = endingTask({ status: "running", terminationReason: undefined, completedAt: undefined });
      const recovery = new TaskRunnerRecovery({
        getTask: () => task,
        loadTask: async () => task,
        rememberTask: () => undefined,
        lifecycleTransition: subject.transition,
        logger: silentLogger,
      });

      const run = route === "markFailure"
        ? recovery.markFailure(task, "runner exited")
        : recovery.projectClosed(task, "runner closed");
      await expect(run).rejects.toThrow("notice failed");

      // 미결은 남고 쥠만 풀려 훑기가 이어 받는다.
      expect(subject.store.isSessionHeld(SESSION_ID)).toBe(false);
      expect(await subject.store.listUnheld()).toHaveLength(1);
    });
  }
});

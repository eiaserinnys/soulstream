import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  ControlInboxRuntime,
  type ControlInboxDispatchWork,
} from "../../src/upstream/control_inbox_runtime.js";
import { ControlInboxStore } from "../../src/upstream/control_inbox_store.js";

/**
 * 카드 #1266 U5a 사: control 워커가 내구 작업을 끝낼 때 store.complete가 실패해도 삼키지 않는다.
 * 짧게 다시 해 보고, 그래도 안 되면 오류를 올리며 작업은 끝나지 않은 채로 남는다. 연결이 붙어 있으면
 * lease가 끝난 뒤 스스로 다시 집어 완료한다(다음 연결이나 명령을 기다리지 않는다). 다시 처리될 때
 * 도메인 효과가 되풀이되지 않는 것은 메인 스레드의 활성 작업 중복 막기(control_channel_service)가
 * 맡는다.
 */
const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) =>
    rm(root, { recursive: true, force: true })));
});

const LEASE_MS = 30_000;
const COMPLETE_RETRY_DELAYS = new Set([100, 400]);

type FakeTimer = { run: () => void; dueAt: number; cancelled: boolean };

async function setup(failures: { count: number }) {
  const clock = { now: 1_700_000_000_000 };
  // 재집기 타이머는 만기 시각과 함께 쥐어 손으로 돌리고, 완료 재시도의 짧은 지연은 곧바로 돌린다.
  const timers: FakeTimer[] = [];
  const root = await mkdtemp(join(tmpdir(), "card1266-u5a-control-"));
  roots.push(root);
  const store = new ControlInboxStore({
    databasePath: join(root, "_control", "control-inbox.sqlite"),
    nodeId: "node-a",
    hostGeneration: "host-a",
    nowMs: () => clock.now,
  });
  const originalComplete = store.complete.bind(store);
  let completeCalls = 0;
  store.complete = ((...args: Parameters<typeof store.complete>) => {
    completeCalls += 1;
    if (failures.count > 0) {
      failures.count -= 1;
      throw new Error("database is locked");
    }
    return originalComplete(...args);
  }) as typeof store.complete;
  const frames: Array<Record<string, unknown>> = [];
  const work: ControlInboxDispatchWork[] = [];
  const delays: number[] = [];
  const logs: string[] = [];
  const runtime = new ControlInboxRuntime({
    store,
    nodeId: "node-a",
    mainHeartbeatAgeMs: () => 0,
    postWork: (item) => work.push(item),
    nowEpochMs: () => clock.now,
    schedule: (callback, delayMs) => {
      delays.push(delayMs);
      if (COMPLETE_RETRY_DELAYS.has(delayMs)) {
        queueMicrotask(callback);
        return undefined;
      }
      const timer: FakeTimer = { run: callback, dueAt: clock.now + delayMs, cancelled: false };
      timers.push(timer);
      return timer;
    },
    clearScheduled: (handle) => {
      if (handle) (handle as FakeTimer).cancelled = true;
    },
    log: (message) => logs.push(message),
  });
  // 만기가 된 재집기 타이머를 다 돌린다(돌면서 새로 예약한 것도 만기가 됐으면 돌린다).
  const runDueTimers = () => {
    for (;;) {
      const due = timers.find((timer) => !timer.cancelled && timer.dueAt <= clock.now);
      if (!due) return;
      due.cancelled = true;
      due.run();
    }
  };
  const activeTimers = () => timers.filter((timer) => !timer.cancelled);
  runtime.initialize();
  await runtime.connect(async (frame) => { frames.push(frame); });
  const command = { type: "create_card_orchestration_decision", requestId: "req-1", agentSessionId: "s-1" };
  await runtime.handleCommand(command);
  expect(work).toHaveLength(1);
  return {
    runtime, store, frames, work, delays, logs, clock, timers, runDueTimers, activeTimers, command,
    calls: () => completeCalls,
  };
}

describe("card #1266 U5a 사: durable control work completion failures are not swallowed", () => {
  it("tries the completion again and delivers the result when the second try succeeds", async () => {
    const subject = await setup({ count: 1 });

    await expect(
      subject.runtime.handleDomainResult(subject.work[0]!.workId, { type: "session_created", status: "ready" }),
    ).resolves.toBe(true);

    expect(subject.calls()).toBe(2);
    expect(subject.delays).toEqual([100]);
    expect(subject.logs).toContain("control inbox completion failed; retrying");
    expect(subject.frames).toContainEqual(expect.objectContaining({ type: "control_result", requestId: "req-1" }));
    expect(subject.store.listReplayableResults()).toHaveLength(1);
    subject.runtime.close();
  });

  it("raises the error after the last try, keeps the work open, and picks it up again by itself after the lease ends", async () => {
    const subject = await setup({ count: 99 });
    const workId = subject.work[0]!.workId;

    await expect(
      subject.runtime.handleDomainResult(workId, { type: "session_created", status: "ready" }),
    ).rejects.toThrow("database is locked");

    expect(subject.calls()).toBe(3);
    expect(subject.delays).toEqual([100, 400, LEASE_MS]);
    expect(subject.frames.filter((frame) => frame.type === "control_result")).toEqual([]);
    expect(subject.store.listReplayableResults()).toEqual([]);
    expect(subject.timers).toHaveLength(1);

    // lease가 끝나면 연결이 붙은 채로 스스로 같은 작업을 다시 집는다. 새 명령이나 재연결 없이.
    (subject.store as unknown as { complete: unknown }).complete =
      ControlInboxStore.prototype.complete.bind(subject.store);
    subject.clock.now += LEASE_MS + 1;
    subject.runDueTimers();
    expect(subject.work).toHaveLength(2);
    expect(subject.work[1]!.workId).toBe(workId);
    // 다시 집힌 작업은 새 lease를 받으므로 다음 예약도 그 lease에 맞춘다(그 사이 1초마다 헛돌지 않는다).
    expect(subject.activeTimers().map((timer) => timer.dueAt)).toEqual([subject.clock.now + LEASE_MS]);

    // 메인 스레드가 같은 작업 번호의 결과를 다시 보내면 완료된다. 도메인 실행은 다시 하지 않는다.
    await expect(
      subject.runtime.handleDomainResult(workId, { type: "session_created", status: "ready" }),
    ).resolves.toBe(true);
    expect(subject.store.listReplayableResults()).toHaveLength(1);
    expect(subject.frames).toContainEqual(expect.objectContaining({ type: "control_result", requestId: "req-1" }));
    subject.runtime.close();
  });

  it("does not pick the work up before the lease has ended", async () => {
    const subject = await setup({ count: 99 });
    const workId = subject.work[0]!.workId;
    await expect(
      subject.runtime.handleDomainResult(workId, { type: "session_created", status: "ready" }),
    ).rejects.toThrow("database is locked");

    subject.clock.now += LEASE_MS - 1_000;
    subject.timers[0]!.run();

    expect(subject.work).toHaveLength(1);
    subject.runtime.close();
  });

  it("schedules no pick-up while disconnected; the next connect picks the expired work up", async () => {
    const subject = await setup({ count: 99 });
    const workId = subject.work[0]!.workId;
    subject.runtime.disconnect();
    await expect(
      subject.runtime.handleDomainResult(workId, { type: "session_created", status: "ready" }),
    ).rejects.toThrow("database is locked");
    expect(subject.timers).toHaveLength(0);

    subject.clock.now += LEASE_MS + 1;
    await subject.runtime.connect(async () => {});

    expect(subject.work).toHaveLength(2);
    expect(subject.work[1]!.workId).toBe(workId);
    subject.runtime.close();
  });
  it("keeps re-arming for a second uncommitted work whose lease ends later, after the first work completes", async () => {
    // 첫 작업과 둘째 작업 모두 완료를 적지 못한다(각각 세 번).
    const subject = await setup({ count: 6 });
    const firstWorkId = subject.work[0]!.workId;
    await expect(
      subject.runtime.handleDomainResult(firstWorkId, { type: "session_created", status: "ready" }),
    ).rejects.toThrow("database is locked");

    // 둘째 작업은 10초 뒤에 집혀 lease가 첫 작업보다 10초 늦게 끝난다.
    subject.clock.now += 10_000;
    await subject.runtime.handleCommand({
      type: "create_card_orchestration_decision", requestId: "req-2", agentSessionId: "s-2",
    });
    expect(subject.work).toHaveLength(2);
    const secondWorkId = subject.work[1]!.workId;
    await expect(
      subject.runtime.handleDomainResult(secondWorkId, { type: "session_created", status: "ready" }),
    ).rejects.toThrow("database is locked");

    // 첫 작업의 lease만 끝난 때. 다시 집힌 것이 있으면 메인 스레드처럼 결과를 다시 보낸다.
    const redispatched = async () => {
      for (const item of subject.work.splice(2)) {
        await subject.runtime.handleDomainResult(item.workId, { type: "session_created", status: "ready" });
      }
    };
    subject.clock.now += LEASE_MS - 10_000 + 1;
    subject.runDueTimers();
    await redispatched();

    // 둘째 작업의 lease가 끝난 때. 새 명령이나 재연결 없이 둘째 작업도 다시 집혀 완료된다.
    subject.clock.now += 10_000;
    subject.runDueTimers();
    await redispatched();

    const results = subject.store.listReplayableResults().map((result) => result.requestId).sort();
    expect(results).toEqual(["req-1", "req-2"]);
    expect(subject.activeTimers()).toEqual([]);
    subject.runtime.close();
  });

  it("logs and re-arms when picking the work up fails, without throwing out of the timer", async () => {
    const subject = await setup({ count: 3 });
    const workId = subject.work[0]!.workId;
    await expect(
      subject.runtime.handleDomainResult(workId, { type: "session_created", status: "ready" }),
    ).rejects.toThrow("database is locked");

    // lease가 끝났을 때 데이터베이스가 아직 바빠 다시 집기가 한 번 던진다.
    const originalReclaim = subject.store.reclaimExpired.bind(subject.store);
    let reclaimFailures = 1;
    subject.store.reclaimExpired = () => {
      if (reclaimFailures > 0) {
        reclaimFailures -= 1;
        throw new Error("database is locked");
      }
      return originalReclaim();
    };
    subject.clock.now += LEASE_MS + 1;
    expect(() => subject.runDueTimers()).not.toThrow();
    expect(subject.logs).toContain("control inbox redispatch failed; rescheduling");
    expect(subject.work).toHaveLength(1);
    expect(subject.activeTimers()).toHaveLength(1);

    // 다시 예약한 때가 오면 같은 작업을 다시 집는다.
    subject.clock.now = subject.activeTimers()[0]!.dueAt;
    subject.runDueTimers();
    expect(subject.work).toHaveLength(2);
    expect(subject.work[1]!.workId).toBe(workId);
    await expect(
      subject.runtime.handleDomainResult(workId, { type: "session_created", status: "ready" }),
    ).resolves.toBe(true);
    expect(subject.store.listReplayableResults()).toHaveLength(1);
    expect(subject.activeTimers()).toEqual([]);
    subject.runtime.close();
  });

  it("does not spin while disconnected: a due timer neither picks up nor re-arms until the next connect", async () => {
    const subject = await setup({ count: 3 });
    const workId = subject.work[0]!.workId;
    await expect(
      subject.runtime.handleDomainResult(workId, { type: "session_created", status: "ready" }),
    ).rejects.toThrow("database is locked");
    subject.runtime.disconnect();

    subject.clock.now += LEASE_MS + 1;
    subject.runDueTimers();
    expect(subject.work).toHaveLength(1);
    expect(subject.activeTimers()).toEqual([]);

    await subject.runtime.connect(async () => {});
    expect(subject.work).toHaveLength(2);
    expect(subject.work[1]!.workId).toBe(workId);
    subject.runtime.close();
  });
  it("re-arms on reconnect for work that failed to complete while disconnected, before its lease ends", async () => {
    const subject = await setup({ count: 3 });
    const workId = subject.work[0]!.workId;
    subject.runtime.disconnect();
    await expect(
      subject.runtime.handleDomainResult(workId, { type: "session_created", status: "ready" }),
    ).rejects.toThrow("database is locked");
    expect(subject.activeTimers()).toEqual([]);

    // lease가 끝나기 전에 다시 붙는다. 그 자리에서는 집을 것이 없지만 lease에 맞춰 예약한다.
    subject.clock.now += 5_000;
    await subject.runtime.connect(async () => {});
    expect(subject.work).toHaveLength(1);
    expect(subject.activeTimers()).toHaveLength(1);

    subject.clock.now += LEASE_MS;
    subject.runDueTimers();
    expect(subject.work).toHaveLength(2);
    expect(subject.work[1]!.workId).toBe(workId);
    subject.runtime.close();
  });

  it("stops re-arming for an entry whose row this node no longer holds", async () => {
    const subject = await setup({ count: 0 });
    const workId = subject.work[0]!.workId;
    await expect(
      subject.runtime.handleDomainResult(workId, { type: "session_created", status: "ready" }),
    ).resolves.toBe(true);

    // 이미 완료된 작업에 늦게 온 중복 결과처럼, 완료를 적지 못했지만 장부에서 다시 집을 줄이 없는 기록이다.
    const redispatch = (subject.runtime as unknown as {
      uncommitted: { markFailed(id: string, leaseExpiresAt: number): void };
    }).uncommitted;
    redispatch.markFailed(workId, subject.clock.now - 1);
    expect(subject.activeTimers()).toHaveLength(1);

    subject.clock.now = subject.activeTimers()[0]!.dueAt;
    subject.runDueTimers();
    expect(subject.work).toHaveLength(1);
    expect(subject.activeTimers()).toEqual([]);
    subject.runtime.close();
  });
});

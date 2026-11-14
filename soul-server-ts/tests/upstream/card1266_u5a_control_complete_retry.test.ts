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
 * 짧게 다시 해 보고, 그래도 안 되면 오류를 올리며 작업은 끝나지 않은 채로 남는다. 다시 처리될
 * 때 도메인 효과가 되풀이되지 않는 것은 메인 스레드의 활성 작업 중복 막기(control_channel_service)가
 * 맡는다.
 */
const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) =>
    rm(root, { recursive: true, force: true })));
});

async function setup(failures: { count: number }) {
  const root = await mkdtemp(join(tmpdir(), "card1266-u5a-control-"));
  roots.push(root);
  const store = new ControlInboxStore({
    databasePath: join(root, "_control", "control-inbox.sqlite"),
    nodeId: "node-a",
    hostGeneration: "host-a",
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
    // 기다림 없이 곧바로 돌려 지연 값만 기록한다.
    schedule: (callback, delayMs) => { delays.push(delayMs); queueMicrotask(callback); return delays.length; },
    clearScheduled: () => {},
    log: (message) => logs.push(message),
  });
  runtime.initialize();
  await runtime.connect(async (frame) => { frames.push(frame); });
  const command = { type: "create_card_orchestration_decision", requestId: "req-1", agentSessionId: "s-1" };
  await runtime.handleCommand(command);
  expect(work).toHaveLength(1);
  return { runtime, store, frames, work, delays, logs, calls: () => completeCalls };
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

  it("raises the error after the last try and keeps the work open instead of dropping it", async () => {
    const subject = await setup({ count: 99 });
    const workId = subject.work[0]!.workId;

    await expect(
      subject.runtime.handleDomainResult(workId, { type: "session_created", status: "ready" }),
    ).rejects.toThrow("database is locked");

    expect(subject.calls()).toBe(3);
    expect(subject.delays).toEqual([100, 400]);
    expect(subject.frames.filter((frame) => frame.type === "control_result")).toEqual([]);
    expect(subject.store.listReplayableResults()).toEqual([]);

    // 같은 작업 번호로 다시 온 결과는 아직 열린 작업으로 완료된다. 도메인 실행은 다시 하지 않는다.
    expect(subject.work).toHaveLength(1);
    (subject.store as unknown as { complete: unknown }).complete =
      ControlInboxStore.prototype.complete.bind(subject.store);
    await expect(
      subject.runtime.handleDomainResult(workId, { type: "session_created", status: "ready" }),
    ).resolves.toBe(true);
    expect(subject.store.listReplayableResults()).toHaveLength(1);
    subject.runtime.close();
  });
});

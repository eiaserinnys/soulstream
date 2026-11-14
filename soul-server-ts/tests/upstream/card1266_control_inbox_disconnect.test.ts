import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  ControlInboxRuntime,
  type ControlInboxDispatchWork,
} from "../../src/upstream/control_inbox_runtime.js";
import { ControlInboxStore } from "../../src/upstream/control_inbox_store.js";

/**
 * 카드 #1266 U6 결함 2. control 연결이 끊긴 뒤 bounded 작업의 제한 시간이 만료되거나 일회성
 * 결과가 늦게 끝나면 보낼 곳이 없어 던졌고, 워커 스레드의 처리되지 않은 rejection으로 워커가
 * 죽었다(2026-11-13 22:40 노드 로그 code=1). 연결이 없을 때 그 응답은 버리고(로그 한 줄)
 * 워커는 살아야 하며, 재연결 뒤 다음 명령은 정상 처리된다.
 */

const roots: string[] = [];
const unhandled: unknown[] = [];
const onUnhandled = (reason: unknown): void => { unhandled.push(reason); };

afterEach(async () => {
  process.off("unhandledRejection", onUnhandled);
  unhandled.length = 0;
  await Promise.all(roots.splice(0).map((root) =>
    rm(root, { recursive: true, force: true })));
});

async function makeStore(): Promise<ControlInboxStore> {
  const root = await mkdtemp(join(tmpdir(), "card1266-control-"));
  roots.push(root);
  return new ControlInboxStore({
    databasePath: join(root, "_control", "control-inbox.sqlite"),
    nodeId: "node-a",
    hostGeneration: "host-a",
  });
}

async function setup() {
  process.on("unhandledRejection", onUnhandled);
  const frames: Array<Record<string, unknown>> = [];
  const work: ControlInboxDispatchWork[] = [];
  const timers: Array<() => void> = [];
  const logs: Array<{ message: string; fields: Record<string, unknown> }> = [];
  const store = await makeStore();
  const runtime = new ControlInboxRuntime({
    store,
    nodeId: "node-a",
    mainHeartbeatAgeMs: () => 0,
    postWork: (item) => work.push(item),
    schedule: (callback) => { timers.push(callback); return timers.length - 1; },
    clearScheduled: () => {},
    log: (message, fields) => logs.push({ message, fields }),
  });
  runtime.initialize();
  const send = async (frame: Record<string, unknown>) => { frames.push(frame); };
  await runtime.connect(send);
  return { runtime, store, frames, work, timers, logs, send };
}

// 처리되지 않은 rejection은 이벤트 루프가 한 바퀴 돌아야 보고된다.
async function settleRejections(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 20));
}

describe("card #1266 U6 control worker survives a lost connection", () => {
  it("drops an expired bounded deadline when the connection is gone and still serves the next command", async () => {
    const { runtime, store, frames, work, timers, logs, send } = await setup();
    await runtime.handleCommand({ type: "list_sessions", requestId: "req-1" });
    runtime.disconnect();

    timers[0]!();
    await settleRejections();

    expect(unhandled).toEqual([]);
    expect(frames.filter((frame) => frame.code === "CONTROL_RESULT_TIMEOUT")).toEqual([]);
    expect(logs).toHaveLength(1);

    // 재연결 뒤 다음 명령을 정상 처리한다.
    await runtime.connect(send);
    await runtime.handleCommand({ type: "list_sessions", requestId: "req-2" });
    expect(work).toHaveLength(2);
    await runtime.handleDomainResult(work[1]!.workId, { type: "sessions_list", sessions: [] });
    expect(frames).toContainEqual(expect.objectContaining({
      type: "sessions_list",
      requestId: "req-2",
    }));
    store.close();
  });

  it("drops a one-shot result that finishes after the connection is gone", async () => {
    const { runtime, store, frames, work, logs } = await setup();
    await runtime.handleCommand({ type: "list_sessions", requestId: "req-1" });
    runtime.disconnect();

    await expect(runtime.handleDomainResult(work[0]!.workId, {
      type: "sessions_list",
      sessions: [],
    })).resolves.toBe(true);
    await expect(runtime.handleDomainFailure(work[0]!.workId, new Error("late")))
      .resolves.toBe(false);
    await settleRejections();

    expect(unhandled).toEqual([]);
    expect(frames.filter((frame) => frame.requestId === "req-1")).toEqual([]);
    expect(logs).toHaveLength(1);
    store.close();
  });

  it("drops a reply whose send fails because the socket closed mid-send", async () => {
    const { runtime, store, work, timers, logs } = await setup();
    await runtime.handleCommand({ type: "list_sessions", requestId: "req-1" });
    await runtime.handleCommand({ type: "list_sessions", requestId: "req-2" });
    await runtime.connect(async () => { throw new Error("Control WebSocket is not open"); });

    timers[0]!();
    await expect(runtime.handleDomainResult(work[1]!.workId, {
      type: "sessions_list",
      sessions: [],
    })).resolves.toBe(true);
    await settleRejections();

    expect(unhandled).toEqual([]);
    expect(logs).toHaveLength(2);
    store.close();
  });
});

describe("card #1266 U6 control service relays the worker's drop log", () => {
  it("logs a control_worker_log message at the worker's level", async () => {
    const { ControlChannelService } = await import("../../src/upstream/control_channel_service.js");
    let listener: ((message: unknown) => void) | undefined;
    const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    const service = new ControlChannelService({
      nodeId: "node-a",
      upstreamUrl: "ws://127.0.0.1/ws/node",
      authBearerToken: "",
      runnerStateDir: "/tmp/control-service-test",
      logger: logger as never,
      dispatchCommand: vi.fn(),
      workerFactory: () => ({
        postMessage: () => {},
        on: (event: string, callback: (value: never) => void) => {
          if (event === "message") listener = callback as (message: unknown) => void;
        },
        terminate: async () => 0,
      }) as never,
    });
    service.start();

    listener!({
      type: "control_worker_log",
      level: "warn",
      message: "control reply dropped: control channel is not connected",
      fields: { kind: "bounded_timeout", requestId: "req-1" },
    });

    expect(logger.warn).toHaveBeenCalledWith(
      { kind: "bounded_timeout", requestId: "req-1" },
      "control reply dropped: control channel is not connected",
    );
    await service.shutdown();
  });
});

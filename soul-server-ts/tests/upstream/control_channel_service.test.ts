import pino from "pino";
import { describe, expect, it, vi } from "vitest";

import {
  ControlChannelService,
  type ControlWorkerBoundary,
  type ControlWorkerMessage,
} from "../../src/upstream/control_channel_service.js";
import type { ControlInboxDispatchWork } from "../../src/upstream/control_inbox_runtime.js";

describe("ControlChannelService IPC fence", () => {
  it("replays an uncommitted terminal result to a replacement worker without repeating mutation", async () => {
    const workers: FakeControlWorker[] = [];
    const dispatchCommand = vi.fn(async () => {
      await service.sendActiveResult({
        type: "intervene_ack",
        requestId: "req-1",
        status: "ok",
      });
    });
    const service = new ControlChannelService({
      nodeId: "node-a",
      upstreamUrl: "ws://127.0.0.1/ws/node",
      authBearerToken: "",
      runnerStateDir: "/tmp/control-service-test",
      logger: pino({ level: "silent" }),
      dispatchCommand,
      workerFactory: () => {
        const worker = new FakeControlWorker();
        workers.push(worker);
        return worker as unknown as ControlWorkerBoundary;
      },
    });
    service.start();
    service.activate("node-a:1");
    const work = durableWork();

    workers[0]!.emitMessage({ type: "control_work", work });
    await waitFor(() => workers[0]!.posted.some(isDomainResult));
    expect(dispatchCommand).toHaveBeenCalledTimes(1);

    workers[0]!.emitExit(1);
    await waitFor(() => workers.length === 2);
    workers[1]!.emitMessage({ type: "control_work", work });
    await waitFor(() => workers[1]!.posted.some(isDomainResult));

    expect(dispatchCommand).toHaveBeenCalledTimes(1);
    expect(workers[1]!.posted).toContainEqual(expect.objectContaining({
      type: "control_domain_result",
      workId: work.workId,
      response: expect.objectContaining({ requestId: "req-1" }),
    }));

    workers[1]!.emitMessage({
      type: "control_domain_committed",
      workId: work.workId,
    });
    await service.shutdown();
  });
});

class FakeControlWorker {
  readonly posted: unknown[] = [];
  private messageListeners: Array<(message: ControlWorkerMessage) => void> = [];
  private exitListeners: Array<(code: number) => void> = [];

  postMessage(message: unknown): void {
    this.posted.push(message);
  }

  on(event: string, listener: (value: never) => void): void {
    if (event === "message") {
      this.messageListeners.push(listener as (message: ControlWorkerMessage) => void);
    } else if (event === "exit") {
      this.exitListeners.push(listener as (code: number) => void);
    }
  }

  emitMessage(message: ControlWorkerMessage): void {
    for (const listener of this.messageListeners) listener(message);
  }

  emitExit(code: number): void {
    for (const listener of this.exitListeners) listener(code);
  }

  async terminate(): Promise<number> {
    return 0;
  }
}

function durableWork(): ControlInboxDispatchWork {
  return {
    workId: "durable:node-a:intervention:req-1:hash",
    command: {
      type: "intervene",
      requestId: "req-1",
      agentSessionId: "session-a",
      text: "stop",
    },
    commandFamily: "intervention",
    durable: true,
  };
}

function isDomainResult(value: unknown): boolean {
  return Boolean(value && typeof value === "object"
    && (value as Record<string, unknown>).type === "control_domain_result");
}

async function waitFor(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 1_000;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("condition timeout");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

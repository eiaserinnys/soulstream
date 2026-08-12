import { describe, expect, it, vi } from "vitest";
import type { Logger } from "pino";
import type { WebSocket } from "ws";

import { CommandTransportObserver } from "../src/upstream/command_transport_observer.js";

describe("CommandTransportObserver", () => {
  it("logs receive-to-send latency and WebSocket pressure for a correlated response", async () => {
    const logger = { debug: vi.fn(), warn: vi.fn() } as unknown as Logger;
    const timestamps = [10, 11, 35];
    const nowMs = vi.fn(() => timestamps.shift() ?? 35);
    const socket = {
      bufferedAmount: 12,
      send: vi.fn((_data: unknown, callback: (err?: Error) => void) => {
        socket.bufferedAmount = 3;
        callback();
      }),
    } as unknown as WebSocket;
    const observer = new CommandTransportObserver(logger, nowMs);

    await observer.observe(
      {
        type: "create_session",
        requestId: "req-create",
        agentSessionId: "sess-create",
      },
      async () => {
        await observer.send(socket, {
          type: "session_created",
          requestId: "req-create",
        });
      },
    );

    expect(logger.debug).toHaveBeenNthCalledWith(
      1,
      {
        type: "create_session",
        requestId: "req-create",
        sessionId: "sess-create",
      },
      "Upstream command received",
    );
    expect(logger.debug).toHaveBeenNthCalledWith(
      2,
      {
        type: "create_session",
        requestId: "req-create",
        sessionId: "sess-create",
        responseType: "session_created",
        durationMs: 25,
        slowThresholdMs: 1_000,
        webSocketSendElapsedMs: 24,
        payloadBytes: Buffer.byteLength(
          JSON.stringify({ type: "session_created", requestId: "req-create" }),
        ),
        webSocketBufferedAmountBefore: 12,
        webSocketBufferedAmountAfter: 3,
      },
      "Upstream command response sent",
    );
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it("warns when a correlated response reaches the operational latency threshold", async () => {
    const logger = { debug: vi.fn(), warn: vi.fn() } as unknown as Logger;
    const timestamps = [0, 1, 1_000];
    const nowMs = vi.fn(() => timestamps.shift() ?? 1_000);
    const socket = {
      bufferedAmount: 128,
      send: vi.fn((_data: unknown, callback: (err?: Error) => void) => callback()),
    } as unknown as WebSocket;
    const observer = new CommandTransportObserver(logger, nowMs);

    await observer.observe(
      { type: "create_session", requestId: "req-slow" },
      async () => await observer.send(socket, {
        type: "session_created",
        requestId: "req-slow",
      }),
    );

    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "create_session",
        requestId: "req-slow",
        responseType: "session_created",
        durationMs: 1_000,
        slowThresholdMs: 1_000,
        webSocketBufferedAmountBefore: 128,
      }),
      "Slow upstream command response sent",
    );
  });

  it("warns while a correlated command remains pending without a response", async () => {
    vi.useFakeTimers();
    try {
      const logger = { debug: vi.fn(), warn: vi.fn() } as unknown as Logger;
      const timestamps = [0, 1_000];
      const nowMs = vi.fn(() => timestamps.shift() ?? 1_000);
      const pending = deferred<void>();
      const observer = new CommandTransportObserver(logger, nowMs);

      const observation = observer.observe(
        { type: "create_session", requestId: "req-pending" },
        async () => await pending.promise,
      );
      await vi.advanceTimersByTimeAsync(1_000);

      expect(logger.warn).toHaveBeenCalledWith(
        expect.objectContaining({
          type: "create_session",
          requestId: "req-pending",
          durationMs: 1_000,
          slowThresholdMs: 1_000,
        }),
        "Upstream command response pending",
      );
      pending.resolve();
      await observation;
    } finally {
      vi.useRealTimers();
    }
  });

  it("warns when a correlated command completes without sending a response", async () => {
    const logger = { debug: vi.fn(), warn: vi.fn() } as unknown as Logger;
    const timestamps = [0, 5];
    const nowMs = vi.fn(() => timestamps.shift() ?? 5);
    const observer = new CommandTransportObserver(logger, nowMs);

    await observer.observe(
      { type: "create_session", requestId: "req-missing" },
      async () => {},
    );

    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "create_session",
        requestId: "req-missing",
        durationMs: 5,
        slowThresholdMs: 1_000,
      }),
      "Upstream command completed without response",
    );
  });

  it("does not warn for an explicitly fire-and-forget correlated command", async () => {
    const logger = { debug: vi.fn(), warn: vi.fn() } as unknown as Logger;
    const observer = new CommandTransportObserver(logger, () => 0);

    await observer.observe(
      { type: "subscribe_events", requestId: "req-subscribe" },
      async () => {},
      false,
    );

    expect(logger.warn).not.toHaveBeenCalled();
  });

  it("does not mislabel non-command sends as command responses", async () => {
    const logger = { debug: vi.fn(), warn: vi.fn() } as unknown as Logger;
    const socket = {
      bufferedAmount: 0,
      send: vi.fn((_data: unknown, callback: (err?: Error) => void) => callback()),
    } as unknown as WebSocket;
    const observer = new CommandTransportObserver(logger, () => 1);

    await observer.send(socket, { type: "event_append" });

    expect(socket.send).toHaveBeenCalledOnce();
    expect(logger.debug).not.toHaveBeenCalled();
    expect(logger.warn).not.toHaveBeenCalled();
  });
});

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

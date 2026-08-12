import { describe, expect, it, vi } from "vitest";
import type { Logger } from "pino";
import type { WebSocket } from "ws";

import { CommandTransportObserver } from "../src/upstream/command_transport_observer.js";

describe("CommandTransportObserver", () => {
  it("logs receive-to-send latency and WebSocket pressure for a correlated response", async () => {
    const logger = { debug: vi.fn() } as unknown as Logger;
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
        elapsedMs: 25,
        webSocketSendElapsedMs: 24,
        payloadBytes: Buffer.byteLength(
          JSON.stringify({ type: "session_created", requestId: "req-create" }),
        ),
        webSocketBufferedAmountBefore: 12,
        webSocketBufferedAmountAfter: 3,
      },
      "Upstream command response sent",
    );
  });

  it("does not mislabel non-command sends as command responses", async () => {
    const logger = { debug: vi.fn() } as unknown as Logger;
    const socket = {
      bufferedAmount: 0,
      send: vi.fn((_data: unknown, callback: (err?: Error) => void) => callback()),
    } as unknown as WebSocket;
    const observer = new CommandTransportObserver(logger, () => 1);

    await observer.send(socket, { type: "event_append" });

    expect(socket.send).toHaveBeenCalledOnce();
    expect(logger.debug).not.toHaveBeenCalled();
  });
});

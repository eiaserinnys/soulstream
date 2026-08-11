import { createServer, connect, type Socket } from "node:net";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  RUNNER_FRAME_PROTOCOL_VERSION,
  prepareSessionCommandFrame,
  runnerControlResponseFrame,
  runnerCommandResultFrame,
} from "../../src/runner/frame_protocol.js";
import {
  RunnerIpcConnection,
} from "../../src/runner/runner_ipc_connection.js";
import { RunnerHostRequestClient } from
  "../../src/runner/runner_host_request_client.js";

const sockets: Socket[] = [];

afterEach(() => {
  for (const socket of sockets.splice(0)) socket.destroy();
});

describe("RunnerIpcConnection", () => {
  it("round-trips commandId-correlated ACK frames over a newline JSON socket", async () => {
    const [host, runner] = await socketPair();
    const hostConnection = new RunnerIpcConnection(host);
    const runnerConnection = new RunnerIpcConnection(runner);
    runnerConnection.onFrame(async (frame) => {
      if (frame.channel === "command") {
        await runnerConnection.send(runnerCommandResultFrame(frame.commandId, { status: "ok" }));
      }
    });

    await expect(hostConnection.request(
      prepareSessionCommandFrame("prepare-1", "session-1"),
      { timeoutMs: 1_000 },
    )).resolves.toMatchObject({ commandId: "prepare-1", result: { status: "ok" } });
    expect(hostConnection.pendingRequestCount).toBe(0);
  });

  it.each(["timeout", "abort", "close"])(
    "clears unanswered correlation state on %s",
    async (mode) => {
      const [host, runner] = await socketPair();
      const hostConnection = new RunnerIpcConnection(host);
      const controller = new AbortController();
      const pending = hostConnection.request(
        prepareSessionCommandFrame(`prepare-${mode}`, "session-1"),
        { signal: controller.signal, timeoutMs: mode === "timeout" ? 10 : 1_000 },
      );
      void pending.catch(() => {});
      await vi.waitFor(() => expect(hostConnection.pendingRequestCount).toBe(1));

      if (mode === "abort") controller.abort(new Error("cancelled"));
      if (mode === "close") runner.destroy();

      await expect(pending).rejects.toThrow(
        mode === "timeout" ? "timed out" : mode === "abort" ? "cancelled" : "closed",
      );
      expect(hostConnection.pendingRequestCount).toBe(0);
    },
  );

  it("rejects non-frame JSON before it reaches the handler", async () => {
    const [host, runner] = await socketPair();
    const failure = vi.fn();
    const connection = new RunnerIpcConnection(host);
    connection.onFailure(failure);

    runner.write(`${JSON.stringify({ protocolVersion: RUNNER_FRAME_PROTOCOL_VERSION })}\n`);

    await vi.waitFor(() => expect(failure).toHaveBeenCalledOnce());
    expect(failure.mock.calls[0]?.[0]).toMatchObject({ message: "Invalid runner IPC frame" });
  });

  it("strips deep undefined from observations before emission", async () => {
    const [host, runner] = await socketPair();
    const observed: unknown[] = [];
    const hostConnection = new RunnerIpcConnection(host);
    const runnerConnection = new RunnerIpcConnection(runner);
    hostConnection.onFrame(async (frame) => {
      if (frame.kind !== "request") return;
      observed.push(frame.request);
      await hostConnection.send(runnerControlResponseFrame(frame.correlationId, {
        status: "ok",
        data: true,
      }));
    });
    const client = new RunnerHostRequestClient(() => runnerConnection);

    await expect(client.call(
      "claude_runtime",
      "observe",
      ["session-1", { type: "rate_limit", nested: { utilization: undefined }, values: [undefined] }],
      { timeoutMs: 1_000 },
    )).resolves.toBe(true);

    expect(observed).toEqual([{
      kind: "host_call",
      service: "claude_runtime",
      operation: "observe",
      args: ["session-1", { type: "rate_limit", nested: {}, values: [null] }],
    }]);
  });

  it("drops an invalid observation, logs it, and keeps the next strict request alive", async () => {
    const [host, runner] = await socketPair();
    const dropped = vi.fn();
    const hostConnection = new RunnerIpcConnection(host);
    const runnerConnection = new RunnerIpcConnection(runner, { onFrameDropped: dropped });
    hostConnection.onFrame(async (frame) => {
      if (frame.kind !== "request") return;
      await hostConnection.send(runnerControlResponseFrame(frame.correlationId, {
        status: "ok",
        data: [],
      }));
    });
    const client = new RunnerHostRequestClient(() => runnerConnection);

    await expect(client.call(
      "claude_runtime",
      "observe",
      ["session-1", { type: "rate_limit", invalid: () => "not-json" }],
      { timeoutMs: 1_000 },
    )).resolves.toBe(true);
    expect(dropped).toHaveBeenCalledOnce();
    expect(dropped.mock.calls[0]?.[0]).toMatchObject({
      channel: "event",
      kind: "request",
      service: "claude_runtime",
      operation: "observe",
      error: expect.any(Error),
    });
    expect(runnerConnection.pendingRequestCount).toBe(0);

    await expect(client.call(
      "session_store",
      "load",
      [{ projectKey: "project", sessionId: "session-1" }],
      { timeoutMs: 1_000 },
    )).resolves.toEqual([]);
    expect(runnerConnection.pendingRequestCount).toBe(0);
  });

  it("drops an invalid engine event without closing the IPC connection", async () => {
    const [host, runner] = await socketPair();
    const dropped = vi.fn();
    const received: unknown[] = [];
    const hostConnection = new RunnerIpcConnection(host);
    const runnerConnection = new RunnerIpcConnection(runner, { onFrameDropped: dropped });
    hostConnection.onFrame(async (frame) => {
      received.push(frame);
    });

    await expect(runnerConnection.send({
      protocolVersion: RUNNER_FRAME_PROTOCOL_VERSION,
      channel: "event",
      kind: "engine_event",
      payload: { type: "debug", invalid: Symbol("process-local") },
    } as never)).resolves.toBe(false);
    await expect(runnerConnection.send({
      protocolVersion: RUNNER_FRAME_PROTOCOL_VERSION,
      channel: "event",
      kind: "engine_event",
      payload: { type: "debug", message: "still alive" },
    })).resolves.toBe(true);

    await vi.waitFor(() => expect(received).toHaveLength(1));
    expect(dropped).toHaveBeenCalledOnce();
    expect(received[0]).toMatchObject({
      kind: "engine_event",
      payload: { type: "debug", message: "still alive" },
    });
  });

  it.each([
    {
      name: "command",
      frame: {
        protocolVersion: RUNNER_FRAME_PROTOCOL_VERSION,
        channel: "command",
        kind: "prepare_session",
        commandId: "strict-command",
        agentSessionId: "session-1",
        invalid: undefined,
      },
    },
    {
      name: "response",
      frame: {
        protocolVersion: RUNNER_FRAME_PROTOCOL_VERSION,
        channel: "control",
        kind: "response",
        correlationId: "strict-response",
        result: { status: "ok", data: undefined },
      },
    },
  ])("keeps $name frames strict when undefined is present", async ({ frame }) => {
    const [host] = await socketPair();
    const connection = new RunnerIpcConnection(host);

    await expect(connection.send(frame as never)).rejects.toThrow("undefined is not a JSON value");
  });
});

async function socketPair(): Promise<[Socket, Socket]> {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("TCP test server has no port");
  const accepted = new Promise<Socket>((resolve) => server.once("connection", resolve));
  const client = connect(address.port, "127.0.0.1");
  const peer = await accepted;
  server.close();
  sockets.push(client, peer);
  return [client, peer];
}

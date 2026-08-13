import { createServer, connect, type Socket } from "node:net";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  RUNNER_FRAME_PROTOCOL_VERSION,
  engineEventFrame,
  hostFrameAppliedControlFrame,
  prepareSessionCommandFrame,
  runnerControlResponseFrame,
  runnerCommandResultFrame,
  stageInterventionCommandFrame,
} from "../../src/runner/frame_protocol.js";
import {
  RunnerIpcConnection,
} from "../../src/runner/runner_ipc_connection.js";
import { runnerDroppedFrameLogContext } from "../../src/runner/runner_frame_drop.js";
import { RunnerHostRequestClient } from
  "../../src/runner/runner_host_request_client.js";

const sockets: Socket[] = [];

afterEach(() => {
  vi.restoreAllMocks();
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

  it("does not queue an intervention command behind an unrelated control handler", async () => {
    const [host, runner] = await socketPair();
    const hostConnection = new RunnerIpcConnection(host);
    const runnerConnection = new RunnerIpcConnection(runner);
    let releaseControl!: () => void;
    const controlBlocked = new Promise<void>((resolve) => {
      releaseControl = resolve;
    });
    runnerConnection.onFrame(async (frame) => {
      if (frame.channel === "control" && frame.kind === "host_frame_applied") {
        await controlBlocked;
        return;
      }
      if (frame.channel === "command" && frame.kind === "stage_intervention") {
        await runnerConnection.send(runnerCommandResultFrame(frame.commandId, {
          status: "ok",
          data: { eventSourceSeq: null, queuePosition: 0 },
        }));
      }
    });

    await hostConnection.send(hostFrameAppliedControlFrame(1));
    const intervention = hostConnection.request(stageInterventionCommandFrame({
      commandId: "stage-intervention:priority",
      interventionId: "priority",
      message: { text: "redirect now" },
      queued: false,
    }), { timeoutMs: 50 });

    await expect(intervention).resolves.toMatchObject({
      commandId: "stage-intervention:priority",
      result: { status: "ok" },
    });
    releaseControl();
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

  it("normalizes ECONNRESET transport teardown as a closed connection on Windows", async () => {
    vi.spyOn(process, "platform", "get").mockReturnValue("win32");
    const [host] = await socketPair();
    const connection = new RunnerIpcConnection(host);
    const failure = vi.fn();
    connection.onFailure(failure);
    const reset = Object.assign(new Error("read ECONNRESET"), {
      code: "ECONNRESET",
    });

    host.emit("error", reset);

    expect(failure).toHaveBeenCalledOnce();
    expect(failure.mock.calls[0]?.[0]).toMatchObject({
      message: "Runner IPC connection closed",
      cause: reset,
    });
  });

  it("preserves ECONNRESET transport failures outside Windows", async () => {
    vi.spyOn(process, "platform", "get").mockReturnValue("linux");
    const [host] = await socketPair();
    const connection = new RunnerIpcConnection(host);
    const failure = vi.fn();
    connection.onFailure(failure);
    const reset = Object.assign(new Error("read ECONNRESET"), {
      code: "ECONNRESET",
    });

    host.emit("error", reset);

    expect(failure).toHaveBeenCalledWith(reset);
  });

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
      eventType: "rate_limit",
      correlationId: expect.any(String),
      dropCount: 1,
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

    await expect(runnerConnection.send(engineEventFrame({
      type: "debug",
      invalid: Symbol("process-local"),
    }))).resolves.toBe(false);
    await expect(runnerConnection.send({
      protocolVersion: RUNNER_FRAME_PROTOCOL_VERSION,
      channel: "event",
      kind: "engine_event",
      payload: { type: "debug", message: "still alive" },
    })).resolves.toBe(true);

    await vi.waitFor(() => expect(received).toHaveLength(1));
    expect(dropped).toHaveBeenCalledOnce();
    expect(dropped.mock.calls[0]?.[0]).toMatchObject({
      kind: "engine_event",
      eventType: "debug",
      dropCount: 1,
      error: expect.any(Error),
    });
    expect(received[0]).toMatchObject({
      kind: "engine_event",
      payload: { type: "debug", message: "still alive" },
    });
  });

  it("normalizes deep undefined in engine events at the emission boundary", async () => {
    const [host, runner] = await socketPair();
    const received: unknown[] = [];
    const hostConnection = new RunnerIpcConnection(host);
    const runnerConnection = new RunnerIpcConnection(runner);
    hostConnection.onFrame(async (frame) => received.push(frame));

    await expect(runnerConnection.send(engineEventFrame({
      type: "debug",
      nested: { missing: undefined },
      values: [undefined],
    }))).resolves.toBe(true);

    await vi.waitFor(() => expect(received).toHaveLength(1));
    expect(received[0]).toMatchObject({
      kind: "engine_event",
      payload: { type: "debug", nested: {}, values: [null] },
    });
  });

  it("increments the dropped-observation count on one connection", async () => {
    const [host, runner] = await socketPair();
    const dropped = vi.fn();
    const hostConnection = new RunnerIpcConnection(host);
    const runnerConnection = new RunnerIpcConnection(runner, { onFrameDropped: dropped });

    for (const type of ["rate_limit", "debug"]) {
      await expect(runnerConnection.send({
        protocolVersion: RUNNER_FRAME_PROTOCOL_VERSION,
        channel: "event",
        kind: "engine_event",
        payload: { type, invalid: Symbol(type) },
      } as never)).resolves.toBe(false);
    }

    expect(dropped.mock.calls.map(([drop]) => drop.dropCount)).toEqual([1, 2]);
    const logContext = runnerDroppedFrameLogContext(dropped.mock.calls[1]![0], 9);
    expect(logContext).toMatchObject({
      eventType: "debug",
      dropCount: 9,
      err: expect.any(Error),
    });
    expect(logContext).not.toHaveProperty("error");
    hostConnection.close();
    runnerConnection.close();
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

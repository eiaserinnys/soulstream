import { createServer, connect, type Socket } from "node:net";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  RUNNER_FRAME_PROTOCOL_VERSION,
  prepareSessionCommandFrame,
  runnerCommandResultFrame,
} from "../../src/runner/frame_protocol.js";
import { RunnerIpcConnection } from "../../src/runner/runner_ipc_connection.js";

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

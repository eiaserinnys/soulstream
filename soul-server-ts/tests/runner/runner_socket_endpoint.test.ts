import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  prepareSessionCommandFrame,
  runnerCommandResultFrame,
} from "../../src/runner/frame_protocol.js";
import {
  connectRunnerSocket,
  RunnerSocketEndpoint,
} from "../../src/runner/runner_socket_endpoint.js";
import { RunnerWriterLock } from "../../src/runner/runner_writer_lock.js";

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(directories.splice(0).map(
    async (directory) => await rm(directory, { recursive: true, force: true }),
  ));
});

describe("runner socket ownership", () => {
  it("keeps the listener alive while the host connection is replaced", async () => {
    const socketPath = await temporaryPath("runner.sock");
    let endpoint!: RunnerSocketEndpoint;
    endpoint = new RunnerSocketEndpoint(socketPath, async (frame) => {
      if (frame.channel === "command") {
        await endpoint.currentConnection!.send(
          runnerCommandResultFrame(frame.commandId, { status: "ok" }),
        );
      }
    }, vi.fn());
    await endpoint.listen();
    const first = await connectRunnerSocket(socketPath, { timeoutMs: 100 });
    const second = await connectRunnerSocket(socketPath, { timeoutMs: 100 });

    await expect(second.request(
      prepareSessionCommandFrame("prepare-2", "session-1"),
      { timeoutMs: 100 },
    )).resolves.toMatchObject({ commandId: "prepare-2" });
    expect(first.pendingRequestCount).toBe(0);
    first.close();
    second.close();
    await endpoint.close();
  });

  it("permits exactly one writer lock holder", async () => {
    const lockPath = await temporaryPath("runner.lock");
    const first = await RunnerWriterLock.acquire(lockPath, 1001);

    await expect(RunnerWriterLock.acquire(lockPath, 1002))
      .rejects.toThrow("writer lock already held");
    await first.release();
    const replacement = await RunnerWriterLock.acquire(lockPath, 1002);
    await replacement.release();
  });
});

async function temporaryPath(name: string): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "soulstream-runner-socket-"));
  directories.push(directory);
  return join(directory, name);
}

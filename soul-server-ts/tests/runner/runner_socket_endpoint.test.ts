import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  prepareSessionCommandFrame,
  runnerCommandResultFrame,
} from "../../src/runner/frame_protocol.js";
import {
  connectRunnerSocket,
  RUNNER_SOCKET_RETRYABLE_ERROR_CODES,
  RunnerSocketEndpoint,
} from "../../src/runner/runner_socket_endpoint.js";
import { RunnerWriterLock } from "../../src/runner/runner_writer_lock.js";
import type { ProcessOwnershipLockDependencies } from "../../src/runner/runner_process_lock.js";

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

  it("stops retrying at one absolute deadline even when each attempt has a longer timeout", async () => {
    const socketPath = await temporaryPath("missing.sock");
    const startedAt = Date.now();

    await expect(connectRunnerSocket(socketPath, {
      timeoutMs: 500,
      deadlineMs: 80,
      retryDelayMs: 20,
    })).rejects.toThrow("Runner socket unavailable after 80ms deadline");

    expect(Date.now() - startedAt).toBeLessThan(500);
    expect(RUNNER_SOCKET_RETRYABLE_ERROR_CODES).toEqual([
      "EAGAIN",
      "ECONNREFUSED",
      "ECONNRESET",
      "ENOENT",
      "ETIMEDOUT",
    ]);
  });

  it("permits exactly one writer lock holder", async () => {
    const lockPath = await temporaryPath("runner.lock");
    const first = await RunnerWriterLock.acquire(lockPath);

    await expect(RunnerWriterLock.acquire(lockPath))
      .rejects.toThrow("writer lock already held");
    await first.release();
    const replacement = await RunnerWriterLock.acquire(lockPath);
    await replacement.release();
  });

  it("migrates a legacy pid-only lock only after proving that pid is dead", async () => {
    const lockPath = await temporaryPath("legacy-runner.lock");
    await writeFile(lockPath, "1001\n");
    const live = ownershipDependencies(true);

    await expect(RunnerWriterLock.acquire(lockPath, live))
      .rejects.toThrow("writer lock already held");

    const replacement = await RunnerWriterLock.acquire(
      lockPath,
      ownershipDependencies(false),
    );
    await replacement.release();
  });
});

function ownershipDependencies(alive: boolean): ProcessOwnershipLockDependencies {
  return {
    now: () => 0,
    delay: async () => {},
    currentOwner: async () => ({ pid: 2002, startIdentity: "replacement" }),
    inspectProcess: async () => ({ alive, startIdentity: alive ? "unknown-live" : null }),
  };
}

async function temporaryPath(name: string): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "soulstream-runner-socket-"));
  directories.push(directory);
  return join(directory, name);
}

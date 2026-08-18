import { randomUUID } from "node:crypto";
import { access, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
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
import {
  prepareRunnerWriterLockForSpawn,
  runnerWriterBootstrapPath,
  RunnerWriterLock,
} from "../../src/runner/runner_writer_lock.js";
import type { ProcessOwnershipLockDependencies } from "../../src/runner/runner_process_lock.js";

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(directories.splice(0).map(
    async (directory) => await rm(directory, { recursive: true, force: true }),
  ));
});

describe("runner socket ownership", () => {
  it("keeps the listener alive while the host connection is replaced", async () => {
    const socketPath = await temporarySocketPath();
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
    const socketPath = await temporarySocketPath();
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

  it("reclaims a current-host lock file only when no active lock object owns it", async () => {
    const orphanPath = await temporaryPath("orphan-host-runner.lock");
    const deps = ownershipDependencies(true, {
      pid: 2002,
      startIdentity: "replacement",
    });
    await writeFile(orphanPath, `${JSON.stringify({
      pid: 2002,
      startIdentity: "replacement",
    })}\n`);

    await expect(prepareRunnerWriterLockForSpawn(orphanPath, deps)).resolves.toBe(true);

    const replacement = await RunnerWriterLock.acquire(orphanPath, deps);
    await expect(prepareRunnerWriterLockForSpawn(orphanPath, deps))
      .rejects.toThrow("writer lock already held");
    await replacement.release();
  });

  it("keeps a live child writer lock fail-closed", async () => {
    const lockPath = await temporaryPath("live-child-runner.lock");
    await writeFile(lockPath, `${JSON.stringify({
      pid: 3003,
      startIdentity: "live-child",
    })}\n`);
    const deps = ownershipDependencies(true, {
      pid: 2002,
      startIdentity: "host",
    }, "live-child");

    await expect(prepareRunnerWriterLockForSpawn(lockPath, deps))
      .rejects.toThrow("writer lock already held");
  });

  it("recovers an expired nonce bootstrap and publishes only a complete owner record", async () => {
    const lockPath = await temporaryPath("bootstrap-crash-runner.lock");
    const bootstrapPath = runnerWriterBootstrapPath(lockPath);
    await writeFile(bootstrapPath, `${JSON.stringify({
      schemaVersion: 1,
      nonce: "crashed-acquirer",
      expiresAtMs: 99,
    })}\n`);
    const deps = ownershipDependencies(false, {
      pid: 4004,
      startIdentity: "replacement-owner",
    }, "replacement-owner", 100);

    const lock = await RunnerWriterLock.acquire(lockPath, deps);

    await expect(access(bootstrapPath)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(readFile(lockPath, "utf8")).resolves.toBe(`${JSON.stringify({
      pid: 4004,
      startIdentity: "replacement-owner",
    })}\n`);
    await lock.release();
  });
});

function ownershipDependencies(
  alive: boolean,
  currentOwner = { pid: 2002, startIdentity: "replacement" },
  observedStartIdentity = "unknown-live",
  now = 0,
): ProcessOwnershipLockDependencies {
  return {
    now: () => now,
    delay: async () => {},
    currentOwner: async () => currentOwner,
    inspectProcess: async () => ({ alive, startIdentity: alive ? observedStartIdentity : null }),
  };
}

async function temporaryPath(name: string): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "soulstream-runner-socket-"));
  directories.push(directory);
  return join(directory, name);
}

async function temporarySocketPath(): Promise<string> {
  return process.platform === "win32"
    ? `\\\\.\\pipe\\soulstream-runner-socket-${randomUUID()}`
    : await temporaryPath("runner.sock");
}

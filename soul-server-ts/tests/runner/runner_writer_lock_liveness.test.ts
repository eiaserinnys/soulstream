import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import type { ProcessOwnershipLockDependencies } from
  "../../src/runner/runner_process_lock.js";
import {
  inspectRunnerWriterLock,
  RunnerWriterLock,
} from "../../src/runner/runner_writer_lock.js";

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(directories.splice(0).map(
    async (directory) => await rm(directory, { recursive: true, force: true }),
  ));
});

describe("runner writer lock liveness", () => {
  it("reports one live runner identically to six concurrent observers", async () => {
    const path = await temporaryPath();
    const owner = await RunnerWriterLock.acquire(path);

    const observed = await Promise.all(
      Array.from({ length: 6 }, async () => await inspectRunnerWriterLock(path)),
    );

    expect(observed).toEqual(Array.from({ length: 6 }, () => ({
      kind: "held",
      owner: owner.owner,
    })));
    await owner.release();
    await expect(inspectRunnerWriterLock(path)).resolves.toEqual({ kind: "free" });
  });

  it("treats a crashed kernel-lock record as free without inspecting its recycled pid", async () => {
    const path = await temporaryPath();
    await writeFile(path, `${JSON.stringify({
      schemaVersion: 2,
      lockKind: "kernel-endpoint",
      pid: process.pid,
      startIdentity: "dead-runner-token",
    })}\n`);
    const inspectProcess = vi.fn(async () => {
      throw new Error("a kernel lock decision must not inspect a pid");
    });

    await expect(Promise.all(
      Array.from(
        { length: 6 },
        async () => await inspectRunnerWriterLock(path, dependencies(inspectProcess)),
      ),
    )).resolves.toEqual(Array.from({ length: 6 }, () => ({ kind: "free" })));
    expect(inspectProcess).not.toHaveBeenCalled();
  });

  it("keeps only legacy owner inspection as an explicit unavailable state", async () => {
    const path = await temporaryPath();
    await writeFile(path, `${JSON.stringify({
      pid: 4104,
      startIdentity: "windows-process-legacy",
    })}\n`);

    await expect(inspectRunnerWriterLock(path, dependencies(async () => ({
      alive: true,
      startIdentity: null,
    })))).resolves.toEqual({ kind: "unavailable" });
  });
});

function dependencies(
  inspectProcess: ProcessOwnershipLockDependencies["inspectProcess"],
): ProcessOwnershipLockDependencies {
  return {
    now: Date.now,
    delay: async () => {},
    currentOwner: async () => ({ pid: process.pid, startIdentity: "test-owner" }),
    inspectProcess,
  };
}

async function temporaryPath(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "soulstream-writer-liveness-"));
  directories.push(directory);
  return join(directory, "runner.lock");
}

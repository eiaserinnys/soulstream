import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  RunnerStateHostLock,
  runnerStateHostLockPath,
} from "../../src/runner/runner_state_host_lock.js";
import { runnerKernelLockEndpoint } from "../../src/runner/runner_kernel_lock.js";
import { processStartIdentitiesMatch } from "../../src/runner/runner_process_lock.js";

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(directories.splice(0).map(
    async (directory) => await rm(directory, { recursive: true, force: true }),
  ));
});

describe("RunnerStateHostLock", () => {
  it("derives a Windows named-pipe endpoint from the canonical lock path", () => {
    expect(runnerKernelLockEndpoint(
      "C:\\Soulstream\\Runner.lock",
      "win32",
    )).toMatch(/^\\\\\.\\pipe\\soulstream-runner-lock-[a-f0-9]{64}$/);
  });

  it("matches the child timestamp to the equivalent Windows process start token", () => {
    const unixStartMs = 1_700_000_000_123;
    const windowsTicks = 621_355_968_000_000_000n + BigInt(unixStartMs) * 10_000n;

    expect(processStartIdentitiesMatch(
      `node-start-${unixStartMs}`,
      `windows-process-${windowsTicks}`,
    )).toBe(true);
    expect(processStartIdentitiesMatch(
      `node-start-${unixStartMs}`,
      `windows-process-${windowsTicks + 30_000_000n}`,
    )).toBe(false);
  });

  it("uses exclusive kernel ownership for the host lifetime", async () => {
    const stateDirectory = await temporaryStateDirectory();
    const first = await RunnerStateHostLock.acquire(stateDirectory);

    await expect(RunnerStateHostLock.acquire(stateDirectory))
      .rejects.toThrow("runner state host ownership already held");

    await first.release();
    const replacement = await RunnerStateHostLock.acquire(stateDirectory);
    await replacement.release();
  });

  it("ignores abandoned owner-file residue from the former directory lock", async () => {
    const stateDirectory = await temporaryStateDirectory();
    const oldLockDirectory = runnerStateHostLockPath(stateDirectory);
    await mkdir(oldLockDirectory, { recursive: true });
    await writeFile(join(oldLockDirectory, "owner.json"), "stale owner");

    const lock = await RunnerStateHostLock.acquire(stateDirectory);

    await lock.release();
  });
});

async function temporaryStateDirectory(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "runner-state-owner-"));
  directories.push(root);
  return join(root, "state");
}

import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  RunnerStateHostLock,
  runnerStateHostLockPath,
} from "../../src/runner/runner_state_host_lock.js";
import {
  defaultProcessOwnershipLockDependencies,
  processStartIdentitiesMatch,
  type ProcessOwnershipLockDependencies,
} from "../../src/runner/runner_process_lock.js";

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(directories.splice(0).map(
    async (directory) => await rm(directory, { recursive: true, force: true }),
  ));
});

describe("RunnerStateHostLock", () => {
  it("matches a child self timestamp to the equivalent Windows process start token", () => {
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
    expect(processStartIdentitiesMatch(
      `node-start-${unixStartMs}`,
      `node-start-${unixStartMs + 1}`,
    )).toBe(false);
  });

  it("reuses one stable start identity for the current host process", async () => {
    const dependencies = defaultProcessOwnershipLockDependencies();

    const [first, second] = await Promise.all([
      dependencies.currentOwner(),
      dependencies.currentOwner(),
    ]);

    expect(first).toEqual(second);
    expect(first.startIdentity).toBeTruthy();
  });

  it("rejects a second host while the exact owner process is alive", async () => {
    const stateDirectory = await temporaryStateDirectory();
    const first = await RunnerStateHostLock.acquire(
      stateDirectory,
      dependencies({ pid: 4101, startIdentity: "host-a" }),
    );

    await expect(RunnerStateHostLock.acquire(
      stateDirectory,
      dependencies(
        { pid: 4102, startIdentity: "host-b" },
        { alive: true, startIdentity: "host-a" },
      ),
    )).rejects.toThrow("runner state host ownership already held");

    await first.release();
  });

  it("takes over only after proving the prior host process is dead", async () => {
    const stateDirectory = await temporaryStateDirectory();
    await writeOwner(stateDirectory, { pid: 4201, startIdentity: "dead-host" });

    const replacement = await RunnerStateHostLock.acquire(
      stateDirectory,
      dependencies(
        { pid: 4202, startIdentity: "replacement" },
        { alive: false, startIdentity: null },
      ),
    );

    expect(JSON.parse(await readFile(
      join(runnerStateHostLockPath(stateDirectory), "owner.json"),
      "utf8",
    ))).toEqual({ pid: 4202, startIdentity: "replacement" });
    await replacement.release();
  });

  it("takes over a reused pid only when its start identity differs", async () => {
    const stateDirectory = await temporaryStateDirectory();
    await writeOwner(stateDirectory, { pid: 4301, startIdentity: "old-process" });

    const replacement = await RunnerStateHostLock.acquire(
      stateDirectory,
      dependencies(
        { pid: 4302, startIdentity: "replacement" },
        { alive: true, startIdentity: "new-process" },
      ),
    );

    await replacement.release();
  });

  it("fails closed when prior ownership evidence is unreadable", async () => {
    const stateDirectory = await temporaryStateDirectory();
    const lockPath = runnerStateHostLockPath(stateDirectory);
    await mkdir(lockPath, { recursive: true });
    await writeFile(join(lockPath, "owner.json"), "not-json\n");

    await expect(RunnerStateHostLock.acquire(
      stateDirectory,
      dependencies({ pid: 4402, startIdentity: "replacement" }),
    )).rejects.toThrow("runner state host ownership already held");
  });
});

async function temporaryStateDirectory(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "runner-state-owner-"));
  directories.push(root);
  return join(root, "state");
}

async function writeOwner(
  stateDirectory: string,
  owner: { pid: number; startIdentity: string },
): Promise<void> {
  const lockPath = runnerStateHostLockPath(stateDirectory);
  await mkdir(lockPath, { recursive: true });
  await writeFile(join(lockPath, "owner.json"), `${JSON.stringify(owner)}\n`);
}

function dependencies(
  owner: { pid: number; startIdentity: string },
  inspected = { alive: true, startIdentity: owner.startIdentity as string | null },
): ProcessOwnershipLockDependencies {
  return {
    now: () => 0,
    delay: async () => {},
    currentOwner: async () => owner,
    inspectProcess: async () => inspected,
  };
}

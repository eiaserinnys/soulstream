import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it } from "vitest";

import {
  RunnerKernelLock,
  runnerKernelLockEndpoint,
} from "../../src/runner/runner_kernel_lock.js";

const directories: string[] = [];
const children: ChildProcess[] = [];

afterEach(async () => {
  for (const child of children.splice(0)) {
    if (child.exitCode === null) child.kill("SIGKILL");
  }
  await Promise.all(directories.splice(0).map(
    async (directory) => await rm(directory, { recursive: true, force: true }),
  ));
});

describe("runner kernel lock", () => {
  it("permits exactly one holder without a filesystem lease or time budget", async () => {
    const lockPath = await temporaryLockPath();
    const first = await RunnerKernelLock.tryAcquire(lockPath);

    expect(first).not.toBeNull();
    await expect(RunnerKernelLock.tryAcquire(lockPath)).resolves.toBeNull();
    await first!.release();

    const replacement = await RunnerKernelLock.tryAcquire(lockPath);
    expect(replacement).not.toBeNull();
    await replacement!.release();
  });

  it("is released by the OS immediately after an ungraceful holder death", async () => {
    const lockPath = await temporaryLockPath();
    const child = spawnKernelLockHolder(runnerKernelLockEndpoint(lockPath));
    await waitForReady(child);

    await expect(RunnerKernelLock.tryAcquire(lockPath)).resolves.toBeNull();
    await killAndWait(child);

    const replacement = await RunnerKernelLock.tryAcquire(lockPath);
    expect(replacement).not.toBeNull();
    await replacement!.release();
  });

  it("gives six concurrent observers one deterministic held answer", async () => {
    const lockPath = await temporaryLockPath();
    const owner = await RunnerKernelLock.tryAcquire(lockPath);
    expect(owner).not.toBeNull();

    const observed = await Promise.all(
      Array.from({ length: 6 }, async () => await RunnerKernelLock.isHeld(lockPath)),
    );

    expect(observed).toEqual([true, true, true, true, true, true]);
    await owner!.release();
    await expect(Promise.all(
      Array.from({ length: 6 }, async () => await RunnerKernelLock.isHeld(lockPath)),
    )).resolves.toEqual([false, false, false, false, false, false]);
  });
});

function spawnKernelLockHolder(endpoint: string): ChildProcess {
  const fixture = fileURLToPath(new URL("./fixtures/kernel_lock_holder.mjs", import.meta.url));
  const child = spawn(
    process.execPath,
    [fixture, Buffer.from(endpoint, "utf8").toString("base64")],
    { stdio: ["ignore", "pipe", "pipe"] },
  );
  children.push(child);
  return child;
}

async function waitForReady(child: ChildProcess): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    let stderr = "";
    child.stderr!.setEncoding("utf8");
    child.stderr!.on("data", (chunk: string) => { stderr += chunk; });
    child.once("exit", (code) => reject(new Error(
      `kernel lock holder exited before ready (${code}): ${stderr}`,
    )));
    child.stdout!.setEncoding("utf8");
    child.stdout!.once("data", (chunk: string) => {
      if (chunk.trim() === "ready") resolve();
      else reject(new Error(`unexpected kernel lock holder output: ${chunk}`));
    });
  });
}

async function killAndWait(child: ChildProcess): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", () => resolve());
    if (!child.kill("SIGKILL")) reject(new Error("failed to kill kernel lock holder"));
  });
}

async function temporaryLockPath(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "soulstream-kernel-lock-"));
  directories.push(directory);
  return join(dirname(directory), `${randomUUID()}.runner.lock`);
}

import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it } from "vitest";

import {
  RunnerKernelLock,
  runnerKernelLockEndpoint,
} from "../../src/runner/runner_kernel_lock.js";
import {
  darwinKernelLockPath,
  isDarwinKernelLockHeld,
  tryAcquireDarwinKernelLock,
} from "../../src/runner/runner_darwin_kernel_lock.js";

const directories: string[] = [];
const children: ChildProcess[] = [];
const darwinLockFiles: string[] = [];

afterEach(async () => {
  for (const child of children.splice(0)) {
    if (child.exitCode === null) child.kill("SIGKILL");
  }
  await Promise.all(directories.splice(0).map(
    async (directory) => await rm(directory, { recursive: true, force: true }),
  ));
  await Promise.all(darwinLockFiles.splice(0).flatMap((lockFile) => [
    rm(lockFile, { force: true }),
    rm(`${lockFile}-journal`, { force: true }),
  ]));
});

describe.skipIf(process.platform === "darwin")("runner kernel lock", () => {
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

describe.skipIf(process.platform === "win32")("runner kernel lock on Darwin", () => {
  it("permits exactly one SQLite exclusive holder and releases idempotently", async () => {
    const lockPath = await temporaryLockPath();
    trackDarwinLockFile(lockPath);

    const first = tryAcquireDarwinKernelLock(lockPath);
    expect(first).not.toBeNull();
    expect(tryAcquireDarwinKernelLock(lockPath)).toBeNull();
    expect(isDarwinKernelLockHeld(lockPath)).toBe(true);

    first!.release();
    first!.release();
    expect(isDarwinKernelLockHeld(lockPath)).toBe(false);

    const replacement = tryAcquireDarwinKernelLock(lockPath);
    expect(replacement).not.toBeNull();
    replacement!.release();
  });

  it("is released by the OS immediately after an ungraceful Darwin holder death", async () => {
    const lockPath = await temporaryLockPath();
    const lockFile = trackDarwinLockFile(lockPath);
    const child = spawnKernelLockHolder("", "darwin", lockFile);
    await waitForReady(child);

    expect(tryAcquireDarwinKernelLock(lockPath)).toBeNull();
    await killAndWait(child);

    const replacement = tryAcquireDarwinKernelLock(lockPath);
    expect(replacement).not.toBeNull();
    replacement!.release();
  });

  it("gives six concurrent observers the same live and dead answer", async () => {
    const lockPath = await temporaryLockPath();
    const lockFile = trackDarwinLockFile(lockPath);
    const child = spawnKernelLockHolder("", "darwin", lockFile);
    await waitForReady(child);

    const live = await Promise.all(
      Array.from({ length: 6 }, async () => isDarwinKernelLockHeld(lockPath)),
    );
    expect(live).toEqual([true, true, true, true, true, true]);

    await killAndWait(child);

    const dead = await Promise.all(
      Array.from({ length: 6 }, async () => isDarwinKernelLockHeld(lockPath)),
    );
    expect(dead).toEqual([false, false, false, false, false, false]);
  });

  it("keeps independent lock paths independent", async () => {
    const firstPath = await temporaryLockPath();
    const secondPath = await temporaryLockPath();
    trackDarwinLockFile(firstPath);
    trackDarwinLockFile(secondPath);

    const first = tryAcquireDarwinKernelLock(firstPath);
    const second = tryAcquireDarwinKernelLock(secondPath);
    expect(first).not.toBeNull();
    expect(second).not.toBeNull();

    first!.release();
    second!.release();
  });

  it("resolves an aliased parent to the same lock file hash", async () => {
    const root = await mkdtemp(join(tmpdir(), "soulstream-kernel-lock-alias-"));
    directories.push(root);
    const realDirectory = join(root, "real");
    await mkdir(realDirectory);
    const aliasDirectory = join(root, "alias");
    await symlink(realDirectory, aliasDirectory, "dir");

    const realLockPath = join(realDirectory, "runner.lock");
    const aliasLockPath = join(aliasDirectory, "runner.lock");
    trackDarwinLockFile(realLockPath);
    expect(darwinKernelLockPath(aliasLockPath)).toBe(darwinKernelLockPath(realLockPath));

    const owner = tryAcquireDarwinKernelLock(realLockPath);
    expect(owner).not.toBeNull();
    expect(tryAcquireDarwinKernelLock(aliasLockPath)).toBeNull();
    owner!.release();
  });
});

function spawnKernelLockHolder(
  endpoint: string,
  platform: "net" | "darwin" = "net",
  darwinLockFile = "",
): ChildProcess {
  const fixture = fileURLToPath(new URL("./fixtures/kernel_lock_holder.mjs", import.meta.url));
  const child = spawn(
    process.execPath,
    [
      fixture,
      Buffer.from(endpoint, "utf8").toString("base64"),
      platform,
      darwinLockFile,
    ],
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

function trackDarwinLockFile(lockPath: string): string {
  const lockFile = darwinKernelLockPath(lockPath);
  darwinLockFiles.push(lockFile);
  return lockFile;
}

async function temporaryLockPath(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "soulstream-kernel-lock-"));
  directories.push(directory);
  return join(directory, `${randomUUID()}.runner.lock`);
}

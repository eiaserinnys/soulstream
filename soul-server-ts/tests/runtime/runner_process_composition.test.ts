import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  composeRunnerProcessRuntime,
  composeRunnerReconciliationReporter,
  composeRunnerRecoveryCoordinator,
} from "../../src/runtime/runner_process_composition.js";

describe("runner process composition feature gate", () => {
  const directories: string[] = [];
  const releaseDirectories: string[] = [];

  afterEach(async () => {
    for (const directory of releaseDirectories.splice(0)) {
      await chmod(directory, 0o755).catch(() => undefined);
    }
    for (const directory of directories.splice(0)) {
      await chmod(directory, 0o755).catch(() => undefined);
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("does not construct or validate runner process dependencies while disabled", async () => {
    await expect(composeRunnerProcessRuntime(false, {} as never)).resolves.toBeUndefined();
  });

  it("prewarms the current immutable release before enabled composition returns", async () => {
    const root = await mkdtemp(join(tmpdir(), "runner-composition-"));
    directories.push(root);
    const artifacts = join(root, "artifacts");
    const releases = join(root, "releases");
    await import("node:fs/promises").then(({ mkdir }) => mkdir(artifacts));
    await writeFile(join(artifacts, "package.json"), '{"type":"module"}\n');
    await writeFile(join(artifacts, "runner_entry.js"), "export const ready = true;\n");

    const composed = await composeRunnerProcessRuntime(true, {
      env: {
        SOUL_RUNNER_STATE_DIR: join(root, "state"),
        SOUL_RUNNER_ARTIFACT_DIR: artifacts,
        SOUL_RUNNER_RELEASES_DIR: releases,
        SOUL_RUNNER_TERMINAL_RETENTION_MS: 86_400_000,
      },
      logger: {} as never,
    } as never);

    expect(composed).toBeDefined();
    const ready = await import("node:fs/promises").then(({ readdir }) => readdir(releases));
    const releaseId = ready.find((entry) => entry.startsWith("sha256-"));
    expect(releaseId).toBeDefined();
    releaseDirectories.push(join(releases, releaseId!));
    expect(await readFile(join(releases, releaseId!, "runner_entry.js"), "utf8"))
      .toBe("export const ready = true;\n");
    await composed!.hostOwnership.release();
  });

  it("refuses a second live host before it can scan or spawn in the same state directory", async () => {
    const root = await mkdtemp(join(tmpdir(), "runner-composition-owner-"));
    directories.push(root);
    const artifacts = join(root, "artifacts");
    const releases = join(root, "releases");
    await import("node:fs/promises").then(({ mkdir }) => mkdir(artifacts));
    await writeFile(join(artifacts, "package.json"), '{"type":"module"}\n');
    await writeFile(join(artifacts, "runner_entry.js"), "export const ready = true;\n");
    const options = {
      env: {
        SOUL_RUNNER_STATE_DIR: join(root, "state"),
        SOUL_RUNNER_ARTIFACT_DIR: artifacts,
        SOUL_RUNNER_RELEASES_DIR: releases,
        SOUL_RUNNER_TERMINAL_RETENTION_MS: 86_400_000,
      },
      logger: {} as never,
    } as never;

    const first = await composeRunnerProcessRuntime(true, options);
    const ready = await import("node:fs/promises").then(({ readdir }) => readdir(releases));
    const releaseId = ready.find((entry) => entry.startsWith("sha256-"));
    expect(releaseId).toBeDefined();
    releaseDirectories.push(join(releases, releaseId!));
    await expect(composeRunnerProcessRuntime(true, options))
      .rejects.toThrow("runner state host ownership already held");

    await first!.hostOwnership.release();
    const replacement = await composeRunnerProcessRuntime(true, options);
    await replacement!.hostOwnership.release();
  });

  it("fails enabled startup loudly when runner build artifacts are absent", async () => {
    const root = await mkdtemp(join(tmpdir(), "runner-composition-missing-"));
    directories.push(root);
    await expect(composeRunnerProcessRuntime(true, {
      env: {
        SOUL_RUNNER_STATE_DIR: join(root, "state"),
        SOUL_RUNNER_ARTIFACT_DIR: join(root, "missing-artifacts"),
        SOUL_RUNNER_RELEASES_DIR: join(root, "releases"),
        SOUL_RUNNER_TERMINAL_RETENTION_MS: 86_400_000,
      },
      logger: {} as never,
    } as never)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("does not require runner state configuration without a process factory", async () => {
    await expect(composeRunnerRecoveryCoordinator({
      env: {} as never,
      runnerProcessFactory: undefined,
      taskManager: {} as never,
      taskExecutor: {} as never,
      logger: {} as never,
    })).resolves.toBeUndefined();
  });

  it("composes runner recovery without starting a pre-listener scan", async () => {
    const root = await mkdtemp(join(tmpdir(), "runner-recovery-composition-"));
    directories.push(root);
    const listOwnerNullRunningInventory = vi.fn(async () => []);

    const coordinator = await composeRunnerRecoveryCoordinator({
      env: {
        SOULSTREAM_NODE_ID: "node-a",
        SOUL_RUNNER_STATE_DIR: root,
        SOUL_RUNNER_LEASE_TIMEOUT_MS: 120_000,
        SOUL_RUNNER_REAPER_INTERVAL_MS: 10_000,
      } as never,
      runnerProcessFactory: {} as never,
      closedTailDrainer: { drain: vi.fn(async () => {}) },
      taskManager: {
        listOwnerNullRunningInventory,
      } as never,
      taskExecutor: {} as never,
      logger: {
        error: vi.fn(),
        info: vi.fn(),
        warn: vi.fn(),
      } as never,
    });

    expect(coordinator).toBeDefined();
    expect(listOwnerNullRunningInventory).not.toHaveBeenCalled();
    await coordinator!.stop();
  });

  it("does not expose runner reconciliation dependencies while disabled", () => {
    expect(composeRunnerReconciliationReporter(
      {} as never,
      undefined,
      undefined,
      { debug: vi.fn() } as never,
    )).toEqual({});
  });

  it("waits for recovery before reading the enabled runner inventory", async () => {
    const waitForSettled = vi.fn(async () => {});
    const reporter = composeRunnerReconciliationReporter(
      {
        SOUL_RUNNER_STATE_DIR: "/runner-directory-that-does-not-exist",
        SOUL_RUNNER_LEASE_TIMEOUT_MS: 120_000,
      } as never,
      {} as never,
      { waitForSettled } as never,
      { debug: vi.fn() } as never,
    );

    await reporter.waitForRunnerReconciliation!();
    await expect(reporter.listLiveRunnerSessionIds!()).resolves.toEqual([]);
    expect(waitForSettled).toHaveBeenCalledOnce();
  });

  it("ignores reserved infrastructure during the initial runner inventory", async () => {
    const root = await mkdtemp(join(tmpdir(), "runner-initial-inventory-"));
    directories.push(root);
    const controlDirectory = join(root, "_control");
    await mkdir(controlDirectory);
    await writeFile(join(controlDirectory, "control-inbox.sqlite"), "not-a-runner-database");
    const waitForSettled = vi.fn(async () => {});
    const reporter = composeRunnerReconciliationReporter(
      {
        SOUL_RUNNER_STATE_DIR: root,
        SOUL_RUNNER_LEASE_TIMEOUT_MS: 120_000,
      } as never,
      {} as never,
      { waitForSettled } as never,
      { debug: vi.fn() } as never,
    );

    await reporter.waitForRunnerReconciliation!();
    await expect(reporter.listLiveRunnerSessionIds!()).resolves.toEqual([]);
    expect(waitForSettled).toHaveBeenCalledOnce();
  });
});

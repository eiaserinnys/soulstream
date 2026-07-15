import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  HarnessAlreadyRunningError,
  HarnessTimeoutError,
  runPlaywrightLifecycle,
} from "../e2e/playwright-lifecycle-harness.mjs";

const temporaryDirectories: string[] = [];

async function temporaryLockRoot(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "playwright-lifecycle-test-"));
  temporaryDirectories.push(directory);
  return directory;
}

function fakeBrowser() {
  let closeCount = 0;
  return {
    browser: {
      async close() {
        closeCount += 1;
      },
    },
    get closeCount() {
      return closeCount;
    },
  };
}

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) =>
    rm(directory, { force: true, recursive: true }),
  ));
});

describe("standalone Playwright lifecycle harness", () => {
  it("closes the browser when callback preparation fails", async () => {
    const lockRoot = await temporaryLockRoot();
    const fake = fakeBrowser();

    await expect(runPlaywrightLifecycle({
      lockName: "callback-failure",
      lockRoot,
      launchBrowser: async () => fake.browser,
      timeoutMs: 1_000,
    }, async () => {
      throw new Error("route preparation failed");
    })).rejects.toThrow("route preparation failed");

    expect(fake.closeCount).toBe(1);
  });

  it("blocks a duplicate lock before launching another browser", async () => {
    const lockRoot = await temporaryLockRoot();
    const outer = fakeBrowser();
    const duplicate = fakeBrowser();
    let duplicateLaunches = 0;

    await runPlaywrightLifecycle({
      lockName: "duplicate-run",
      lockRoot,
      launchBrowser: async () => outer.browser,
      timeoutMs: 1_000,
    }, async () => {
      await expect(runPlaywrightLifecycle({
        lockName: "duplicate-run",
        lockRoot,
        launchBrowser: async () => {
          duplicateLaunches += 1;
          return duplicate.browser;
        },
        timeoutMs: 1_000,
      }, async () => undefined)).rejects.toBeInstanceOf(HarnessAlreadyRunningError);
    });

    expect(outer.closeCount).toBe(1);
    expect(duplicateLaunches).toBe(0);
    expect(duplicate.closeCount).toBe(0);
  });

  it("times out a launch that never finishes and releases its lock", async () => {
    const lockRoot = await temporaryLockRoot();
    const recovery = fakeBrowser();

    await expect(runPlaywrightLifecycle({
      lockName: "launch-timeout",
      lockRoot,
      launchBrowser: async () => new Promise<never>(() => undefined),
      timeoutMs: 30,
      closeTimeoutMs: 10,
      residualTimeoutMs: 10,
    }, async () => undefined)).rejects.toBeInstanceOf(HarnessTimeoutError);

    await runPlaywrightLifecycle({
      lockName: "launch-timeout",
      lockRoot,
      launchBrowser: async () => recovery.browser,
      timeoutMs: 1_000,
    }, async () => undefined);
    expect(recovery.closeCount).toBe(1);
  });

  it("applies the global timeout to the complete callback", async () => {
    const lockRoot = await temporaryLockRoot();
    const fake = fakeBrowser();

    await expect(runPlaywrightLifecycle({
      lockName: "global-timeout",
      lockRoot,
      launchBrowser: async () => fake.browser,
      timeoutMs: 30,
    }, async () => new Promise<never>(() => undefined))).rejects.toBeInstanceOf(HarnessTimeoutError);

    expect(fake.closeCount).toBe(1);
  });
});

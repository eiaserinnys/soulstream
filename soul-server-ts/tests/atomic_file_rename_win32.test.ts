import { spawn } from "node:child_process";
import { renameSync } from "node:fs";
import { mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { renameWithTransientRetry } from "../src/atomic_file_rename.js";
import { RunnerSqliteEventOutbox } from "../src/runner/sqlite_event_outbox.js";
import {
  runnerLifecycleSummaryPath,
  RunnerSqliteLifecycle,
} from "../src/runner/sqlite_runner_lifecycle.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map(
    async (directory) => await rm(directory, { recursive: true, force: true }),
  ));
});

describe.skipIf(process.platform !== "win32")("Windows atomic rename contention", () => {
  it("retries a real destination handle lock until the handle is released", async () => {
    const directory = await mkdtemp(join(tmpdir(), "atomic-rename-win32-"));
    temporaryDirectories.push(directory);
    const sourcePath = join(directory, "source.json");
    const destinationPath = join(directory, "destination.json");
    await writeFile(sourcePath, "new\n", "utf8");
    await writeFile(destinationPath, "old\n", "utf8");
    const lock = holdExclusiveWindowsHandle(destinationPath);
    await lock.ready;
    let attempts = 0;
    const renameFile = vi.fn(async (source: string, destination: string) => {
      attempts += 1;
      try {
        await rename(source, destination);
      } catch (error) {
        if (attempts === 1) lock.release();
        throw error;
      }
    });

    await renameWithTransientRetry(sourcePath, destinationPath, {
      renameFile,
      retryDelaysMs: [50, 100, 200, 400, 800],
    });
    await lock.closed;

    expect(attempts).toBeGreaterThan(1);
    await expect(readFile(destinationPath, "utf8")).resolves.toBe("new\n");
  }, 10_000);

  it("retries the synchronous lifecycle summary rename under a real handle lock", async () => {
    const directory = await mkdtemp(join(tmpdir(), "lifecycle-rename-win32-"));
    temporaryDirectories.push(directory);
    const databasePath = join(directory, "runner.sqlite");
    const outbox = await RunnerSqliteEventOutbox.create(databasePath);
    await outbox.initializeBootstrap({
      session_id: "session-win32",
      created_at: "2026-08-12T00:00:00.000Z",
      resume: {
        schema_version: 1,
        backend_session_id: "backend-win32",
        cwd: directory,
        codex_home: null,
        rollout_root: null,
        code_sha: "release-win32",
        snapshot_path: directory,
      },
    });
    outbox.close();
    const initial = RunnerSqliteLifecycle.open(databasePath);
    await initial.begin({
      pid: process.pid,
      commandId: "execute-win32",
      progressedAt: "2026-08-12T00:00:00.000Z",
    });
    initial.close();
    const summaryPath = runnerLifecycleSummaryPath(databasePath);
    const lock = holdExclusiveWindowsHandle(summaryPath);
    await lock.ready;
    let attempts = 0;
    const lifecycle = RunnerSqliteLifecycle.open(databasePath, undefined, {
      renameFile: (source, destination) => {
        attempts += 1;
        try {
          renameSync(source, destination);
        } catch (error) {
          if (attempts === 1) lock.release();
          throw error;
        }
      },
      retryDelaysMs: [50, 100, 200, 400, 800],
    });

    await expect(lifecycle.progress(
      "execute-win32",
      "2026-08-12T00:00:01.000Z",
    )).resolves.toBeDefined();
    lifecycle.close();
    await lock.closed;

    expect(attempts).toBeGreaterThan(1);
    await expect(readFile(summaryPath, "utf8")).resolves.toContain(
      '\"progress_at\":\"2026-08-12T00:00:01.000Z\"',
    );
  }, 10_000);
});

function holdExclusiveWindowsHandle(path: string): {
  ready: Promise<void>;
  closed: Promise<void>;
  release: () => void;
} {
  const script = [
    "$stream = [System.IO.File]::Open($env:SOULSTREAM_LOCK_PATH, [System.IO.FileMode]::Open,",
    "  [System.IO.FileAccess]::Read, [System.IO.FileShare]::None)",
    "[Console]::Out.WriteLine('LOCKED')",
    "[Console]::In.ReadLine() | Out-Null",
    "$stream.Dispose()",
  ].join("\n");
  const child = spawn("powershell.exe", [
    "-NoLogo",
    "-NoProfile",
    "-NonInteractive",
    "-Command",
    script,
  ], {
    env: {
      ...process.env,
      SOULSTREAM_LOCK_PATH: path,
    },
    stdio: ["pipe", "pipe", "pipe"],
  });
  let stderr = "";
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk: string) => { stderr += chunk; });
  const closed = new Promise<void>((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`exclusive handle helper exited ${code}: ${stderr}`));
    });
  });
  const ready = new Promise<void>((resolve, reject) => {
    child.stdout.setEncoding("utf8");
    child.stdout.once("data", (chunk: string) => {
      if (chunk.includes("LOCKED")) resolve();
      else reject(new Error(`exclusive handle helper did not lock: ${chunk}`));
    });
    closed.catch(reject);
  });
  return {
    ready,
    closed,
    release: () => { child.stdin.end("\n"); },
  };
}

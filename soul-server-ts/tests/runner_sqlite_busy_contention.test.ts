import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";

import { afterEach, describe, expect, it, vi } from "vitest";

import { readAuthoritativeRunnerLifecycle } from
  "../src/runner/runner_lifecycle_reader.js";
import {
  openRunnerSqliteDatabase,
  openRunnerSqliteReadOnlyDatabase,
  RUNNER_SQLITE_BUSY_TIMEOUT_MS,
  withRunnerSqliteBusyRetry,
} from "../src/runner/runner_sqlite_connection.js";
import { RunnerSqliteEventOutbox } from "../src/runner/sqlite_event_outbox.js";
import { RunnerSqliteLifecycle } from "../src/runner/sqlite_runner_lifecycle.js";

const tempDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirectories.splice(0).map(
    async (directory) => await rm(directory, { recursive: true, force: true }),
  ));
});

describe("runner SQLite contention", () => {
  it("applies the busy timeout to writable and read-only connections", async () => {
    const databasePath = await createDatabase();
    const writable = openRunnerSqliteDatabase(databasePath);
    const readOnly = openRunnerSqliteReadOnlyDatabase(databasePath);
    try {
      expect(writable.prepare("PRAGMA busy_timeout").get()).toEqual({
        timeout: RUNNER_SQLITE_BUSY_TIMEOUT_MS,
      });
      expect(readOnly.prepare("PRAGMA busy_timeout").get()).toEqual({
        timeout: RUNNER_SQLITE_BUSY_TIMEOUT_MS,
      });
      expect(() => readOnly.exec("DELETE FROM runner_event_outbox"))
        .toThrow(/readonly database/i);
    } finally {
      readOnly.close();
      writable.close();
    }
  });

  it("retries only transient SQLite busy errors and preserves exhaustion", () => {
    const transient = Object.assign(new Error("database is locked"), {
      code: "ERR_SQLITE_ERROR",
      errcode: 5,
      errstr: "database is locked",
    });
    const operation = vi.fn()
      .mockImplementationOnce(() => { throw transient; })
      .mockImplementationOnce(() => { throw transient; })
      .mockReturnValue("written");
    const sleep = vi.fn();

    expect(withRunnerSqliteBusyRetry(operation, {
      retryDelaysMs: [10, 20],
      sleep,
    })).toBe("written");
    expect(sleep.mock.calls).toEqual([[10], [20]]);
    expect(operation).toHaveBeenCalledTimes(3);

    expect(() => withRunnerSqliteBusyRetry(() => {
      throw transient;
    }, { retryDelaysMs: [1], sleep })).toThrow(transient);
    expect(() => withRunnerSqliteBusyRetry(() => {
      throw Object.assign(new Error("syntax error"), { errcode: 1 });
    }, { retryDelaysMs: [1], sleep })).toThrow("syntax error");
  });

  it("keeps a WAL lifecycle reader and critical writer alive across a process lock", async () => {
    const databasePath = await createDatabase();
    const lifecycle = RunnerSqliteLifecycle.open(databasePath);
    lifecycle.begin({
      pid: process.pid,
      commandId: "execute-a",
      progressedAt: "2026-08-13T00:00:00.000Z",
    });

    const { child, exited } = await holdWriteLock(
      databasePath,
      RUNNER_SQLITE_BUSY_TIMEOUT_MS + 200,
    );
    const startedAt = Date.now();
    try {
      await expect(readAuthoritativeRunnerLifecycle(databasePath)).resolves.toMatchObject({
        execution_command_id: "execute-a",
        progress_seq: 1,
      });
      expect(lifecycle.progress("execute-a", "2026-08-13T00:00:01.000Z"))
        .toMatchObject({ progress_seq: 2 });
      expect(Date.now() - startedAt).toBeGreaterThanOrEqual(
        RUNNER_SQLITE_BUSY_TIMEOUT_MS,
      );
      const [exitCode] = await exited;
      expect(exitCode).toBe(0);
    } finally {
      if (child.exitCode === null) child.kill();
      lifecycle.close();
    }
  });
});

async function createDatabase(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "runner-sqlite-busy-"));
  tempDirectories.push(directory);
  const databasePath = join(directory, "runner.sqlite");
  const outbox = await RunnerSqliteEventOutbox.create(databasePath);
  await outbox.initializeBootstrap({
    session_id: "session-a",
    created_at: "2026-08-13T00:00:00.000Z",
    resume: {
      schema_version: 1,
      backend_session_id: "backend-a",
      cwd: "/workspace/a",
      codex_home: "/home/test/.codex",
      rollout_root: "/home/test/.codex/sessions",
      code_sha: "release-a",
      snapshot_path: "/release/release-a/soul-server-ts",
    },
  });
  outbox.close();
  return databasePath;
}

async function holdWriteLock(databasePath: string, holdMs: number): Promise<{
  child: ReturnType<typeof spawn>;
  exited: Promise<unknown[]>;
}> {
  const script = `
    import { DatabaseSync } from "node:sqlite";
    const database = new DatabaseSync(process.argv[1]);
    database.exec("PRAGMA busy_timeout = 0; BEGIN IMMEDIATE");
    database.prepare("UPDATE runner_event_outbox SET progress_seq = progress_seq").run();
    process.stdout.write("locked\\n");
    setTimeout(() => {
      database.exec("COMMIT");
      database.close();
    }, Number(process.argv[2]));
  `;
  const child = spawn(process.execPath, [
    "--input-type=module",
    "--eval",
    script,
    databasePath,
    String(holdMs),
  ], { stdio: ["ignore", "pipe", "pipe"] });
  const exited = once(child, "exit");
  await new Promise<void>((resolve, reject) => {
    let stdout = "";
    let stderr = "";
    child.stdout!.setEncoding("utf8");
    child.stderr!.setEncoding("utf8");
    child.stdout!.on("data", (chunk: string) => {
      stdout += chunk;
      if (stdout.includes("locked\n")) resolve();
    });
    child.stderr!.on("data", (chunk: string) => { stderr += chunk; });
    child.once("error", reject);
    child.once("exit", (code) => {
      if (!stdout.includes("locked\n")) {
        reject(new Error(`lock holder exited ${code}: ${stderr}`));
      }
    });
  });
  return { child, exited };
}

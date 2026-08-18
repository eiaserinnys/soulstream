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
  RUNNER_SQLITE_BUSY_RETRY_DELAYS_MS,
  withRunnerSqliteBusyRetry,
  withRunnerSqliteTransaction,
} from "../src/runner/runner_sqlite_connection.js";
import { RunnerSqliteEventOutbox } from "../src/runner/sqlite_event_outbox.js";
import { RunnerSqliteLifecycle } from "../src/runner/sqlite_runner_lifecycle.js";

const tempDirectories: string[] = [];

afterEach(async () => {
  vi.useRealTimers();
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

  it("retries only transient SQLite busy errors and preserves exhaustion", async () => {
    const transient = Object.assign(new Error("database is locked"), {
      code: "ERR_SQLITE_ERROR",
      errcode: 5,
      errstr: "database is locked",
    });
    const operation = vi.fn()
      .mockImplementationOnce(() => { throw transient; })
      .mockImplementationOnce(() => { throw transient; })
      .mockReturnValue("written");
    const sleep = vi.fn(async () => {});

    await expect(withRunnerSqliteBusyRetry(operation, {
      retryDelaysMs: [10, 20],
      sleep,
    })).resolves.toBe("written");
    expect(sleep.mock.calls).toEqual([[10], [20]]);
    expect(operation).toHaveBeenCalledTimes(3);

    await expect(withRunnerSqliteBusyRetry(() => {
      throw transient;
    }, { retryDelaysMs: [1], sleep })).rejects.toBe(transient);
    await expect(withRunnerSqliteBusyRetry(() => {
      throw Object.assign(new Error("syntax error"), { errcode: 1 });
    }, { retryDelaysMs: [1], sleep })).rejects.toThrow("syntax error");
  });

  it("yields the event loop while waiting between busy attempts", async () => {
    const transient = Object.assign(new Error("database is locked"), { errcode: 5 });
    let attempt = 0;
    let timerObservedByRetry = false;
    setTimeout(() => { timerObservedByRetry = true; }, 0);

    await expect(withRunnerSqliteBusyRetry(() => {
      attempt += 1;
      if (attempt === 1) throw transient;
      return timerObservedByRetry;
    }, { retryDelaysMs: [10] })).resolves.toBe(true);
    expect(attempt).toBe(2);
  });

  it("preserves the legacy contention budget without blocking between attempts", async () => {
    vi.useFakeTimers();
    const legacyContentionBudgetMs = 15_250;
    const transient = Object.assign(new Error("database is locked"), { errcode: 5 });
    let attempts = 0;
    let settled = false;
    const result = withRunnerSqliteBusyRetry(() => {
      attempts += 1;
      throw transient;
    }).then(
      () => "resolved" as const,
      () => "rejected" as const,
    );
    void result.finally(() => { settled = true; });

    await vi.advanceTimersByTimeAsync(legacyContentionBudgetMs - 1);
    expect(settled).toBe(false);
    await vi.runAllTimersAsync();

    await expect(result).resolves.toBe("rejected");
    expect(attempts).toBe(RUNNER_SQLITE_BUSY_RETRY_DELAYS_MS.length + 1);
    const configuredBudgetMs = RUNNER_SQLITE_BUSY_RETRY_DELAYS_MS.reduce(
      (total, delayMs) => total + delayMs,
      RUNNER_SQLITE_BUSY_TIMEOUT_MS * attempts,
    );
    expect(configuredBudgetMs).toBeGreaterThanOrEqual(legacyContentionBudgetMs);
    expect(RUNNER_SQLITE_BUSY_TIMEOUT_MS).toBeLessThanOrEqual(50);
  });

  it("records monotonic transaction attempts and BEGIN/COMMIT stages", async () => {
    const events: Array<{
      attempt: number;
      stage: string;
      startedAtMonoMs: number;
      attemptStartedAtMonoMs: number;
      observedAtMonoMs: number;
      elapsedMs: number;
      attemptElapsedMs: number;
    }> = [];
    const database = {
      exec: vi.fn(),
    };

    await expect(withRunnerSqliteTransaction(
      database as never,
      () => "committed",
      {
        transactionLabel: "test.commit",
        observer: (event) => events.push(event),
      },
    )).resolves.toBe("committed");

    expect(database.exec.mock.calls).toEqual([["BEGIN IMMEDIATE"], ["COMMIT"]]);
    expect(events.map((event) => event.stage)).toEqual([
      "begin",
      "operation",
      "commit",
      "completed",
    ]);
    expect(events.every((event) => event.attempt === 1)).toBe(true);
    expect(events.every((event) => event.observedAtMonoMs >= event.startedAtMonoMs)).toBe(true);
    expect(events.every((event) => event.elapsedMs >= 0)).toBe(true);
    expect(events.every(
      (event) => event.observedAtMonoMs >= event.attemptStartedAtMonoMs,
    )).toBe(true);
    expect(events.every((event) => event.attemptElapsedMs >= 0)).toBe(true);
  });

  it("distinguishes monotonic timing for each transaction retry attempt", async () => {
    const transient = Object.assign(new Error("database is locked"), { errcode: 5 });
    const events: Array<{
      attempt: number;
      stage: string;
      retryDelayMs?: number;
      attemptStartedAtMonoMs: number;
      attemptElapsedMs: number;
    }> = [];
    const database = {
      exec: vi.fn()
        .mockImplementationOnce(() => { throw transient; })
        .mockImplementation(() => undefined),
    };

    await expect(withRunnerSqliteTransaction(
      database as never,
      () => "committed",
      {
        transactionLabel: "test.retry",
        retryDelaysMs: [10],
        sleep: async () => {},
        observer: (event) => events.push(event),
      },
    )).resolves.toBe("committed");

    expect(events.map(({ attempt, stage }) => ({ attempt, stage }))).toEqual([
      { attempt: 1, stage: "begin" },
      { attempt: 1, stage: "retry_wait" },
      { attempt: 2, stage: "begin" },
      { attempt: 2, stage: "operation" },
      { attempt: 2, stage: "commit" },
      { attempt: 2, stage: "completed" },
    ]);
    expect(events[1]?.retryDelayMs).toBe(10);
    expect(events[2]!.attemptStartedAtMonoMs).toBeGreaterThanOrEqual(
      events[0]!.attemptStartedAtMonoMs,
    );
    expect(events.every((event) => event.attemptElapsedMs >= 0)).toBe(true);
  });

  it("fails a child lifecycle write quickly instead of masking a second writer", async () => {
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
      expect(() => lifecycle.progress("execute-a", "2026-08-13T00:00:01.000Z"))
        .toThrow(/database is locked/i);
      expect(Date.now() - startedAt).toBeLessThan(500);
      const [exitCode] = await exited;
      expect(exitCode).toBe(0);
    } finally {
      if (child.exitCode === null) child.kill();
      lifecycle.close();
    }
  });

  it("keeps restart recovery bounded behind a long external writer and succeeds after release", async () => {
    const databasePath = await createDatabase();
    const firstHost = RunnerSqliteLifecycle.open(databasePath);
    firstHost.begin({
      pid: process.pid,
      commandId: "execute-restart",
      progressedAt: "2026-08-13T00:00:00.000Z",
    });
    firstHost.close();

    const { child, exited } = await holdWriteLock(databasePath, 350);
    const restartedHost = RunnerSqliteLifecycle.open(databasePath);
    const startedAt = Date.now();
    try {
      await expect(withRunnerSqliteBusyRetry(
        () => restartedHost.progress(
          "execute-restart",
          "2026-08-13T00:00:01.000Z",
        ),
        { retryDelaysMs: [10, 20] },
      )).rejects.toThrow(/database is locked/i);
      expect(Date.now() - startedAt).toBeLessThan(500);
      expect(child.pid).toEqual(expect.any(Number));

      const [exitCode] = await exited;
      expect(exitCode).toBe(0);
      expect(restartedHost.progress(
        "execute-restart",
        "2026-08-13T00:00:02.000Z",
      )).toMatchObject({
        execution_command_id: "execute-restart",
        execution_state: "running",
        progress_seq: 2,
      });
    } finally {
      if (child.exitCode === null) child.kill();
      restartedHost.close();
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

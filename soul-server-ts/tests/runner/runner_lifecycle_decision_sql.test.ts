import { createRequire } from "node:module";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  RunnerSqliteLifecycle,
  finishRunnerExecutionWithinTransaction,
} from "../../src/runner/sqlite_runner_lifecycle.js";
import {
  RunnerSqliteEventOutbox,
  type RunnerBootstrapInput,
} from "../../src/runner/sqlite_event_outbox.js";
import {
  runnerLifecycleDecisionTable,
  type RunnerLifecycleDecisionRow,
} from "../../src/runner/state/runner_charts.js";
import type {
  RunnerLifecycleState,
  RunnerLifecycleStep,
} from "../../src/runner/state/runner_lifecycle_machine.js";

const { DatabaseSync } = createRequire(import.meta.url)("node:sqlite") as
  typeof import("node:sqlite");

const COMMAND_ID = "execute-lifecycle";
const MATCHING_COMMAND = COMMAND_ID;
const MISMATCHED_COMMAND = "execute-other";
const SESSION_ID = "session-a";
const STARTED_AT = "2026-11-13T00:00:01.000Z";
const STEP_AT = "2026-11-13T00:00:02.000Z";

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(directories.splice(0).map(
    async (directory) => await rm(directory, { recursive: true, force: true }),
  ));
});

type Outcome = "changed" | "unchanged" | "rejected";

describe("runner lifecycle decision table against real SQLite", () => {
  it.each(["bootstrap", "prebootstrap"] as const)(
    "matches every state, step, and command match combination on the %s table",
    async (layout) => {
      const outcomes: Record<string, Outcome> = {};
      for (const row of runnerLifecycleDecisionTable()) {
        const path = await createRunner(layout);
        arrangeState(path, row.state);
        outcomes[`${row.state}/${row.step}/${row.commandMatches}`] =
          await executeStep(path, row);
      }

      for (const row of runnerLifecycleDecisionTable()) {
        expect(
          outcomes[`${row.state}/${row.step}/${row.commandMatches}`],
          `${layout}: ${row.state}/${row.step}/${row.commandMatches}`,
        ).toBe(expectedOutcome(row));
      }
    },
    300_000,
  );

  it("ignores a late finish after close instead of overriding the closed state", async () => {
    const path = await createRunner();
    const lifecycle = RunnerSqliteLifecycle.open(path);
    try {
      lifecycle.begin({
        pid: process.pid,
        commandId: COMMAND_ID,
        progressedAt: STARTED_AT,
      });
      lifecycle.finish(COMMAND_ID, "closed", STEP_AT);
      const closed = lifecycle.read();

      await expect(finishAt(path, {
        commandId: COMMAND_ID,
        state: "completed",
        progressedAt: "2026-11-13T00:00:03.000Z",
        terminalError: null,
      })).resolves.toBe("ignored");
      await expect(finishAt(path, {
        commandId: COMMAND_ID,
        state: "failed",
        progressedAt: "2026-11-13T00:00:03.000Z",
        terminalError: { code: "late", message: "late failure" },
      })).resolves.toBe("ignored");

      expect(lifecycle.read()).toEqual(closed);
      expect(lifecycle.read()).toMatchObject({ execution_state: "closed" });
    } finally {
      lifecycle.close();
    }
  });

  it("ignores a late finish after reaping instead of overriding the reaped state", async () => {
    const path = await createRunner();
    const lifecycle = RunnerSqliteLifecycle.open(path);
    try {
      lifecycle.begin({
        pid: process.pid,
        commandId: COMMAND_ID,
        progressedAt: STARTED_AT,
      });
      lifecycle.reap(COMMAND_ID, STEP_AT, {
        code: "reaped",
        message: "runner process is gone",
      });
      const reaped = lifecycle.read();

      await expect(finishAt(path, {
        commandId: COMMAND_ID,
        state: "failed",
        progressedAt: "2026-11-13T00:00:03.000Z",
        terminalError: { code: "late", message: "late failure" },
      })).resolves.toBe("ignored");

      expect(lifecycle.read()).toEqual(reaped);
      expect(lifecycle.read()).toMatchObject({ execution_state: "reaped" });
    } finally {
      lifecycle.close();
    }
  });

  it("rejects a mismatched finish without touching the running row", async () => {
    const path = await createRunner();
    const lifecycle = RunnerSqliteLifecycle.open(path);
    try {
      lifecycle.begin({
        pid: process.pid,
        commandId: COMMAND_ID,
        progressedAt: STARTED_AT,
      });
      const running = lifecycle.read();

      await expect(finishAt(path, {
        commandId: MISMATCHED_COMMAND,
        state: "completed",
        progressedAt: "2026-11-13T00:00:03.000Z",
        terminalError: null,
      })).rejects.toThrow("runner lifecycle command mismatch");
      expect(lifecycle.read()).toEqual(running);
    } finally {
      lifecycle.close();
    }
  });
});

function expectedOutcome(row: RunnerLifecycleDecisionRow): Outcome {
  if (row.decision === "apply") return "changed";
  if (row.decision === "ignore") return "unchanged";
  return "rejected";
}

async function createRunner(
  layout: "bootstrap" | "prebootstrap" = "bootstrap",
): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "soulstream-runner-lifecycle-"));
  directories.push(directory);
  const path = join(directory, "runner.sqlite");
  const outbox = await RunnerSqliteEventOutbox.create(path);
  if (layout === "bootstrap") {
    await outbox.initializeBootstrap(bootstrapInput());
  }
  outbox.close();
  return path;
}

function arrangeState(path: string, state: RunnerLifecycleState): void {
  if (state === "none") return;
  const lifecycle = RunnerSqliteLifecycle.open(path, SESSION_ID);
  try {
    lifecycle.begin({
      pid: process.pid,
      commandId: COMMAND_ID,
      progressedAt: STARTED_AT,
    });
    switch (state) {
      case "running":
        return;
      case "completed":
        lifecycle.finish(COMMAND_ID, "completed", STEP_AT);
        return;
      case "failed":
        lifecycle.finish(COMMAND_ID, "failed", STEP_AT, {
          code: "execution_failed",
          message: "failed state fixture",
        });
        return;
      case "closed":
        lifecycle.finish(COMMAND_ID, "closed", STEP_AT);
        return;
      case "reaped":
        lifecycle.reap(COMMAND_ID, STEP_AT, {
          code: "reaped",
          message: "reaped state fixture",
        });
        return;
    }
  } finally {
    lifecycle.close();
  }
}

async function executeStep(
  path: string,
  row: RunnerLifecycleDecisionRow,
): Promise<Outcome> {
  const lifecycle = RunnerSqliteLifecycle.open(path, SESSION_ID);
  try {
    const before = lifecycle.read();
    const commandId = row.commandMatches ? MATCHING_COMMAND : MISMATCHED_COMMAND;
    try {
      await applyStep(path, lifecycle, row.step, commandId);
    } catch (error) {
      if (error instanceof Error) return "rejected";
      throw error;
    }
    return JSON.stringify(lifecycle.read()) === JSON.stringify(before)
      ? "unchanged"
      : "changed";
  } finally {
    lifecycle.close();
  }
}

async function applyStep(
  path: string,
  lifecycle: RunnerSqliteLifecycle,
  step: RunnerLifecycleStep,
  commandId: string,
): Promise<void> {
  switch (step) {
    case "begin":
      lifecycle.begin({ pid: process.pid, commandId, progressedAt: STEP_AT });
      return;
    case "progress":
      lifecycle.progress(commandId, STEP_AT);
      return;
    case "liveness":
      lifecycle.liveness(commandId, STEP_AT);
      return;
    case "tool_started":
      lifecycle.toolStarted(commandId, "tool-1", STEP_AT);
      return;
    case "tool_finished":
      lifecycle.toolFinished(commandId, "tool-1", STEP_AT);
      return;
    case "finish_completed":
      await finishAt(path, {
        commandId,
        state: "completed",
        progressedAt: STEP_AT,
        terminalError: null,
      });
      return;
    case "finish_failed":
      await finishAt(path, {
        commandId,
        state: "failed",
        progressedAt: STEP_AT,
        terminalError: { code: "execution_failed", message: "step fixture" },
      });
      return;
    case "finish_closed":
      await finishAt(path, {
        commandId,
        state: "closed",
        progressedAt: STEP_AT,
        terminalError: null,
      });
      return;
    case "reap":
      lifecycle.reap(commandId, STEP_AT, {
        code: "reaped",
        message: "step fixture",
      });
      return;
  }
}

async function finishAt(
  path: string,
  input: {
    commandId: string;
    state: "completed" | "failed" | "closed";
    progressedAt: string;
    terminalError: { code: string; message: string } | null;
  },
): Promise<"applied" | "ignored"> {
  const database = new DatabaseSync(path);
  try {
    database.exec("BEGIN IMMEDIATE");
    try {
      const outcome = finishRunnerExecutionWithinTransaction(database, input);
      database.exec("COMMIT");
      return outcome;
    } catch (error) {
      database.exec("ROLLBACK");
      throw error;
    }
  } finally {
    database.close();
  }
}

function bootstrapInput(): RunnerBootstrapInput {
  return {
    session_id: "session-a",
    created_at: "2026-11-13T00:00:00.000Z",
    resume: {
      schema_version: 1,
      backend_session_id: "backend-session-a",
      cwd: "/workspace/session-a",
      codex_home: "/workspace/session-a/.codex",
      rollout_root: "/workspace/session-a/.codex/sessions",
      code_sha: "sha-a",
      snapshot_path: "/releases/sha-a/soul-server-ts",
    },
  };
}

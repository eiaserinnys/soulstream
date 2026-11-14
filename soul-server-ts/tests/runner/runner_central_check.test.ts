import { describe, expect, it } from "vitest";

import type { RunnerRegistration } from "../../src/runner/runner_process_registry.js";
import {
  classifyRunnerCentralLookup,
  registrationAppliedAndTurnRunning,
  terminalRetainedForRegistration,
} from "../../src/runner/runner_central_check.js";
import {
  RUNNER_CENTRAL_RETRY_BASE_MS,
  RUNNER_CENTRAL_RETRY_MAX_MS,
  classifyRunnerAdoptRejection,
  runnerCentralRetryDelayMs,
} from "../../src/runner/state/runner_central_check_decision.js";
import type { Task } from "../../src/task/task_models.js";

describe("runner central session lookup", () => {
  it("classifies the five lookup results without consulting memory", () => {
    expect(classifyRunnerCentralLookup(null, "node-a")).toBe("missing");
    expect(classifyRunnerCentralLookup({ node_id: "node-b", status: "running" }, "node-a"))
      .toBe("owner_node_changed");
    expect(classifyRunnerCentralLookup({ node_id: "node-a", status: "initializing" }, "node-a"))
      .toBe("active");
    expect(classifyRunnerCentralLookup({ node_id: null, status: "running" }, "node-a"))
      .toBe("active");
    expect(classifyRunnerCentralLookup({ node_id: "node-a", status: "completed" }, "node-a"))
      .toBe("inactive");
    expect(classifyRunnerCentralLookup({ node_id: "node-a", status: null }, "node-a"))
      .toBe("inactive");
  });
});

describe("runner adoption rejection classification", () => {
  it("treats the terminal reasons and a busy worktree as not worth retrying", () => {
    for (const reason of ["already_terminal", "session_missing", "owner_node_changed", "worktree_busy"]) {
      expect(classifyRunnerAdoptRejection(reason)).toBe("terminal_rejection");
    }
  });

  it("treats a worktree that is not ready, a missing reason, and unknown values as retryable", () => {
    for (const reason of [
      "worktree_not_ready",
      undefined,
      null,
      "something_new",
    ]) {
      expect(classifyRunnerAdoptRejection(reason)).toBe("retryable_rejection");
    }
  });
});

describe("runner central retry interval", () => {
  it("starts at 15 seconds, doubles, and stops at 5 minutes", () => {
    expect(RUNNER_CENTRAL_RETRY_BASE_MS).toBe(15_000);
    expect(RUNNER_CENTRAL_RETRY_MAX_MS).toBe(300_000);
    expect([1, 2, 3, 4, 5, 6, 7].map(runnerCentralRetryDelayMs)).toEqual([
      15_000,
      30_000,
      60_000,
      120_000,
      240_000,
      300_000,
      300_000,
    ]);
  });
});

describe("runner central check facts", () => {
  function registration(registrationId = "registration-a"): RunnerRegistration {
    return { registrationId } as unknown as RunnerRegistration;
  }

  function terminalTask(): Task {
    return {
      agentSessionId: "session-a",
      prompt: "continue",
      status: "completed",
      terminationReason: "completed_ok",
      terminationEventRecorded: true,
      terminalEventId: 7,
      createdAt: new Date("2026-08-11T00:00:00.000Z"),
      lastEventId: 0,
      lastReadEventId: 0,
      interventionQueue: [],
    };
  }

  it("counts a recorded terminal as retained only for background work or an exact claim", () => {
    const runner = {} as NonNullable<Task["runner"]>;
    const task = terminalTask();
    expect(terminalRetainedForRegistration(task, registration())).toBe(false);

    task.runnerRetainedForDetachedWork = true;
    expect(terminalRetainedForRegistration(task, registration())).toBe(true);

    task.runnerRetainedForDetachedWork = undefined;
    task.runner = runner;
    task.runnerReleaseClaim = {
      registrationId: "registration-a",
      runner,
      completion: Promise.resolve(),
      resolve: () => {},
    } as NonNullable<Task["runnerReleaseClaim"]>;
    expect(terminalRetainedForRegistration(task, registration())).toBe(true);
    expect(terminalRetainedForRegistration(task, registration("registration-b")))
      .toBe(false);
  });

  it("requires an attached, registered, running turn for this registration", () => {
    const base = {
      isClosed: () => false,
      hasActiveExecution: () => true,
      registrationId: () => "registration-a",
    };
    const task = terminalTask();
    task.status = "running";

    expect(registrationAppliedAndTurnRunning(task, registration())).toBe(false);

    task.runner = { dispatcher: base } as unknown as NonNullable<Task["runner"]>;
    expect(registrationAppliedAndTurnRunning(task, registration())).toBe(false);

    task.executionRegistration = {
      registrationId: "registration-a",
      executionCommandId: "execute-a",
    };
    expect(registrationAppliedAndTurnRunning(task, registration())).toBe(true);
    expect(registrationAppliedAndTurnRunning(task, registration("registration-b")))
      .toBe(false);

    task.runnerIsOfflineReplay = true;
    expect(registrationAppliedAndTurnRunning(task, registration())).toBe(false);

    task.runnerIsOfflineReplay = undefined;
    task.runner = {
      dispatcher: { ...base, isClosed: () => true },
    } as unknown as NonNullable<Task["runner"]>;
    expect(registrationAppliedAndTurnRunning(task, registration())).toBe(false);

    task.runner = {
      dispatcher: { ...base, hasActiveExecution: () => false },
    } as unknown as NonNullable<Task["runner"]>;
    expect(registrationAppliedAndTurnRunning(task, registration())).toBe(false);
  });
});

import { describe, expect, it } from "vitest";

import {
  EXECUTION_ENTRY_PATHS,
  RUNNER_TERMINAL_FACTS,
  executionEntryTransitionId,
  isCompleteExecutionIdentity,
  runnerFactProjection,
} from "../../src/task/execution_ownership.js";

describe("execution ownership contract", () => {
  it("enumerates every running entry path with a stable activation identity", () => {
    expect(EXECUTION_ENTRY_PATHS).toEqual(["initial", "auto_resume", "adopt"]);
    expect(EXECUTION_ENTRY_PATHS.map((path) =>
      executionEntryTransitionId(path, 7))).toEqual([
      "initial:7",
      "auto_resume:7",
      "adopt:7",
    ]);
  });

  it("maps all four runner facts onto the three canonical terminal states", () => {
    expect(RUNNER_TERMINAL_FACTS.map((fact) => [fact, runnerFactProjection(fact)]))
      .toEqual([
        ["completed", { status: "completed", terminationReason: "completed_ok" }],
        ["failed", { status: "error", terminationReason: "error_aborted" }],
        ["reaped", { status: "error", terminationReason: "error_aborted" }],
        ["closed", { status: "interrupted", terminationReason: "killed" }],
      ]);
  });

  it("requires the complete process identity before activation", () => {
    const complete = {
      registrationId: "registration-a",
      pid: 123,
      startIdentity: "start-a",
      executionCommandId: "execute-a",
    };
    expect(isCompleteExecutionIdentity(complete)).toBe(true);
    for (const key of Object.keys(complete) as Array<keyof typeof complete>) {
      expect(isCompleteExecutionIdentity({ ...complete, [key]: key === "pid" ? 0 : "" }))
        .toBe(false);
    }
  });
});

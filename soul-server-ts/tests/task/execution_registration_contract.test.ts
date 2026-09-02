import { describe, expect, it } from "vitest";

import {
  RUNNER_TERMINAL_FACTS,
  isCompleteRunnerExecutionIdentity,
  runnerFactProjection,
} from "../../src/task/execution_registration.js";

describe("execution registration contract", () => {
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
    expect(isCompleteRunnerExecutionIdentity(complete)).toBe(true);
    for (const key of Object.keys(complete) as Array<keyof typeof complete>) {
      expect(isCompleteRunnerExecutionIdentity({ ...complete, [key]: key === "pid" ? 0 : "" }))
        .toBe(false);
    }
  });
});

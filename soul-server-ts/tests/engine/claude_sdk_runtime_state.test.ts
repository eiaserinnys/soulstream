import { describe, expect, it } from "vitest";

import { ClaudeRuntimeState } from
  "../../src/engine/claude_sdk_runtime_state.js";

describe("ClaudeRuntimeState", () => {
  it("does not resurrect terminal work when a late progress event arrives", () => {
    const state = new ClaudeRuntimeState(true);
    state.setTaskStatus("bg-1", "running");
    state.setTaskStatus("bg-1", "completed");
    state.setTaskStatus("bg-1", "running");

    expect(state.getTaskStatus("bg-1")).toBe("completed");
    expect(state.hasPendingWork()).toBe(false);
  });

  it("keeps legacy status replacement semantics when monotonic mode is absent", () => {
    const state = new ClaudeRuntimeState();
    state.setTaskStatus("bg-legacy", "completed");
    state.setTaskStatus("bg-legacy", "running");

    expect(state.getTaskStatus("bg-legacy")).toBe("running");
    expect(state.hasPendingWork()).toBe(true);
  });
});

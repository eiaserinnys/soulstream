import { describe, expect, it } from "vitest";

import { supervisorUsageDeltaForEvent } from "../../src/task/supervisor_usage.js";
import type { Task } from "../../src/task/task_models.js";

function makeTask(): Task {
  return {
    agentSessionId: "sess-usage",
    prompt: "",
    status: "running",
    createdAt: new Date(),
    lastEventId: 0,
    lastReadEventId: 0,
    interventionQueue: [],
  };
}

describe("supervisor usage normalization", () => {
  it("counts only new token delta for the same Codex app-server turn", () => {
    const task = makeTask();

    expect(supervisorUsageDeltaForEvent(task, {
      type: "complete",
      turn_id: "turn-1",
      usage: { input_tokens: 100, output_tokens: 20 },
    } as never)).toEqual({ tokenDelta: 120, compactionDelta: 0 });
    expect(supervisorUsageDeltaForEvent(task, {
      type: "complete",
      turn_id: "turn-1",
      usage: { input_tokens: 100, output_tokens: 20 },
    } as never)).toEqual({ tokenDelta: 0, compactionDelta: 0 });
    expect(supervisorUsageDeltaForEvent(task, {
      type: "complete",
      turn_id: "turn-1",
      usage: { input_tokens: 110, output_tokens: 25 },
    } as never)).toEqual({ tokenDelta: 15, compactionDelta: 0 });
  });

  it("uses persisted event id as fallback slot when turn id is absent", () => {
    const task = makeTask();

    expect(supervisorUsageDeltaForEvent(task, {
      type: "complete",
      _event_id: 7,
      usage: { prompt_tokens: 10, completion_tokens: 5 },
    } as never)).toEqual({ tokenDelta: 15, compactionDelta: 0 });
    expect(supervisorUsageDeltaForEvent(task, {
      type: "complete",
      _event_id: 7,
      usage: { prompt_tokens: 10, completion_tokens: 5 },
    } as never)).toEqual({ tokenDelta: 0, compactionDelta: 0 });
  });

  it("tracks Claude context usage as monotonic delta and resets on compact", () => {
    const task = makeTask();

    expect(supervisorUsageDeltaForEvent(task, {
      type: "context_usage",
      used_tokens: 400,
    } as never)).toEqual({ tokenDelta: 400, compactionDelta: 0 });
    expect(supervisorUsageDeltaForEvent(task, {
      type: "context_usage",
      used_tokens: 450,
    } as never)).toEqual({ tokenDelta: 50, compactionDelta: 0 });
    expect(supervisorUsageDeltaForEvent(task, {
      type: "compact",
    } as never)).toEqual({ tokenDelta: 0, compactionDelta: 1 });
    expect(supervisorUsageDeltaForEvent(task, {
      type: "context_usage",
      used_tokens: 100,
    } as never)).toEqual({ tokenDelta: 100, compactionDelta: 0 });
  });
});

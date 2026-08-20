import pino from "pino";
import { describe, expect, it, vi } from "vitest";

import type { Task } from "../../src/task/task_models.js";
import { AutoResumeTransition } from "../../src/task/task_auto_resume_transition.js";

import { makeEventPersistenceTestDouble } from "./event_persistence_test_double.js";

const silentLogger = pino({ level: "silent" });

function makeTerminalTask(): Task {
  return {
    agentSessionId: "s1",
    prompt: "original prompt",
    status: "completed",
    profileId: "codex-default",
    createdAt: new Date("2026-08-21T00:00:00.000Z"),
    completedAt: new Date("2026-08-21T00:05:00.000Z"),
    lastEventId: 7,
    terminalEventId: 6,
    lastReadEventId: 3,
    interventionQueue: [],
    metadata: [],
  };
}

describe("AutoResumeTransition caller metadata", () => {
  it("appends equivalent caller_info once and appends a changed caller", async () => {
    const task = makeTerminalTask();
    const persistenceDouble = makeEventPersistenceTestDouble();
    const transition = new AutoResumeTransition({
      logger: silentLogger,
      persistence: persistenceDouble.persistence,
    });
    const equivalentCallers = [
      { source: "agent", agent_id: "seosoyoung", display_name: "서소영" },
      { display_name: "서소영", source: "agent", agent_id: "seosoyoung" },
      { agent_id: "seosoyoung", display_name: "서소영", source: "agent" },
    ];

    for (const callerInfo of equivalentCallers) {
      await transition.resume(
        task,
        { text: "resume", user: "u", callerInfo },
        vi.fn(),
        { publishUserMessage: false },
      );
    }
    await transition.resume(
      task,
      {
        text: "resume from another caller",
        user: "u",
        callerInfo: { source: "agent", agent_id: "roselin", display_name: "로젤린" },
      },
      vi.fn(),
      { publishUserMessage: false },
    );

    expect(task.metadata).toEqual([
      { type: "caller_info", value: equivalentCallers[0] },
      {
        type: "caller_info",
        value: { source: "agent", agent_id: "roselin", display_name: "로젤린" },
      },
    ]);
    expect(persistenceDouble.enqueueMetadataEffect).toHaveBeenCalledTimes(2);
  });
});

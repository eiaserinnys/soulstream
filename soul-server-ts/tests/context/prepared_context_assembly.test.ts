import { describe, expect, it } from "vitest";

import type { AgentProfile } from "../../src/agent_registry.js";
import type { ContextManifest } from "../../src/context/compiler/index.js";
import { assemblePreparedContext } from "../../src/context/prepared_context_assembly.js";
import type { Task } from "../../src/task/task_models.js";

const agent: AgentProfile = {
  id: "roselin",
  name: "로젤린",
  backend: "claude",
  workspace_dir: "/tmp/roselin",
};

function makeTask(overrides: Partial<Task> = {}): Task {
  return {
    agentSessionId: "sess-context",
    prompt: "이어서 진행",
    status: "running",
    createdAt: new Date("2026-11-13T01:00:00.000Z"),
    lastEventId: 3114,
    lastReadEventId: 3000,
    interventionQueue: [],
    ...overrides,
  };
}

function assemble(task: Task) {
  return assemblePreparedContext({
    nodeId: "node-1",
    task,
    agent,
    agentAtomMarkdown: null,
    atomMarkdown: null,
    taskAtomMarkdown: null,
    contextManifest: {} as ContextManifest,
    primaryFolder: null,
    pageContextItem: null,
    boardWorkspaceItem: null,
    runningSessions: null,
    assignedCardItem: null,
    predecessorSummaryItem: null,
    generationCheckpointItem: null,
    nativeSessionId: null,
    cogitoContextItem: null,
  });
}

describe("assemblePreparedContext full re-injection", () => {
  it("does not repeat the previous-turn system abort notice", () => {
    const task = makeTask({
      contextItems: [
        {
          key: "previous_turn_system_abort",
          content: {
            termination_reason: "error_aborted",
            termination_detail: "runner process exited before execution completed",
            notice: "직전 실행은 사람이 멈춘 것이 아니라 시스템 사유로 끝났습니다.",
          },
        },
        { key: "other_context", content: "keep me" },
      ],
    });

    const prepared = assemble(task);

    expect(
      prepared.combinedContextItems.filter(
        (item) => item.key === "previous_turn_system_abort",
      ),
    ).toHaveLength(0);
    expect(
      prepared.combinedContextItems.filter((item) => item.key === "other_context"),
    ).toHaveLength(1);
  });
});

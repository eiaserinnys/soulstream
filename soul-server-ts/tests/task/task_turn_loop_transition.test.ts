import { describe, expect, it } from "vitest";

import type { AgentProfile } from "../../src/agent_registry.js";
import type { Task } from "../../src/task/task_models.js";
import {
  isOpenAiAgentsApprovalPending,
  resolveTurnLoopTransition,
} from "../../src/task/task_turn_loop_transition.js";

const codexAgent: AgentProfile = {
  id: "codex-default",
  name: "Codex Default",
  backend: "codex",
  workspace_dir: "/tmp/codex-default",
};

const agentsAgent: AgentProfile = {
  id: "agent-openai",
  name: "Agents",
  backend: "openai-agents",
  workspace_dir: "/tmp/agents",
};

function makeTask(overrides: Partial<Task> = {}): Task {
  return {
    agentSessionId: "sess-1",
    prompt: "hi",
    status: "running",
    profileId: codexAgent.id,
    createdAt: new Date(),
    lastEventId: 0,
    lastReadEventId: 0,
    interventionQueue: [],
    ...overrides,
  };
}

describe("Task turn loop transition", () => {
  it("non-running task stops without mutating queued interventions", () => {
    const task = makeTask({
      status: "interrupted",
      interventionQueue: [{ text: "do not consume", user: "u" }],
    });

    const decision = resolveTurnLoopTransition(task, codexAgent);

    expect(decision).toEqual({ kind: "stop" });
    expect(task.interventionQueue).toHaveLength(1);
    expect(task.status).toBe("interrupted");
  });

  it("OpenAI Agents pending approval pauses before consuming queued interventions", () => {
    const task = makeTask({
      agentsRunState: "state-v1",
      agentsPendingApprovalId: "approval-1",
      interventionQueue: [{ text: "wait", user: "u" }],
    });

    const decision = resolveTurnLoopTransition(task, agentsAgent);

    expect(decision).toEqual({ kind: "awaiting_approval" });
    expect(task.interventionQueue).toHaveLength(1);
    expect(task.status).toBe("running");
    expect(isOpenAiAgentsApprovalPending(task)).toBe(true);
  });

  it("running task with empty queue marks the task completed and stops", () => {
    const task = makeTask();

    const decision = resolveTurnLoopTransition(task, codexAgent);

    expect(decision).toEqual({ kind: "stop" });
    expect(task.status).toBe("completed");
  });

  it("running task with queued intervention consumes one message and composes the next turn", () => {
    const task = makeTask({
      interventionQueue: [
        {
          text: "첨부 확인",
          user: "u",
          context: [{ key: "prior", label: "Prior context", content: "remember this" }],
          attachmentPaths: ["/tmp/incoming/sess/a.png", "/tmp/incoming/sess/readme.txt"],
        },
        { text: "later", user: "u" },
      ],
    });

    const decision = resolveTurnLoopTransition(task, codexAgent);

    expect(decision.kind).toBe("continue");
    if (decision.kind !== "continue") throw new Error("expected continue decision");
    expect(decision.imageAttachmentPaths).toEqual(["/tmp/incoming/sess/a.png"]);
    expect(decision.prompt).toContain("<prior>");
    expect(decision.prompt).toContain("remember this");
    expect(decision.prompt).toContain("<attached_files>");
    expect(decision.prompt).toContain("/tmp/incoming/sess/readme.txt");
    expect(decision.prompt).not.toContain("/tmp/incoming/sess/a.png");
    expect(decision.prompt.endsWith("첨부 확인")).toBe(true);
    expect(task.interventionQueue.map((item) => item.text)).toEqual(["later"]);
    expect(task.status).toBe("running");
  });
});

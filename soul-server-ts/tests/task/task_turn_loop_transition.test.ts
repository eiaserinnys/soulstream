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

  it("foreground pending Claude runtime work pauses completion before consuming queued interventions", () => {
    const task = makeTask({
      claudeRuntime: {
        sessionState: "running",
        updatedAt: Date.now(),
        tasks: {
          "task-fg-1": {
            taskId: "task-fg-1",
            status: "running",
            updatedAt: Date.now(),
          },
        },
      },
      interventionQueue: [{ text: "later", user: "u" }],
    });

    const decision = resolveTurnLoopTransition(task, codexAgent);

    expect(decision).toEqual({ kind: "awaiting_runtime" });
    expect(task.interventionQueue).toHaveLength(1);
    expect(task.status).toBe("running");
  });

  it("background-only Claude runtime work allows queued intervention continuation", () => {
    const task = makeTask({
      claudeRuntime: {
        sessionState: "idle",
        updatedAt: Date.now(),
        tasks: {
          "task-bg-1": {
            taskId: "task-bg-1",
            status: "running",
            updatedAt: Date.now(),
            isBackgrounded: true,
          },
        },
      },
      interventionQueue: [{ text: "continue while background runs", user: "u" }],
    });

    const decision = resolveTurnLoopTransition(task, codexAgent);

    expect(decision.kind).toBe("continue");
    if (decision.kind !== "continue") throw new Error("expected continue decision");
    expect(decision.prompt).toContain("continue while background runs");
    expect(task.interventionQueue).toHaveLength(0);
    expect(task.status).toBe("running");
  });

  it("background-only Claude runtime work does not block normal completion", () => {
    const task = makeTask({
      claudeRuntime: {
        sessionState: "idle",
        updatedAt: Date.now(),
        tasks: {
          "task-bg-1": {
            taskId: "task-bg-1",
            status: "running",
            updatedAt: Date.now(),
            isBackgrounded: true,
          },
        },
      },
    });

    const decision = resolveTurnLoopTransition(task, codexAgent);

    expect(decision).toEqual({ kind: "stop" });
    expect(task.status).toBe("completed");
  });

  it("idle Claude runtime with lingering unmarked task allows normal completion", () => {
    const task = makeTask({
      claudeRuntime: {
        sessionState: "idle",
        updatedAt: Date.now(),
        tasks: {
          "task-bg-unmarked": {
            taskId: "task-bg-unmarked",
            status: "running",
            updatedAt: Date.now(),
          },
        },
      },
    });

    const decision = resolveTurnLoopTransition(task, codexAgent);

    expect(decision).toEqual({ kind: "stop" });
    expect(task.status).toBe("completed");
  });

  it("idle Claude runtime with terminal tasks allows normal completion", () => {
    const task = makeTask({
      claudeRuntime: {
        sessionState: "idle",
        updatedAt: Date.now(),
        tasks: {
          "task-bg-1": {
            taskId: "task-bg-1",
            status: "completed",
            updatedAt: Date.now(),
          },
        },
      },
    });

    const decision = resolveTurnLoopTransition(task, codexAgent);

    expect(decision).toEqual({ kind: "stop" });
    expect(task.status).toBe("completed");
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
    expect(decision.prompt).toContain(
      "[첨부 파일 로컬 경로: /tmp/incoming/sess/a.png]",
    );
    expect(decision.prompt).toContain(
      "[첨부 파일 로컬 경로: /tmp/incoming/sess/readme.txt]",
    );
    expect(decision.prompt).toContain("/tmp/incoming/sess/readme.txt");
    expect(decision.prompt.endsWith(
      "[첨부 파일 로컬 경로: /tmp/incoming/sess/readme.txt]",
    )).toBe(true);
    expect(task.interventionQueue.map((item) => item.text)).toEqual(["later"]);
    expect(task.status).toBe("running");
  });

  it("continue decision preserves the consumed intervention metadata", () => {
    const task = makeTask({
      interventionQueue: [
        {
          text: "runtime follow-up",
          user: "system",
          source: "claude_runtime_task_followup",
          followupAttempt: 1,
          followupKey: "sess-1:task-1",
        },
      ],
    });

    const decision = resolveTurnLoopTransition(task, codexAgent);

    expect(decision.kind).toBe("continue");
    if (decision.kind !== "continue") throw new Error("expected continue decision");
    expect(decision.intervention).toMatchObject({
      source: "claude_runtime_task_followup",
      followupAttempt: 1,
      followupKey: "sess-1:task-1",
    });
  });
});

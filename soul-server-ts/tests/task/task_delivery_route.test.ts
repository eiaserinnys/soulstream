import { describe, expect, it, vi } from "vitest";

import type {
  EnginePort,
  SupportsInputResponse,
  SupportsToolApproval,
} from "../../src/engine/protocol.js";
import { TaskDeliveryRoute } from "../../src/task/task_delivery_route.js";
import type { Task } from "../../src/task/task_models.js";

function makeTask(overrides: Partial<Task> = {}): Task {
  return {
    agentSessionId: "sess-delivery",
    prompt: "waiting for external response",
    status: "running",
    createdAt: new Date("2026-05-23T01:00:00.000Z"),
    lastEventId: 0,
    lastReadEventId: 0,
    interventionQueue: [],
    ...overrides,
  };
}

function makeBaseEngine(overrides: Partial<EnginePort> = {}): EnginePort {
  return {
    backendId: "claude",
    workspaceDir: "/tmp/workspace",
    async *execute(): AsyncIterable<never> {},
    async interrupt() {
      return true;
    },
    async close() {},
    ...overrides,
  } as EnginePort;
}

function makeSubject(initialTasks: Task[] = []) {
  const tasks = new Map(initialTasks.map((task) => [task.agentSessionId, task]));
  const toolApprovalRecovery = {
    resolveTaskForApproval: vi.fn(async (sessionId: string) => tasks.get(sessionId) ?? null),
    tryQueueAgentsResume: vi.fn(),
  };
  const responseEventPublisher = {
    publishInputRequestResponded: vi.fn().mockResolvedValue(77),
    publishToolApprovalResolved: vi.fn().mockResolvedValue(88),
  };
  const agentRegistry = {
    get: vi.fn((id: string) => {
      if (id === "agent-openai") return { backend: "openai-agents" };
      if (id === "agent-codex") return { backend: "codex" };
      return undefined;
    }),
  };
  const route = new TaskDeliveryRoute({
    getTask: (sessionId) => tasks.get(sessionId),
    toolApprovalRecovery,
    responseEventPublisher,
    agentRegistry,
  });

  return {
    route,
    tasks,
    toolApprovalRecovery,
    responseEventPublisher,
    agentRegistry,
  };
}

describe("TaskDeliveryRoute.deliverInputResponse", () => {
  it("delivers to live engine and returns the public event id shape", async () => {
    const deliverInputResponse = vi.fn().mockResolvedValue({ status: "delivered" });
    const task = makeTask({
      engine: {
        ...makeBaseEngine(),
        deliverInputResponse,
      } as EnginePort & SupportsInputResponse,
    });
    const { route, responseEventPublisher } = makeSubject([task]);

    await expect(route.deliverInputResponse({
      agentSessionId: "sess-delivery",
      requestId: "ask-1",
      answers: { choice: "yes" },
    })).resolves.toEqual({
      status: "delivered",
      requestId: "ask-1",
      eventId: 77,
    });

    expect(deliverInputResponse).toHaveBeenCalledWith("ask-1", { choice: "yes" });
    expect(responseEventPublisher.publishInputRequestResponded)
      .toHaveBeenCalledWith(task, "ask-1");
  });

  it("keeps guard and engine failure result shapes without publishing response events", async () => {
    const completedTask = makeTask({ status: "completed" });
    const unsupportedTask = makeTask({
      agentSessionId: "sess-unsupported",
      profileId: "agent-codex",
      engine: makeBaseEngine({ backendId: "codex" }),
    });
    const failingEngineTask = makeTask({
      agentSessionId: "sess-expired",
      engine: {
        ...makeBaseEngine(),
        deliverInputResponse: vi.fn().mockResolvedValue({
          status: "expired",
          message: "request expired",
        }),
      } as EnginePort & SupportsInputResponse,
    });
    const { route, responseEventPublisher } = makeSubject([
      completedTask,
      unsupportedTask,
      failingEngineTask,
    ]);

    await expect(route.deliverInputResponse({
      agentSessionId: "missing",
      requestId: "ask-1",
      answers: {},
    })).resolves.toEqual({ status: "session_not_found", requestId: "ask-1" });

    await expect(route.deliverInputResponse({
      agentSessionId: "sess-delivery",
      requestId: "ask-1",
      answers: {},
    })).resolves.toEqual({
      status: "session_not_running",
      requestId: "ask-1",
      taskStatus: "completed",
    });

    await expect(route.deliverInputResponse({
      agentSessionId: "sess-unsupported",
      requestId: "ask-1",
      answers: {},
    })).resolves.toEqual({
      status: "not_supported",
      requestId: "ask-1",
      backend: "codex",
    });

    await expect(route.deliverInputResponse({
      agentSessionId: "sess-expired",
      requestId: "ask-1",
      answers: { choice: "late" },
    })).resolves.toEqual({
      status: "expired",
      requestId: "ask-1",
      message: "request expired",
    });
    expect(responseEventPublisher.publishInputRequestResponded).not.toHaveBeenCalled();
  });
});

describe("TaskDeliveryRoute.deliverToolApproval", () => {
  it("delivers to live approval-capable engine and returns the public event id shape", async () => {
    const deliverToolApproval = vi.fn().mockResolvedValue({ status: "delivered" });
    const task = makeTask({
      engine: {
        ...makeBaseEngine({ backendId: "openai-agents" }),
        deliverToolApproval,
      } as EnginePort & SupportsToolApproval,
    });
    const { route, toolApprovalRecovery, responseEventPublisher } = makeSubject([task]);

    await expect(route.deliverToolApproval({
      agentSessionId: "sess-delivery",
      approvalId: "approval-1",
      decision: "rejected",
      message: "no prod write",
      alwaysReject: true,
    })).resolves.toEqual({
      status: "delivered",
      approvalId: "approval-1",
      decision: "rejected",
      eventId: 88,
    });

    expect(toolApprovalRecovery.resolveTaskForApproval).toHaveBeenCalledWith("sess-delivery");
    expect(deliverToolApproval).toHaveBeenCalledWith("approval-1", "rejected", {
      message: "no prod write",
      alwaysReject: true,
    });
    expect(responseEventPublisher.publishToolApprovalResolved)
      .toHaveBeenCalledWith(task, expect.objectContaining({ approvalId: "approval-1" }));
  });

  it("uses recovery fallback for approval-capability miss before returning not_supported", async () => {
    const task = makeTask({
      profileId: "agent-openai",
      engine: makeBaseEngine({ backendId: "openai-agents" }),
    });
    const { route, toolApprovalRecovery, responseEventPublisher } = makeSubject([task]);
    const onResume = vi.fn();
    toolApprovalRecovery.tryQueueAgentsResume.mockResolvedValueOnce({
      status: "delivered",
      approvalId: "approval-1",
      decision: "approved",
      eventId: 99,
    });

    await expect(route.deliverToolApproval({
      agentSessionId: "sess-delivery",
      approvalId: "approval-1",
      decision: "approved",
    }, onResume)).resolves.toEqual({
      status: "delivered",
      approvalId: "approval-1",
      decision: "approved",
      eventId: 99,
    });

    expect(toolApprovalRecovery.tryQueueAgentsResume)
      .toHaveBeenCalledWith(task, expect.objectContaining({ approvalId: "approval-1" }), onResume);
    expect(responseEventPublisher.publishToolApprovalResolved).not.toHaveBeenCalled();

    toolApprovalRecovery.tryQueueAgentsResume.mockResolvedValueOnce(undefined);
    await expect(route.deliverToolApproval({
      agentSessionId: "sess-delivery",
      approvalId: "approval-2",
      decision: "rejected",
    }, onResume)).resolves.toEqual({
      status: "not_supported",
      approvalId: "approval-2",
      decision: "rejected",
      backend: "openai-agents",
    });
  });

  it("keeps not-found, not-running, and engine failure result shapes", async () => {
    const completedTask = makeTask({ status: "completed" });
    const failingTask = makeTask({
      agentSessionId: "sess-failure",
      engine: {
        ...makeBaseEngine({ backendId: "openai-agents" }),
        deliverToolApproval: vi.fn().mockResolvedValue({
          status: "already_resolved",
          message: "already done",
        }),
      } as EnginePort & SupportsToolApproval,
    });
    const { route, responseEventPublisher } = makeSubject([completedTask, failingTask]);

    await expect(route.deliverToolApproval({
      agentSessionId: "missing",
      approvalId: "approval-1",
      decision: "approved",
    })).resolves.toEqual({
      status: "session_not_found",
      approvalId: "approval-1",
      decision: "approved",
    });

    await expect(route.deliverToolApproval({
      agentSessionId: "sess-delivery",
      approvalId: "approval-1",
      decision: "approved",
    })).resolves.toEqual({
      status: "session_not_running",
      approvalId: "approval-1",
      decision: "approved",
      taskStatus: "completed",
    });

    await expect(route.deliverToolApproval({
      agentSessionId: "sess-failure",
      approvalId: "approval-1",
      decision: "approved",
    })).resolves.toEqual({
      status: "already_resolved",
      approvalId: "approval-1",
      decision: "approved",
      message: "already done",
    });
    expect(responseEventPublisher.publishToolApprovalResolved).not.toHaveBeenCalled();
  });
});

import { describe, expect, it, vi } from "vitest";

import type {
  EnginePort,
  SupportsInputResponse,
  SupportsToolApproval,
} from "../../src/engine/protocol.js";
import { TaskLiveDeliveryResult } from "../../src/task/task_live_delivery_result.js";
import type { Task } from "../../src/task/task_models.js";

function makeTask(overrides: Partial<Task> = {}): Task {
  return {
    agentSessionId: "sess-live-delivery",
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

function makeSubject() {
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

  return {
    resultBoundary: new TaskLiveDeliveryResult({
      responseEventPublisher,
      agentRegistry,
    }),
    responseEventPublisher,
    agentRegistry,
  };
}

describe("TaskLiveDeliveryResult.deliverInputResponse", () => {
  it("delivers to the live engine, publishes the resolved event, and returns eventId", async () => {
    const deliverInputResponse = vi.fn().mockResolvedValue({ status: "delivered" });
    const task = makeTask({
      engine: {
        ...makeBaseEngine(),
        deliverInputResponse,
      } as EnginePort & SupportsInputResponse,
    });
    const { resultBoundary, responseEventPublisher } = makeSubject();

    await expect(resultBoundary.deliverInputResponse({
      task,
      engine: task.engine as NonNullable<Task["engine"]> & SupportsInputResponse,
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

  it("maps engine failure shapes without publishing response events", async () => {
    const expiredTask = makeTask({
      engine: {
        ...makeBaseEngine(),
        deliverInputResponse: vi.fn().mockResolvedValue({
          status: "expired",
          message: "request expired",
        }),
      } as EnginePort & SupportsInputResponse,
    });
    const unsupportedTask = makeTask({
      profileId: "agent-codex",
      engine: {
        ...makeBaseEngine({ backendId: "codex" }),
        deliverInputResponse: vi.fn().mockResolvedValue({ status: "not_supported" }),
      } as EnginePort & SupportsInputResponse,
    });
    const { resultBoundary, responseEventPublisher } = makeSubject();

    await expect(resultBoundary.deliverInputResponse({
      task: expiredTask,
      engine: expiredTask.engine as NonNullable<Task["engine"]> & SupportsInputResponse,
      requestId: "ask-1",
      answers: { choice: "late" },
    })).resolves.toEqual({
      status: "expired",
      requestId: "ask-1",
      message: "request expired",
    });

    await expect(resultBoundary.deliverInputResponse({
      task: unsupportedTask,
      engine: unsupportedTask.engine as NonNullable<Task["engine"]> & SupportsInputResponse,
      requestId: "ask-2",
      answers: {},
    })).resolves.toEqual({
      status: "not_supported",
      requestId: "ask-2",
      backend: "codex",
    });
    expect(responseEventPublisher.publishInputRequestResponded).not.toHaveBeenCalled();
  });
});

describe("TaskLiveDeliveryResult.deliverToolApproval", () => {
  it("delivers to the live engine, publishes the resolved event, and returns eventId", async () => {
    const deliverToolApproval = vi.fn().mockResolvedValue({ status: "delivered" });
    const task = makeTask({
      engine: {
        ...makeBaseEngine({ backendId: "openai-agents" }),
        deliverToolApproval,
      } as EnginePort & SupportsToolApproval,
    });
    const { resultBoundary, responseEventPublisher } = makeSubject();

    await expect(resultBoundary.deliverToolApproval({
      task,
      engine: task.engine as NonNullable<Task["engine"]> & SupportsToolApproval,
      params: {
        agentSessionId: "sess-live-delivery",
        approvalId: "approval-1",
        decision: "rejected",
        message: "no prod write",
        alwaysReject: true,
      },
    })).resolves.toEqual({
      status: "delivered",
      approvalId: "approval-1",
      decision: "rejected",
      eventId: 88,
    });

    expect(deliverToolApproval).toHaveBeenCalledWith("approval-1", "rejected", {
      message: "no prod write",
      alwaysReject: true,
    });
    expect(responseEventPublisher.publishToolApprovalResolved).toHaveBeenCalledWith(
      task,
      expect.objectContaining({ approvalId: "approval-1" }),
    );
  });

  it("maps engine failure shapes without publishing response events", async () => {
    const alreadyResolvedTask = makeTask({
      engine: {
        ...makeBaseEngine({ backendId: "openai-agents" }),
        deliverToolApproval: vi.fn().mockResolvedValue({
          status: "already_resolved",
          message: "already done",
        }),
      } as EnginePort & SupportsToolApproval,
    });
    const unsupportedTask = makeTask({
      profileId: "agent-openai",
      engine: {
        ...makeBaseEngine({ backendId: "openai-agents" }),
        deliverToolApproval: vi.fn().mockResolvedValue({ status: "not_supported" }),
      } as EnginePort & SupportsToolApproval,
    });
    const { resultBoundary, responseEventPublisher } = makeSubject();

    await expect(resultBoundary.deliverToolApproval({
      task: alreadyResolvedTask,
      engine: alreadyResolvedTask.engine as NonNullable<Task["engine"]> & SupportsToolApproval,
      params: {
        agentSessionId: "sess-live-delivery",
        approvalId: "approval-1",
        decision: "approved",
      },
    })).resolves.toEqual({
      status: "already_resolved",
      approvalId: "approval-1",
      decision: "approved",
      message: "already done",
    });

    await expect(resultBoundary.deliverToolApproval({
      task: unsupportedTask,
      engine: unsupportedTask.engine as NonNullable<Task["engine"]> & SupportsToolApproval,
      params: {
        agentSessionId: "sess-live-delivery",
        approvalId: "approval-2",
        decision: "rejected",
      },
    })).resolves.toEqual({
      status: "not_supported",
      approvalId: "approval-2",
      decision: "rejected",
      backend: "openai-agents",
    });
    expect(responseEventPublisher.publishToolApprovalResolved).not.toHaveBeenCalled();
  });
});

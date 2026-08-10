import { describe, expect, it, vi } from "vitest";

import type {
  EnginePort,
  SupportsInputResponse,
  SupportsToolApproval,
} from "../../src/engine/protocol.js";
import { createInProcessTaskRunnerRuntime } from
  "../../src/runner/task_runner_runtime.js";
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
    const engine = {
      ...makeBaseEngine(),
      deliverInputResponse,
    } as EnginePort & SupportsInputResponse;
    const task = makeTask({
      runner: createInProcessTaskRunnerRuntime(engine),
    });
    const { resultBoundary, responseEventPublisher } = makeSubject();

    await expect(resultBoundary.deliverInputResponse({
      task,
      engine,
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
    const expiredEngine = {
        ...makeBaseEngine(),
        deliverInputResponse: vi.fn().mockResolvedValue({
          status: "expired",
          message: "request expired",
        }),
      } as EnginePort & SupportsInputResponse;
    const unsupportedEngine = {
        ...makeBaseEngine({ backendId: "codex" }),
        deliverInputResponse: vi.fn().mockResolvedValue({ status: "not_supported" }),
      } as EnginePort & SupportsInputResponse;
    const expiredTask = makeTask({
      runner: createInProcessTaskRunnerRuntime(expiredEngine),
    });
    const unsupportedTask = makeTask({
      profileId: "agent-codex",
      runner: createInProcessTaskRunnerRuntime(unsupportedEngine),
    });
    const { resultBoundary, responseEventPublisher } = makeSubject();

    await expect(resultBoundary.deliverInputResponse({
      task: expiredTask,
      engine: expiredEngine,
      requestId: "ask-1",
      answers: { choice: "late" },
    })).resolves.toEqual({
      status: "expired",
      requestId: "ask-1",
      message: "request expired",
    });

    await expect(resultBoundary.deliverInputResponse({
      task: unsupportedTask,
      engine: unsupportedEngine,
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
    const engine = {
      ...makeBaseEngine({ backendId: "openai-agents" }),
      deliverToolApproval,
    } as EnginePort & SupportsToolApproval;
    const task = makeTask({
      runner: createInProcessTaskRunnerRuntime(engine),
    });
    const { resultBoundary, responseEventPublisher } = makeSubject();

    await expect(resultBoundary.deliverToolApproval({
      task,
      engine,
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
    const alreadyResolvedEngine = {
        ...makeBaseEngine({ backendId: "openai-agents" }),
        deliverToolApproval: vi.fn().mockResolvedValue({
          status: "already_resolved",
          message: "already done",
        }),
      } as EnginePort & SupportsToolApproval;
    const unsupportedEngine = {
        ...makeBaseEngine({ backendId: "openai-agents" }),
        deliverToolApproval: vi.fn().mockResolvedValue({ status: "not_supported" }),
      } as EnginePort & SupportsToolApproval;
    const alreadyResolvedTask = makeTask({
      runner: createInProcessTaskRunnerRuntime(alreadyResolvedEngine),
    });
    const unsupportedTask = makeTask({
      profileId: "agent-openai",
      runner: createInProcessTaskRunnerRuntime(unsupportedEngine),
    });
    const { resultBoundary, responseEventPublisher } = makeSubject();

    await expect(resultBoundary.deliverToolApproval({
      task: alreadyResolvedTask,
      engine: alreadyResolvedEngine,
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
      engine: unsupportedEngine,
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

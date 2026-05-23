import pino from "pino";
import { describe, expect, it, vi } from "vitest";

import type { AgentProfile } from "../../src/agent_registry.js";
import type { TaskExecutor } from "../../src/task/task_executor.js";
import type { TaskManager } from "../../src/task/task_manager.js";
import type { Task } from "../../src/task/task_models.js";
import {
  DeliveryCommandError,
  DeliveryCommands,
} from "../../src/upstream/delivery_commands.js";

const logger = pino({ level: "silent" });

const openaiAgent: AgentProfile = {
  id: "openai-agents-default",
  name: "OpenAI Agents Default",
  backend: "openai-agents",
  workspace_dir: "/tmp/openai-agents-default",
  agents_sdk: {
    entry_agent: "default",
    agents: [
      {
        name: "default",
        instructions: "You are a test agent.",
      },
    ],
  },
};

function makeTask(params: Partial<Task> = {}): Task {
  return {
    agentSessionId: "sess-1",
    prompt: "hi",
    status: "running",
    profileId: openaiAgent.id,
    createdAt: new Date("2026-05-23T00:00:00.000Z"),
    lastEventId: 0,
    lastReadEventId: 0,
    interventionQueue: [],
    ...params,
  };
}

function createDeliveryCommands(opts: {
  agents?: AgentProfile[];
  deliverInputResponse?: TaskManager["deliverInputResponse"];
  deliverToolApproval?: TaskManager["deliverToolApproval"];
  startExecution?: TaskExecutor["startExecution"];
} = {}) {
  const agents = new Map(
    (opts.agents ?? [openaiAgent]).map((agent) => [agent.id, agent]),
  );
  const taskManager = {
    deliverInputResponse:
      opts.deliverInputResponse ??
      vi.fn(async () => ({ status: "delivered", requestId: "ask-1" })),
    deliverToolApproval:
      opts.deliverToolApproval ??
      vi.fn(async () => ({
        status: "delivered",
        approvalId: "approval-1",
        decision: "approved",
      })),
  } as Pick<TaskManager, "deliverInputResponse" | "deliverToolApproval">;
  const taskExecutor = {
    startExecution: opts.startExecution ?? vi.fn(),
  } as Pick<TaskExecutor, "startExecution">;

  const commands = new DeliveryCommands({
    agentRegistry: {
      get: vi.fn((profileId: string) => agents.get(profileId)),
    },
    taskManager,
    taskExecutor,
    logger,
  });

  return { commands, taskManager, taskExecutor };
}

describe("DeliveryCommands.respond", () => {
  it("normalizes input request id, forwards answers, and returns respond_ack", async () => {
    const deliverInputResponse = vi.fn().mockResolvedValue({
      status: "delivered",
      requestId: "ask-snake",
      eventId: 77,
    });
    const { commands, taskManager } = createDeliveryCommands({
      deliverInputResponse,
    });

    const ack = await commands.respond({
      type: "respond",
      agentSessionId: "sess-ask",
      request_id: "ask-snake",
      requestId: "orch-cmd-1",
      answers: { choice: "yes" },
    });

    expect(taskManager.deliverInputResponse).toHaveBeenCalledWith({
      agentSessionId: "sess-ask",
      requestId: "ask-snake",
      answers: { choice: "yes" },
    });
    expect(ack).toEqual({
      type: "respond_ack",
      requestId: "orch-cmd-1",
      inputRequestId: "ask-snake",
      status: "ok",
      delivered: true,
      eventId: 77,
    });
  });

  it("rejects invalid respond commands before task delivery", async () => {
    const deliverInputResponse = vi.fn();
    const { commands } = createDeliveryCommands({ deliverInputResponse });

    await expect(
      commands.respond({
        type: "respond",
        agentSessionId: "sess-ask",
        requestId: "orch-cmd-2",
        answers: {},
      }),
    ).rejects.toBeInstanceOf(DeliveryCommandError);
    expect(deliverInputResponse).not.toHaveBeenCalled();
  });

  it("delivers input response but returns null when command requestId is absent", async () => {
    const deliverInputResponse = vi.fn().mockResolvedValue({
      status: "delivered",
      requestId: "ask-1",
    });
    const { commands } = createDeliveryCommands({ deliverInputResponse });

    const ack = await commands.respond({
      type: "respond",
      agentSessionId: "sess-ask",
      inputRequestId: "ask-1",
      answers: {},
    });

    expect(deliverInputResponse).toHaveBeenCalledWith({
      agentSessionId: "sess-ask",
      requestId: "ask-1",
      answers: {},
    });
    expect(ack).toBeNull();
  });
});

describe("DeliveryCommands.toolApproval", () => {
  it("forwards approval options, starts resumed task, and returns tool_approval_ack", async () => {
    const resumedTask = makeTask({
      agentSessionId: "sess-agents",
      profileId: openaiAgent.id,
    });
    const deliverToolApproval = vi.fn(async (_params, onResume) => {
      onResume(resumedTask);
      return {
        status: "delivered",
        approvalId: "approval-1",
        decision: "approved",
        eventId: 88,
      };
    });
    const { commands, taskManager, taskExecutor } = createDeliveryCommands({
      deliverToolApproval,
    });

    const ack = await commands.toolApproval({
      type: "approve_tool",
      session_id: "sess-agents",
      approval_id: "approval-1",
      request_id: "orch-approval-1",
      message: "approved by user",
      alwaysApprove: true,
    });

    expect(taskManager.deliverToolApproval).toHaveBeenCalledWith(
      {
        agentSessionId: "sess-agents",
        approvalId: "approval-1",
        decision: "approved",
        message: "approved by user",
        alwaysApprove: true,
      },
      expect.any(Function),
    );
    expect(taskExecutor.startExecution).toHaveBeenCalledWith(
      resumedTask,
      openaiAgent,
    );
    expect(ack).toEqual({
      type: "tool_approval_ack",
      requestId: "orch-approval-1",
      approvalId: "approval-1",
      decision: "approved",
      status: "ok",
      delivered: true,
      eventId: 88,
    });
  });

  it("rejects invalid approval commands before task delivery", async () => {
    const deliverToolApproval = vi.fn();
    const { commands } = createDeliveryCommands({ deliverToolApproval });

    await expect(
      commands.toolApproval({
        type: "reject_tool",
        agentSessionId: "sess-agents",
        requestId: "orch-approval-2",
      }),
    ).rejects.toBeInstanceOf(DeliveryCommandError);
    expect(deliverToolApproval).not.toHaveBeenCalled();
  });
});

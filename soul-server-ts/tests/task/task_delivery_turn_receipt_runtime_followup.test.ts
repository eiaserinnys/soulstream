import type { Logger } from "pino";
import { describe, expect, it, vi } from "vitest";

import { attachClaudeResultReceiptMetadata } from
  "../../src/engine/claude_result_receipt_metadata.js";
import { attachClaudeToolResultReceiptMetadata } from
  "../../src/engine/claude_tool_result_receipt_metadata.js";
import type { SSEEventPayload } from "../../src/engine/protocol.js";
import { buildDeliveryInputUuid } from "../../src/task/delivery_identity.js";
import { TaskDeliveryConsumption } from
  "../../src/task/task_delivery_consumption.js";
import { TaskDeliveryTurnReceipt } from
  "../../src/task/task_delivery_turn_receipt.js";
import type { InterventionMessage, Task } from "../../src/task/task_models.js";

function makeTask(): Task {
  return {
    agentSessionId: "session-1",
    prompt: "turn",
    status: "running",
    codexThreadId: "sdk-session-1",
    createdAt: new Date(),
    lastEventId: 41,
    lastReadEventId: 0,
    interventionQueue: [],
  };
}

function runtimeFollowup(): InterventionMessage {
  return {
    text: "background result",
    user: "system",
    source: "claude_runtime_task_followup",
    deliveryIntent: "runtime_followup",
    deliveryId: "88888888-8888-4888-8888-888888888888",
    relationKey: "runtime-relation",
    completionId: "runtime-completion",
  };
}

function makeHarness(interventions: InterventionMessage[] = []) {
  const recorder = {
    recordConsumed: vi.fn().mockResolvedValue(undefined),
    recordTurnStarted: vi.fn().mockResolvedValue(undefined),
    discardIfConsumed: vi.fn().mockResolvedValue(false),
    recordConsumptionFailure: vi.fn().mockResolvedValue(undefined),
    recordRuntimeFollowupRelationConsumed: vi.fn().mockResolvedValue(true),
  };
  const consumption = new TaskDeliveryConsumption(
    recorder,
    { warn: vi.fn() } as unknown as Logger,
  );
  return {
    recorder,
    receipt: new TaskDeliveryTurnReceipt(consumption, interventions),
  };
}

describe("runtime_followup consumption proof", () => {
  it("generic SSE와 settle consume로 runtime_followup을 소비하지 않는다", async () => {
    const intervention = runtimeFollowup();
    const { recorder, receipt } = makeHarness([intervention]);
    const task = makeTask();

    await receipt.observe(task, {
      type: "assistant_message",
      content: "unrelated",
      timestamp: 1,
    } as SSEEventPayload);
    await receipt.consume(task);

    expect(recorder.recordTurnStarted).not.toHaveBeenCalled();
    expect(recorder.recordConsumed).not.toHaveBeenCalled();
    expect(receipt.hasConsumptionReceipt(intervention)).toBe(false);
  });

  it.each([
    "human_live_steer",
    "durable_next_turn",
    "completion_notification",
  ] as const)("keeps generic turn receipt behavior for %s", async (deliveryIntent) => {
    const intervention: InterventionMessage = {
      text: "ordinary delivery",
      user: "system",
      source: "contract-test",
      deliveryIntent,
      deliveryId: `delivery-${deliveryIntent}`,
      relationKey: `relation-${deliveryIntent}`,
      completionId: `completion-${deliveryIntent}`,
    };
    const { recorder, receipt } = makeHarness([intervention]);
    const task = makeTask();

    await receipt.observe(task, {
      type: "assistant_message",
      content: "model accepted the ordinary input",
      timestamp: 1,
    } as SSEEventPayload);
    await receipt.consume(task);

    expect(recorder.recordTurnStarted).toHaveBeenCalledOnce();
    expect(recorder.recordConsumed).toHaveBeenCalledOnce();
    expect(receipt.hasConsumptionReceipt(intervention)).toBe(true);
  });

  it("exact SDK Result input UUID만 대상 delivery를 소비한다", async () => {
    const intervention = runtimeFollowup();
    const { recorder, receipt } = makeHarness([intervention]);
    const task = makeTask();
    const foreign = { type: "result", success: true, output: "foreign" } as SSEEventPayload;
    attachClaudeResultReceiptMetadata(foreign, { inputUuid: "foreign-input" });
    await receipt.observe(task, foreign);
    expect(recorder.recordConsumed).not.toHaveBeenCalled();

    const exact = { type: "result", success: true, output: "done" } as SSEEventPayload;
    attachClaudeResultReceiptMetadata(exact, {
      inputUuid: buildDeliveryInputUuid(intervention.deliveryId!),
    });
    await receipt.observe(task, exact);

    expect(recorder.recordTurnStarted).toHaveBeenCalledOnce();
    expect(recorder.recordConsumed).toHaveBeenCalledOnce();
    expect(receipt.hasConsumptionReceipt(intervention)).toBe(true);
  });

  it("Agent final과 terminal TaskOutput만 pre-terminal relation proof로 기록한다", async () => {
    const { recorder, receipt } = makeHarness();
    const task = makeTask();
    await receipt.observe(task, {
      type: "tool_start",
      tool_name: "Agent",
      tool_use_id: "toolu-agent",
      tool_input: { run_in_background: true },
      timestamp: 1,
    } as SSEEventPayload);
    const agentResult = {
      type: "tool_result",
      tool_name: "Agent",
      tool_use_id: "toolu-agent",
      result: "done",
      is_error: false,
      timestamp: 2,
    } as SSEEventPayload;
    attachClaudeToolResultReceiptMetadata(agentResult, {
      envelope: { agentId: "task-agent" },
    });
    await receipt.observe(task, agentResult);

    await receipt.observe(task, {
      type: "tool_start",
      tool_name: "TaskOutput",
      tool_use_id: "toolu-lookup",
      tool_input: { task_id: "task-output", block: true, timeout: 60_000 },
      timestamp: 3,
    } as SSEEventPayload);
    const running = {
      type: "tool_result",
      tool_name: "TaskOutput",
      tool_use_id: "toolu-lookup",
      result: "<output>completed</output>",
      is_error: false,
      timestamp: 4,
    } as SSEEventPayload;
    attachClaudeToolResultReceiptMetadata(running, {
      envelope: {
        task_id: "task-output",
        retrieval_status: "timeout",
        status: "running",
        output: "completed",
      },
    });
    await receipt.observe(task, running);

    await receipt.observe(task, {
      type: "tool_start",
      tool_name: "TaskOutput",
      tool_use_id: "toolu-terminal",
      tool_input: { task_id: "task-output", block: true, timeout: 60_000 },
      timestamp: 5,
    } as SSEEventPayload);
    const terminal = {
      type: "tool_result",
      tool_name: "TaskOutput",
      tool_use_id: "toolu-terminal",
      result: "<output>running</output>",
      is_error: false,
      timestamp: 6,
    } as SSEEventPayload;
    attachClaudeToolResultReceiptMetadata(terminal, {
      envelope: {
        task_id: "task-output",
        retrieval_status: "success",
        status: "completed",
        output: "running",
      },
    });
    await receipt.observe(task, terminal);

    expect(recorder.recordRuntimeFollowupRelationConsumed).toHaveBeenCalledTimes(2);
    expect(recorder.recordRuntimeFollowupRelationConsumed.mock.calls[0]![1]).toEqual({
      kind: "exact_generation",
      taskId: "task-agent",
      initiatingToolUseId: "toolu-agent",
    });
    expect(recorder.recordRuntimeFollowupRelationConsumed.mock.calls[1]![1]).toEqual({
      kind: "task_output",
      taskId: "task-output",
    });
  });

  it("늦은 runtime register가 이전 generic event를 소비 증거로 재사용하지 않는다", async () => {
    const intervention = runtimeFollowup();
    const { recorder, receipt } = makeHarness();
    const task = makeTask();
    await receipt.observe(task, {
      type: "assistant_message",
      content: "unrelated",
      timestamp: 1,
    } as SSEEventPayload);
    await receipt.register(intervention);

    expect(recorder.recordTurnStarted).not.toHaveBeenCalled();
    expect(recorder.recordConsumed).not.toHaveBeenCalled();
  });

  it("늦은 runtime register는 앞서 관측한 exact Result UUID를 재사용한다", async () => {
    const intervention = runtimeFollowup();
    const { recorder, receipt } = makeHarness();
    const task = makeTask();
    const exact = { type: "result", success: true, output: "done" } as SSEEventPayload;
    attachClaudeResultReceiptMetadata(exact, {
      inputUuid: buildDeliveryInputUuid(intervention.deliveryId!),
    });

    await receipt.observe(task, exact);
    await receipt.register(intervention);

    expect(recorder.recordTurnStarted).toHaveBeenCalledOnce();
    expect(recorder.recordConsumed).toHaveBeenCalledOnce();
    expect(receipt.hasConsumptionReceipt(intervention)).toBe(true);
  });

  it("relation ledger write failure does not fabricate a consumption receipt", async () => {
    const intervention = runtimeFollowup();
    const { recorder, receipt } = makeHarness([intervention]);
    recorder.recordRuntimeFollowupRelationConsumed.mockRejectedValueOnce(
      new Error("ledger unavailable"),
    );
    const task = makeTask();
    await receipt.observe(task, {
      type: "tool_start",
      tool_name: "Agent",
      tool_use_id: "toolu-agent-failure",
      tool_input: { run_in_background: true },
      timestamp: 1,
    } as SSEEventPayload);
    const result = {
      type: "tool_result",
      tool_name: "Agent",
      tool_use_id: "toolu-agent-failure",
      result: "done",
      is_error: false,
      timestamp: 2,
    } as SSEEventPayload;
    attachClaudeToolResultReceiptMetadata(result, {
      envelope: { agentId: "task-agent-failure" },
    });

    await expect(receipt.observe(task, result)).resolves.toBeUndefined();
    expect(receipt.hasConsumptionReceipt(intervention)).toBe(false);
    expect(recorder.recordConsumed).not.toHaveBeenCalled();
  });
});

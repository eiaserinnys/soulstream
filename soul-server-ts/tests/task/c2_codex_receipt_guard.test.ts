import { describe, expect, it, vi } from "vitest";

import type { AgentProfile } from "../../src/agent_registry.js";
import type { SSEEventPayload } from "../../src/engine/protocol.js";
import { effectiveTaskBackend } from "../../src/task/task_model_preset.js";
import { TaskDeliveryTurnReceipt } from "../../src/task/task_delivery_turn_receipt.js";
import type { InterventionMessage, Task } from "../../src/task/task_models.js";

/**
 * C2 review gate — Codex legacy consumption must be preserved.
 *
 * C2 tightens the Claude consumption proof. `TaskDeliveryTurnReceipt` is shared
 * across backends, so this guard pins the Codex side of that shared owner
 * directly. Backend is taken from the production authority
 * `effectiveTaskBackend(task, agent)` — never inferred from event shape or from
 * a profile-id string.
 */

const CODEX_AGENT: AgentProfile = {
  id: "roselin",
  name: "로젤린",
  backend: "codex",
  workspace_dir: "/tmp/roselin",
};

function makeCodexTask(sessionSuffix: string, message: InterventionMessage): Task {
  return {
    agentSessionId: `c2-codex-${sessionSuffix}`,
    prompt: "existing foreground turn",
    status: "running",
    profileId: CODEX_AGENT.id,
    createdAt: new Date("2026-08-25T00:00:00.000Z"),
    lastEventId: 4242,
    lastReadEventId: 4241,
    modelPresetBackend: "codex",
    interventionQueue: [{ ...message }],
  } as Task;
}

function makeMessage(deliveryId: string, text: string): InterventionMessage {
  return {
    text,
    user: "agent",
    source: "user_message",
    deliveryId,
    deliveryIntent: "human_live_steer",
    completionId: `message:${deliveryId}`,
    relationKey: `user_message:c2-codex:${deliveryId}`,
  } as InterventionMessage;
}

interface Recorded {
  readonly recordTurnStarted: ReturnType<typeof vi.fn>;
  readonly recordConsumed: ReturnType<typeof vi.fn>;
  readonly receipt: TaskDeliveryTurnReceipt;
}

function makeReceipt(message: InterventionMessage): Recorded {
  const recordTurnStarted = vi.fn(async () => true);
  const recordConsumed = vi.fn(async () => undefined);
  const receipt = new TaskDeliveryTurnReceipt(
    { recordTurnStarted, recordConsumed } as never,
    message,
  );
  return { recordTurnStarted, recordConsumed, receipt };
}

const sessionEvent = { type: "session", sessionId: "codex-thread-1" } as unknown as SSEEventPayload;
const errorEvent = { type: "error", message: "boom" } as unknown as SSEEventPayload;
const metadataEvent = {
  type: "metadata",
  metadata_type: "execution_ownership_transition",
  value: { phase: "execution_activate" },
} as unknown as SSEEventPayload;
const assistantEvent = {
  type: "assistant_message",
  content: "codex reply",
  timestamp: 1,
} as unknown as SSEEventPayload;
const resultEvent = { type: "result", status: "completed" } as unknown as SSEEventPayload;
const completeEvent = { type: "complete", status: "completed" } as unknown as SSEEventPayload;

describe("C2 review gate: shared turn receipt preserves Codex consumption", () => {
  it("uses the production effective-backend authority, not event or profile inference", () => {
    const message = makeMessage("codex-delivery-authority", "backend authority check");
    const task = makeCodexTask("authority", message);
    expect(effectiveTaskBackend(task, CODEX_AGENT)).toBe("codex");
  });

  it("records nothing for a Codex turn that only emits session and error", async () => {
    const message = makeMessage("codex-delivery-session-error", "session and error only");
    const task = makeCodexTask("session-error", message);
    expect(effectiveTaskBackend(task, CODEX_AGENT)).toBe("codex");

    const { recordTurnStarted, recordConsumed, receipt } = makeReceipt(message);
    await receipt.observe(task, sessionEvent);
    await receipt.observe(task, errorEvent);
    await receipt.consume(task);

    expect(recordTurnStarted).toHaveBeenCalledTimes(0);
    expect(recordConsumed).toHaveBeenCalledTimes(0);
  });

  it("keeps legacy Codex consumption exactly once across a repeated consume", async () => {
    const message = makeMessage("codex-delivery-legacy", "legacy codex consumption");
    const task = makeCodexTask("legacy", message);
    expect(effectiveTaskBackend(task, CODEX_AGENT)).toBe("codex");

    const { recordTurnStarted, recordConsumed, receipt } = makeReceipt(message);
    await receipt.observe(task, metadataEvent);
    await receipt.observe(task, assistantEvent);
    await receipt.observe(task, resultEvent);
    await receipt.observe(task, completeEvent);
    await receipt.consume(task);
    await receipt.consume(task);

    expect(recordTurnStarted).toHaveBeenCalledTimes(1);
    expect(recordConsumed).toHaveBeenCalledTimes(1);

    // TaskDeliveryTurnReceipt.consume calls consumption.recordConsumed(task, intervention, turnId).
    const consumedCall = recordConsumed.mock.calls[0] as unknown[];
    expect((consumedCall[0] as Task).agentSessionId).toBe(task.agentSessionId);
    expect(consumedCall[1]).toBe(message);
    expect(consumedCall[2]).toBe(`event:${task.lastEventId}`);
  });

  it("consumes two distinct Codex deliveries that carry identical text", async () => {
    const identicalText = "동일한 지시 문장";
    const first = makeMessage("codex-delivery-dup-1", identicalText);
    const second = makeMessage("codex-delivery-dup-2", identicalText);
    expect(first.text).toBe(second.text);
    expect(first.deliveryId).not.toBe(second.deliveryId);

    const results = [];
    for (const [index, message] of [first, second].entries()) {
      const task = makeCodexTask(`dup-${index}`, message);
      expect(effectiveTaskBackend(task, CODEX_AGENT)).toBe("codex");
      const recorded = makeReceipt(message);
      await recorded.receipt.observe(task, metadataEvent);
      await recorded.receipt.observe(task, assistantEvent);
      await recorded.receipt.consume(task);
      results.push(recorded);
    }

    for (const recorded of results) {
      expect(recorded.recordTurnStarted).toHaveBeenCalledTimes(1);
      expect(recorded.recordConsumed).toHaveBeenCalledTimes(1);
    }

    const firstConsumed = results[0]!.recordConsumed.mock.calls[0] as unknown[];
    const secondConsumed = results[1]!.recordConsumed.mock.calls[0] as unknown[];
    expect((firstConsumed[1] as InterventionMessage).deliveryId)
      .toBe("codex-delivery-dup-1");
    expect((secondConsumed[1] as InterventionMessage).deliveryId)
      .toBe("codex-delivery-dup-2");
  });
});

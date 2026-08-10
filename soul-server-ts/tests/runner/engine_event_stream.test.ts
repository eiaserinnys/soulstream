import { describe, expect, it } from "vitest";

import {
  readClaudeBackgroundDeliveryMetadata,
} from "../../src/engine/claude_background_delivery_metadata.js";
import {
  readClaudeBackgroundProvenance,
} from "../../src/engine/claude_background_provenance.js";
import {
  sseEventFromRunnerFrame,
  sseEventsFromRunnerFrames,
} from "../../src/runner/engine_event_stream.js";
import {
  engineEventFrame,
  runnerRequestFrame,
  type RunnerEventFrame,
} from "../../src/runner/frame_protocol.js";

async function* frames(values: RunnerEventFrame[]): AsyncIterable<RunnerEventFrame> {
  yield* values;
}

describe("sseEventsFromRunnerFrames", () => {
  it("restores process-local Claude metadata from the JSON frame envelope", () => {
    const delivery = {
      deliveryId: "delivery-1",
      completionId: "completion-1",
      relationKey: "relation-1",
      producerTerminalRevision: "revision-1",
      deliveryCreatedAt: "2026-08-10T12:00:00.000Z",
      source: "background-task",
      storedPayload: { type: "task_notification", task_id: "task-1" },
      storedPayloadHash: "hash-1",
    };
    const frame = engineEventFrame(
      { type: "task_notification", task_id: "task-1" },
      {
        claudeBackgroundProvenance: "sdk_membership",
        claudeBackgroundDelivery: delivery,
      },
    );
    if (frame.kind !== "engine_event") {
      throw new Error("Expected engine_event frame");
    }
    const event = sseEventFromRunnerFrame(frame);

    expect(readClaudeBackgroundProvenance(event)).toBe("sdk_membership");
    expect(readClaudeBackgroundDeliveryMetadata(event)).toEqual(delivery);
    expect(JSON.parse(JSON.stringify(frame))).toEqual(frame);
  });

  it("keeps external-response request frames out of the legacy SSE view", async () => {
    const events: unknown[] = [];

    for await (const event of sseEventsFromRunnerFrames(frames([
      engineEventFrame({ type: "input_request", request_id: "ask-1" }),
      runnerRequestFrame("ask-1", {
        kind: "can_use_tool",
        toolName: "AskUserQuestion",
        input: { questions: [] },
      }),
      runnerRequestFrame("approval-1", {
        kind: "tool_approval",
        approvalId: "approval-1",
        toolName: "drop_rows",
        input: { table: "events" },
      }),
      engineEventFrame({ type: "complete", timestamp: 1 }),
    ]))) {
      events.push(event);
    }

    expect(events).toEqual([
      { type: "input_request", request_id: "ask-1" },
      { type: "complete", timestamp: 1 },
    ]);
  });

  it("rejects host-owned schedule requests without a control consumer", async () => {
    const consume = async () => {
      for await (const _ of sseEventsFromRunnerFrames(frames([
        runnerRequestFrame("schedule-1", {
          kind: "schedule_tool_use",
          agentSessionId: "session-1",
          toolUseId: "tool-1",
          toolName: "ScheduleTask",
          input: {},
          now: "2026-08-10T12:00:00.000Z",
        }),
      ]))) {
        // no-op
      }
    };

    await expect(consume()).rejects.toThrow(
      "Runner request frames require executeFrames()",
    );
  });
});

import { describe, expect, it } from "vitest";

import {
  readClaudeBackgroundDeliveryMetadata,
} from "../../src/engine/claude_background_delivery_metadata.js";
import {
  readClaudeBackgroundProvenance,
} from "../../src/engine/claude_background_provenance.js";
import { sseEventFromRunnerFrame } from "../../src/runner/engine_event_stream.js";
import { engineEventFrame } from "../../src/runner/frame_protocol.js";

describe("sseEventFromRunnerFrame", () => {
  it("round-trips Claude process-local metadata through the JSON frame envelope", () => {
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
    if (frame.kind !== "engine_event") throw new Error("Expected engine_event frame");

    const event = sseEventFromRunnerFrame(frame);

    expect(readClaudeBackgroundProvenance(event)).toBe("sdk_membership");
    expect(readClaudeBackgroundDeliveryMetadata(event)).toEqual(delivery);
    expect(JSON.parse(JSON.stringify(frame))).toEqual(frame);
  });
});

import { describe, expect, it } from "vitest";

import {
  attachClaudeBackgroundDeliveryMetadata,
  readClaudeBackgroundDeliveryMetadata,
  type ClaudeBackgroundDeliveryMetadata,
} from "../../src/engine/claude_background_delivery_metadata.js";
import {
  applyRunnerClaudeRuntimeObservationResult,
  buildRunnerClaudeRuntimeObservationResult,
} from "../../src/runner/runner_claude_runtime_observation.js";
import {
  RunnerFrameSchema,
  runnerRequestFrame,
} from "../../src/runner/frame_protocol.js";

const delivery: ClaudeBackgroundDeliveryMetadata = {
  deliveryId: "delivery-1",
  completionId: "completion-1",
  relationKey: "claude_runtime:session-a:task-1",
  producerTerminalRevision: "terminal-1",
  deliveryCreatedAt: "2026-08-22T00:00:00.000Z",
  source: "claude_runtime_background_task_followup",
  storedPayload: { followup_task_ids: ["task-1"] },
  storedPayloadHash: "payload-hash-1",
};

describe("runner Claude runtime observation contract", () => {
  it("returns host-owned delivery metadata and restores it on the child event", () => {
    const hostEvent = {};
    attachClaudeBackgroundDeliveryMetadata(hostEvent, delivery);
    const result = buildRunnerClaudeRuntimeObservationResult(true, hostEvent);
    const childEvent = {};

    expect(applyRunnerClaudeRuntimeObservationResult(childEvent, result)).toBe(true);
    expect(readClaudeBackgroundDeliveryMetadata(childEvent)).toEqual(delivery);
  });

  it("accepts legacy boolean host responses during a rolling upgrade", () => {
    expect(applyRunnerClaudeRuntimeObservationResult({}, true)).toBe(true);
    expect(applyRunnerClaudeRuntimeObservationResult({}, false)).toBe(false);
  });

  it("carries restored delivery metadata through a detached publish frame", () => {
    const childEvent = {
      type: "claude_runtime_task_updated",
      taskId: "task-1",
      patch: { status: "completed" },
    };
    applyRunnerClaudeRuntimeObservationResult(childEvent, {
      accepted: true,
      claudeBackgroundDelivery: delivery,
    });

    const frame = runnerRequestFrame("host:publish", {
      kind: "host_call",
      service: "detached_event",
      operation: "publish",
      args: ["session-a", { ...childEvent }, {
        claudeBackgroundDelivery: readClaudeBackgroundDeliveryMetadata(childEvent),
      }],
    });

    expect(RunnerFrameSchema.safeParse(frame).success).toBe(true);
  });

  it("rejects conflicting delivery metadata instead of changing identity", () => {
    const childEvent = {};
    attachClaudeBackgroundDeliveryMetadata(childEvent, {
      ...delivery,
      deliveryId: "delivery-other",
    });

    expect(() => applyRunnerClaudeRuntimeObservationResult(childEvent, {
      accepted: true,
      claudeBackgroundDelivery: delivery,
    })).toThrow("delivery metadata disagreed across host observation");
  });
});

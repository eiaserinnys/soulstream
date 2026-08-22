import { describe, expect, it, vi } from "vitest";

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

function failOnIssue(issue: Error): never {
  throw issue;
}

describe("runner Claude runtime observation contract", () => {
  it("returns host-owned delivery metadata and restores it on the child event", () => {
    const hostEvent = {};
    attachClaudeBackgroundDeliveryMetadata(hostEvent, delivery);
    const result = buildRunnerClaudeRuntimeObservationResult(true, hostEvent);
    const childEvent = {};

    expect(applyRunnerClaudeRuntimeObservationResult(
      childEvent,
      result,
      failOnIssue,
    )).toBe(true);
    expect(readClaudeBackgroundDeliveryMetadata(childEvent)).toEqual(delivery);
  });

  it("accepts legacy boolean host responses during a rolling upgrade", () => {
    expect(applyRunnerClaudeRuntimeObservationResult({}, true, failOnIssue)).toBe(true);
    expect(applyRunnerClaudeRuntimeObservationResult({}, false, failOnIssue)).toBe(false);
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
    }, failOnIssue);

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

  it("fails open and reports a malformed observation result", () => {
    const reportIssue = vi.fn();

    expect(applyRunnerClaudeRuntimeObservationResult(
      {},
      { accepted: "yes" },
      reportIssue,
    )).toBe(true);
    expect(reportIssue).toHaveBeenCalledOnce();
    expect(reportIssue.mock.calls[0]?.[0]).toHaveProperty(
      "message",
      expect.stringContaining("invalid result"),
    );
  });

  it("suppresses conflicting delivery metadata without killing the session", () => {
    const childEvent = {};
    const reportIssue = vi.fn();
    attachClaudeBackgroundDeliveryMetadata(childEvent, {
      ...delivery,
      deliveryId: "delivery-other",
    });

    expect(applyRunnerClaudeRuntimeObservationResult(childEvent, {
      accepted: true,
      claudeBackgroundDelivery: delivery,
    }, reportIssue)).toBe(false);
    expect(reportIssue).toHaveBeenCalledOnce();
    expect(reportIssue.mock.calls[0]?.[0]).toHaveProperty(
      "message",
      expect.stringContaining("delivery metadata disagreed"),
    );
    expect(readClaudeBackgroundDeliveryMetadata(childEvent)?.deliveryId)
      .toBe("delivery-other");
  });
});

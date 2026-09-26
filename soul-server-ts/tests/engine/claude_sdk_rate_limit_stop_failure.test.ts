import { describe, expect, it } from "vitest";

import type { ClaudeClientEvent } from
  "../../src/engine/claude_event_mapper.js";
import {
  captureRejectedRateLimitInfo,
  makeStopFailureError,
  observeTerminationSignal,
} from
  "../../src/engine/claude_sdk_rate_limit_stop_failure.js";

const rejectedRateLimit: ClaudeClientEvent = {
  type: "rate_limit",
  status: "rejected",
};
const rateLimitStopFailure: ClaudeClientEvent = {
  type: "claude_runtime_hook_event",
  hookEventName: "StopFailure",
  hookInput: { error: "rate_limit" },
};

describe("rate-limit StopFailure terminal signal", () => {
  it.each([
    ["five-hour", "five_hour", "2026-09-26T03:12:00.000Z"],
    ["weekly", "seven_day", "2026-10-01T00:00:00.000Z"],
    ["missing reset", "five_hour", undefined],
  ])("preserves rejected %s metadata in the terminal error", (_label, rateLimitType, resetsAt) => {
    const info = captureRejectedRateLimitInfo(undefined, {
      type: "rate_limit",
      status: "rejected",
      rateLimitType,
      ...(resetsAt ? { resetsAt } : {}),
    });

    expect(makeStopFailureError(info)).toMatchObject({
      type: "error",
      fatal: true,
      errorCode: "claude_rate_limit_stop_failure",
      rateLimitType,
      ...(resetsAt ? { resetsAt } : {}),
    });
    if (!resetsAt) expect(makeStopFailureError(info)).not.toHaveProperty("resetsAt");
  });

  it("becomes terminal regardless of which asynchronous pump reports first", () => {
    expect(observeTerminationSignal(
      observeTerminationSignal("none", rejectedRateLimit),
      rateLimitStopFailure,
    )).toBe("terminal");
    expect(observeTerminationSignal(
      observeTerminationSignal("none", rateLimitStopFailure),
      rejectedRateLimit,
    )).toBe("terminal");
  });

  it("does not terminalize warnings or unrelated StopFailure events", () => {
    expect(observeTerminationSignal("none", {
      type: "rate_limit",
      status: "allowed_warning",
    })).toBe("none");
    expect(observeTerminationSignal("rejected", {
      type: "claude_runtime_hook_event",
      hookEventName: "StopFailure",
      hookInput: { error: "tool_error" },
    })).toBe("rejected");
  });
});

import { describe, expect, it } from "vitest";

import type { ClaudeClientEvent } from
  "../../src/engine/claude_event_mapper.js";
import { observeTerminationSignal } from
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

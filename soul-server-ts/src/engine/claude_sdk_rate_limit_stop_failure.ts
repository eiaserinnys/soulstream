import type { ClaudeClientEvent } from "./claude_event_mapper.js";

export type RateLimitTerminationState =
  | "none"
  | "rejected"
  | "stop_failure"
  | "terminal";

export function observeTerminationSignal(
  state: RateLimitTerminationState,
  event: ClaudeClientEvent,
): RateLimitTerminationState {
  if (isRejectedRateLimit(event)) {
    return state === "stop_failure" ? "terminal" : "rejected";
  }
  if (isRateLimitStopFailure(event)) {
    return state === "rejected" ? "terminal" : "stop_failure";
  }
  return state;
}

function isRejectedRateLimit(event: ClaudeClientEvent): boolean {
  return event.type === "rate_limit" && event.status === "rejected";
}

function isRateLimitStopFailure(event: ClaudeClientEvent): boolean {
  return (
    event.type === "claude_runtime_hook_event" &&
    event.hookEventName === "StopFailure" &&
    event.hookInput?.error === "rate_limit"
  );
}

export function makeStopFailureError(): ClaudeClientEvent {
  return {
    type: "error",
    fatal: true,
    errorCode: "claude_rate_limit_stop_failure",
    message: "Claude foreground turn stopped after a rate-limit rejection.",
  };
}

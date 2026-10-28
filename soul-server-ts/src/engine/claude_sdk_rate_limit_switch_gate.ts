import type { ClaudeClientEvent } from "./claude_client_event.js";
import {
  captureRejectedRateLimitInfo,
  observeTerminationSignal,
  type RateLimitStopInfo,
  type RateLimitTerminationState,
} from "./claude_sdk_rate_limit_stop_failure.js";

export type ClaudeRateLimitSwitchObservation =
  | { kind: "pass"; events: ClaudeClientEvent[] }
  | { kind: "pending" }
  | { kind: "switch"; info: RateLimitStopInfo };

/** Holds one account's terminal signal pair until the turn driver can decide. */
export class ClaudeSdkRateLimitSwitchGate {
  private state: RateLimitTerminationState = "none";
  private info: RateLimitStopInfo | undefined;
  private buffered: ClaudeClientEvent[] = [];

  observe(event: ClaudeClientEvent): ClaudeRateLimitSwitchObservation {
    if (this.state === "none") {
      const state = observeTerminationSignal(this.state, event);
      if (state === "none") return { kind: "pass", events: [event] };
      this.state = state;
      this.info = captureRejectedRateLimitInfo(this.info, event);
      this.buffered.push(event);
      return { kind: "pending" };
    }

    this.buffered.push(event);
    this.state = observeTerminationSignal(this.state, event);
    this.info = captureRejectedRateLimitInfo(this.info, event);
    if (this.state === "terminal") {
      return { kind: "switch", info: this.info ?? {} };
    }
    return { kind: "pending" };
  }

  flush(): ClaudeClientEvent[] {
    const events = this.buffered;
    this.reset();
    return events;
  }

  discard(): ClaudeClientEvent[] {
    const events = this.buffered;
    this.reset();
    return events;
  }

  hasPendingSignal(): boolean {
    return this.state !== "none";
  }

  private reset(): void {
    this.state = "none";
    this.info = undefined;
    this.buffered = [];
  }
}

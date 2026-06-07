import { describe, expect, it } from "vitest";

import {
  WAKE_CLASS_BY_EVENT_TYPE,
  classifyWakeEvent,
  type KnownSseEventType,
  type WakeClass,
} from "../../src/supervisor/wake_classification.js";

describe("Supervisor wake classification", () => {
  it("is exhaustive over the generated wire-schema SSE event type union", () => {
    const exhaustive: Record<KnownSseEventType, WakeClass> = WAKE_CLASS_BY_EVENT_TYPE;
    expect(exhaustive.session_ended).toBe("wake");
    expect(exhaustive.credential_alert).toBe("critical");
    expect(exhaustive.assistant_error).toBe("critical");
    expect(exhaustive.away_summary).toBe("batch");
  });

  it("degrades unknown / non-wire event types to quiet without throwing", () => {
    // Unknown types must never throw on the wake hot path — a runtime throw here
    // stalls the flush cursor and collapses the orch↔node WebSocket (P0).
    // Compile-time exhaustiveness over the wire union is enforced by the
    // `satisfies` in wake_classification.ts; runtime degrades to "quiet".
    expect(classifyWakeEvent("new_unmapped_event")).toBe("quiet");
  });

  it("classifies the internal 'metadata' DB event as quiet (regression)", () => {
    // `metadata` is written by appendMetadata (caller_info etc.) and reaches the
    // supervisor wake path via supervisor_events, but is not part of the SSE wire
    // union. It must classify as quiet, never throw.
    expect(classifyWakeEvent("metadata")).toBe("quiet");
  });
});

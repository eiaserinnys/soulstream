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

  it("returns null for unknown events instead of throwing or classifying as quiet", () => {
    expect(() => classifyWakeEvent("metadata")).not.toThrow();
    expect(classifyWakeEvent("metadata")).toBeNull();
    expect(() => classifyWakeEvent("system_message")).not.toThrow();
    expect(classifyWakeEvent("system_message")).toBeNull();
  });
});

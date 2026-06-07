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

  it("does not silently classify unknown events as quiet", () => {
    expect(() => classifyWakeEvent("new_unmapped_event")).toThrow(
      "Unmapped SSE event type: new_unmapped_event",
    );
  });
});

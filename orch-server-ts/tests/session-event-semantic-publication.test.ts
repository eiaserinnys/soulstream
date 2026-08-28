import { describe, expect, it } from "vitest";

import { shouldPublishSessionEventSemantically } from
  "../src/session/session_event_semantic_publication.js";

describe("session event semantic publication", () => {
  it("isolates only rejected session terminals", () => {
    expect(shouldPublishSessionEventSemantically({
      eventType: "session_ended",
      sessionEffectApplied: false,
    })).toBe(false);
    expect(shouldPublishSessionEventSemantically({
      eventType: "session_ended",
      sessionEffectApplied: true,
    })).toBe(true);
    expect(shouldPublishSessionEventSemantically({
      eventType: "session_ended",
    })).toBe(true);
    expect(shouldPublishSessionEventSemantically({
      eventType: "assistant_message",
      sessionEffectApplied: false,
    })).toBe(true);
  });
});

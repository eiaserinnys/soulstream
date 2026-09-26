import { describe, expect, it } from "vitest";
import { resolveSearchChatFocus } from "./search-focus";

describe("resolveSearchChatFocus", () => {
  it("maps result and complete events to their visible assistant turn", () => {
    expect(resolveSearchChatFocus(42, "result")).toEqual({
      eventId: 42,
      target: "assistant_turn",
    });
    expect(resolveSearchChatFocus(43, "complete")).toEqual({
      eventId: 43,
      target: "assistant_turn",
    });
  });

  it("opens a thinking hit at the session and keeps other event IDs exact", () => {
    expect(resolveSearchChatFocus(44, "thinking")).toEqual({
      eventId: null,
      target: "session",
    });
    expect(resolveSearchChatFocus(45, "assistant_message")).toEqual({
      eventId: 45,
      target: "event",
    });
  });
});

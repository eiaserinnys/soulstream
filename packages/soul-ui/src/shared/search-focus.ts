/** Search hits that point at a turn boundary should open the transcript at its visible row. */
export type ChatFocusTarget = "event" | "assistant_turn" | "session";

export interface SearchChatFocus {
  eventId: number | null;
  target: ChatFocusTarget;
}

export function resolveSearchChatFocus(eventId: number, eventType: string): SearchChatFocus {
  if (eventType === "thinking") return { eventId: null, target: "session" };
  if (eventType === "result" || eventType === "complete") {
    return { eventId, target: "assistant_turn" };
  }
  return { eventId, target: "event" };
}

import type { ChatMessage } from "./flatten-tree";

/**
 * Late summaries are durable after the turn they describe. Move each caption
 * behind its final assistant event while retaining every existing message
 * object reference. An anchor outside the loaded history remains hidden until
 * pagination prepends that event and this pure function runs again.
 */
export function placeTurnSummaries(messages: ChatMessage[]): ChatMessage[] {
  const summaries = messages.filter((message) => message.role === "turn_summary");
  if (summaries.length === 0) return messages;

  const placed = messages.filter((message) => message.role !== "turn_summary");
  for (const summary of summaries) {
    const anchorEventId = summary.anchorFinalResponseEventId;
    if (anchorEventId === undefined) continue;
    let anchorIndex = placed.findIndex(
      (message) => message.eventId === anchorEventId,
    );
    if (anchorIndex < 0) continue;
    while (
      placed[anchorIndex + 1]?.role === "turn_summary" &&
      placed[anchorIndex + 1]?.anchorFinalResponseEventId === anchorEventId
    ) {
      anchorIndex += 1;
    }
    placed.splice(anchorIndex + 1, 0, summary);
  }
  return placed;
}

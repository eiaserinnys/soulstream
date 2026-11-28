import type { CardControlPlaneService } from "./card_control_plane_service.js";

export function isDirectHumanSessionInput(callerInfo: Record<string, unknown> | undefined): callerInfo is Record<string, unknown> & { user_id: string } {
  return typeof callerInfo?.user_id === "string" && callerInfo.user_id.length > 0
    && callerInfo.source !== "agent" && callerInfo.source !== "system";
}

export async function recordDirectHumanSessionInput(
  cards: Pick<CardControlPlaneService, "getAssignedCardContext" | "getCard" | "addComment">,
  targetSessionId: string,
  text: string,
  callerInfo: Record<string, unknown> | undefined,
): Promise<void> {
  if (!text || !isDirectHumanSessionInput(callerInfo)) return;
  const assigned = await cards.getAssignedCardContext(targetSessionId);
  for (const summary of assigned.cards) {
    const detail = await cards.getCard(summary.id);
    if (!detail) continue;
    const card = detail.card;
    if (card.archived || card.assignee_kind !== "session" || card.assignee_session_id !== targetSessionId) continue;
    await cards.addComment({ actorKind: "user", actorSessionId: null, actorUserId: callerInfo.user_id,
      cardId: card.id, expectedVersion: card.version, body: text, alreadyDelivered: true });
    return;
  }
}

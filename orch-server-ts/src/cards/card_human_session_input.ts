import type { CardControlPlaneService } from "./card_control_plane_service.js";
import { CardVersionConflict } from "./control_plane/card_models.js";

export function isDirectHumanSessionInput(callerInfo: Record<string, unknown> | undefined): callerInfo is Record<string, unknown> & { user_id: string } {
  return typeof callerInfo?.user_id === "string" && callerInfo.user_id.length > 0
    && callerInfo.source !== "agent" && callerInfo.source !== "system";
}

export async function recordDirectHumanSessionInput(
  cards: Pick<CardControlPlaneService, "getDirectInputCardId" | "getCard" | "addComment">,
  targetSessionId: string,
  text: string,
  callerInfo: Record<string, unknown> | undefined,
): Promise<void> {
  if (!text.trim() || !isDirectHumanSessionInput(callerInfo)) return;
  const cardId = await cards.getDirectInputCardId(targetSessionId);
  if (!cardId) return;
  for (let attempt = 0; attempt < 2; attempt++) {
    const detail = await cards.getCard(cardId);
    if (!detail) return;
    const card = detail.card;
    if (card.archived || card.assignee_kind !== "session" || card.assignee_session_id !== targetSessionId) return;
    try {
      await cards.addComment({ actorKind: "user", actorSessionId: null, actorUserId: callerInfo.user_id,
        cardId: card.id, expectedVersion: card.version, body: text, alreadyDelivered: true });
      return;
    } catch (error) {
      if (!(error instanceof CardVersionConflict) || attempt === 1) throw error;
    }
  }
}

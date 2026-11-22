import type { CardControlPlaneService } from "./card_control_plane_service.js";
import type { CardRow } from "./control_plane/card_types.js";

export function isAssigneeError(session: Readonly<Record<string, unknown>>): boolean {
  const eventId = Number(session.termination_event_id);
  return session.status === "error" && session.termination_reason !== "limit_hit" && session.termination_reason !== "killed"
    && Number.isSafeInteger(eventId) && eventId > 0;
}

export async function blockAssigneeError(
  cards: CardControlPlaneService, card: CardRow, session: Readonly<Record<string, unknown>>, warn: (message: string) => void,
): Promise<void> {
  const detail = typeof session.termination_detail === "string" && session.termination_detail
    ? `: ${session.termination_detail.slice(0, 200)}` : "";
  const blockedDetail = `담당 세션이 오류로 끝났습니다(${session.termination_reason ?? null})${detail}`;
  try {
    await cards.setCardStatus({ actorKind: "system", actorSessionId: null, cardId: card.id, status: "blocked",
      blockedKind: "no_report", blockedDetail, expectedVersion: card.version });
  } catch (error) {
    warn(`card ${card.id} assignee error block skipped: ${String(error)}`);
    return;
  }
  try {
    await cards.updateCardNow({ actorKind: "system", actorSessionId: null, cardId: card.id,
      now: "담당 세션이 오류로 끝나 멈췄습니다", turn: "outside" });
  } catch (error) { warn(`card ${card.id} assignee error board reason failed: ${String(error)}`); }
}

import { cardStatusLabels, type CardChangeDelivery } from "./card_change_notification.js";
import type { CardStatus } from "./control_plane/card_types.js";

// Failure ceilings, not a delay on the normal completion path.
export const PENDING_DELIVERY_FAILURE_CEILING_MS = 30 * 60 * 1000;
export const COMPLETION_REGISTRATION_FAILURE_CEILING_MS = 5 * 60 * 1000;
export const MAX_REMINDERS_PER_TICK = 2;

export type CardReminderFacts = {
  cardId: string;
  cardStatus: CardStatus;
  statusEpochUs: string;
  rootSessionId: string;
  rootStatus: string;
  rootTerminationReason: string | null;
  activeDescendants: boolean;
  activeTree: boolean;
  pendingDeliveries: boolean;
  unhandledCommentId: string | null;
  unregisteredCompletions: boolean;
  rootEndedAfterStatus: boolean;
};
export function buildCardStatusReminder(facts: CardReminderFacts, rootEnded: boolean):
  (CardChangeDelivery & { sessionId: string; text: string }) | null {
  if (!["completed", "error"].includes(facts.rootStatus) || facts.rootTerminationReason === "limit_hit") return null;
  let kind: "comment_unhandled" | "not_running" | "stalled", text: string;
  if (rootEnded && facts.unhandledCommentId && !facts.pendingDeliveries) {
    kind = "comment_unhandled";
    text = `[카드 상태 확인] 카드 ${facts.cardId}는 '${cardStatusLabels[facts.cardStatus]}'인데, 사용자 커멘트(ID ${facts.unhandledCommentId})가 전달된 뒤 카드 상태, 항목, 커멘트에 바뀐 것이 없습니다. 수정 지시였으면 항목을 하는 중으로 알리고 카드를 진행 중으로 옮긴 뒤 진행하고, 질문이었으면 답 커멘트를 남기세요.`;
  } else if (facts.cardStatus !== "running") {
    if (!rootEnded || !facts.activeDescendants) return null;
    kind = "not_running";
    text = `[카드 상태 확인] 카드 ${facts.cardId}는 '${cardStatusLabels[facts.cardStatus]}'인데, 담당 세션이 턴을 마친 뒤에도 맡긴 작업 세션이 돌고 있습니다.`;
  } else {
    if (facts.activeTree || facts.pendingDeliveries || facts.unregisteredCompletions || !facts.rootEndedAfterStatus) return null;
    kind = "stalled";
    text = `[카드 상태 확인] 카드 ${facts.cardId}는 진행 중인데 담당 세션과 맡긴 작업 세션이 모두 멈췄습니다.`;
  }
  return { sessionId: facts.rootSessionId, text, actorKind: "system", actorSessionId: null,
    deliveryId: kind === "comment_unhandled"
      ? `card-reminder:${facts.cardId}:${kind}:${facts.unhandledCommentId}:${facts.rootSessionId}`
      : `card-reminder:${facts.cardId}:${kind}:${facts.statusEpochUs}:${facts.rootSessionId}` };
}

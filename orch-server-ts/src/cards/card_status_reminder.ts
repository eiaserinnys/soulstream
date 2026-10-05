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
  unregisteredCompletions: boolean;
  rootEndedAfterStatus: boolean;
};
export function buildCardStatusReminder(facts: CardReminderFacts, rootEnded: boolean):
  (CardChangeDelivery & { sessionId: string; text: string }) | null {
  if (!["completed", "error"].includes(facts.rootStatus) || facts.rootTerminationReason === "limit_hit") return null;
  let kind: "not_running" | "stalled", text: string;
  if (facts.cardStatus !== "running") {
    if (!rootEnded || !facts.activeDescendants) return null;
    kind = "not_running";
    text = `[카드 상태 확인] 카드 ${facts.cardId}는 '${cardStatusLabels[facts.cardStatus]}'인데, 담당 세션이 턴을 마친 뒤에도 맡긴 작업 세션이 돌고 있습니다.`;
  } else {
    if (facts.activeTree || facts.pendingDeliveries || facts.unregisteredCompletions || !facts.rootEndedAfterStatus) return null;
    kind = "stalled";
    text = `[카드 상태 확인] 카드 ${facts.cardId}는 진행 중인데 담당 세션과 맡긴 작업 세션이 모두 멈췄습니다.`;
  }
  return { sessionId: facts.rootSessionId, text, actorKind: "system", actorSessionId: null,
    deliveryId: `card-reminder:${facts.cardId}:${kind}:${facts.statusEpochUs}:${facts.rootSessionId}` };
}

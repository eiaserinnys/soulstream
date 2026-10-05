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
    text = `[카드 상태 확인] 카드 ${facts.cardId}의 담당 세션이 턴을 마쳤는데 맡긴 작업 세션이 아직 돌고 있고, 카드는 '${cardStatusLabels[facts.cardStatus]}'입니다. 이 카드의 일이 진행 중이라면 진행 중으로 옮겨 주세요. 이 카드와 무관한 일이면 그대로 두어도 됩니다. 카드 상태는 시스템이 바꾸지 않습니다.`;
  } else {
    if (facts.activeTree || facts.pendingDeliveries || facts.unregisteredCompletions || !facts.rootEndedAfterStatus) return null;
    kind = "stalled";
    text = `[카드 상태 확인] 카드 ${facts.cardId}는 진행 중인데 담당 세션과 맡긴 작업 세션이 모두 멈췄습니다. 일을 마쳤으면 확인 항목에 결과를 달고 request_card_review의 ask에 사용자가 볼 것을 적어 검수를 요청하세요. 확인 항목이 없는 옛 카드는 기존 보고를 올리고 검수를 요청하세요. 답이나 자료를 기다리면 막힘으로 옮기고, 할 일이 남아 멈춘 것이라면 이어서 진행하세요. 턴을 끝내기 전에 update_card_now로 지금과 누구 차례를 맞추세요. 카드 상태는 시스템이 바꾸지 않습니다.`;
  }
  return { sessionId: facts.rootSessionId, text, actorKind: "system", actorSessionId: null,
    deliveryId: `card-reminder:${facts.cardId}:${kind}:${facts.statusEpochUs}:${facts.rootSessionId}` };
}

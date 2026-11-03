import { cardStatusLabels, type CardChangeDelivery } from "./card_change_notification.js";
import type { CardRow, CardStatus } from "./control_plane/card_types.js";
import type { CardOwnerSession } from "./card_session_target.js";

export function buildCardBlockedNotice(
  card: Pick<CardRow, "id" | "number" | "title" | "blocked_detail" | "blocked_kind" | "assignee_session_id" | "node_id" | "assignee_agent_id" | "model_preset">,
  owner: Pick<CardOwnerSession, "node_id" | "agent_id" | "model_preset"> | null,
): string {
  const node = card.assignee_session_id ? owner?.node_id : card.node_id;
  const agent = card.assignee_session_id ? owner?.agent_id : card.assignee_agent_id;
  const model = card.assignee_session_id ? owner?.model_preset : card.model_preset;
  return `[카드 막힘] 맡긴 카드 #${card.number} 「${card.title}」(${card.id})가 막혔습니다. 사유: ${card.blocked_detail ?? "없음"}(${card.blocked_kind}). 담당 세션 ${card.assignee_session_id ?? "없음"}, 노드 ${node ?? "?"}, 에이전트 ${agent ?? "?"}, 모델 ${model ?? "?"}. 담당이 이어 가지 못하는 막힘입니다. 다른 모델이나 노드로 담당을 바꿔 이어 가려면 dispatch_work에 card_id와 replace_assignee=true를 보내세요.`;
}

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

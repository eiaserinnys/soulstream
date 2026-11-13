import { formatSeoulWakeTime } from "./card_verification_wait.js";
import { cardStatusLabels, type CardChangeDelivery } from "./card_change_notification.js";
import type { CardStatus } from "./control_plane/card_types.js";

// Failure ceilings, not a delay on the normal completion path.
export const PENDING_DELIVERY_FAILURE_CEILING_MS = 30 * 60 * 1000;
export const COMPLETION_REGISTRATION_FAILURE_CEILING_MS = 5 * 60 * 1000;
export const MAX_REMINDERS_PER_TICK = 2;
/** 담당이 턴을 마친 뒤 이만큼 조용하면 한 번 깨운다. 상태 세대가 아니라 턴 종료마다 센다. */
export const OWNER_SILENT_CEILING_MS = 30 * 60 * 1000;
export const OWNER_SILENT_BLOCKED_DETAIL = "담당이 턴을 마친 채 30분이 지나 깨웠지만, 그 뒤 30분 동안 움직임이 없음";

export type CardReminderFacts = {
  cardId: string;
  cardNumber: number;
  cardTitle: string;
  cardVersion: number;
  cardStatus: CardStatus;
  statusEpochUs: string;
  rootSessionId: string;
  rootStatus: string;
  rootTerminationReason: string | null;
  rootTerminationEventId: number | null;
  activeDescendants: boolean;
  activeTree: boolean;
  pendingDeliveries: boolean;
  unhandledCommentId: string | null;
  unregisteredCompletions: boolean;
  rootEndedAfterStatus: boolean;
  pendingExecution: boolean;
  lastRootTurnEndedAt: Date | null;
  latestRootDeliveryId: string | null;
};
/** 루트 세션이 정상 종료했고 한도 중단이 아닐 때만 상태 확인 대상이다. */
function isTerminalRoot(facts: CardReminderFacts): boolean {
  return ["completed", "error"].includes(facts.rootStatus) && facts.rootTerminationReason !== "limit_hit";
}
function isRunningStatus(status: CardStatus): boolean {
  return status === "running";
}
export function buildCardStatusReminder(facts: CardReminderFacts, rootEnded: boolean):
  (CardChangeDelivery & { sessionId: string; text: string }) | null {
  if (!isTerminalRoot(facts)) return null;
  let kind: "comment_unhandled" | "not_running" | "stalled", text: string;
  if (rootEnded && facts.unhandledCommentId && !facts.pendingDeliveries) {
    kind = "comment_unhandled";
    text = `[카드 상태 확인] 카드 ${facts.cardId}는 '${cardStatusLabels[facts.cardStatus]}'인데, 사용자 커멘트(ID ${facts.unhandledCommentId})가 전달된 뒤 카드 상태, 항목, 커멘트에 바뀐 것이 없습니다. 수정 지시였으면 항목을 하는 중으로 알리고 카드를 진행 중으로 옮긴 뒤 진행하고, 질문이었으면 답 커멘트를 남기세요.`;
  } else if (!isRunningStatus(facts.cardStatus)) {
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

export type CardOwnerSilentAction =
  | { kind: "wake"; reminder: CardChangeDelivery & { sessionId: string; text: string } }
  | { kind: "block"; blockedDetail: string };

/** 상태 세대가 아니라 루트의 마지막 턴 종료마다 한 번인 깨움이다. */
export function ownerSilentDeliveryId(facts: CardReminderFacts): string {
  return `card-reminder:${facts.cardId}:owner_silent:${facts.rootTerminationEventId}:${facts.rootSessionId}`;
}

/** 마지막 턴을 깨운 전달이 이 카드의 owner_silent 깨움이면 그 턴은 깨움에 대한 응답 턴이다. */
export function isOwnerSilentResponseTurn(facts: CardReminderFacts): boolean {
  return facts.latestRootDeliveryId?.startsWith(`card-reminder:${facts.cardId}:owner_silent:`) === true;
}

/** 카드가 실행 중인데 담당이 턴을 마친 채 조용한가. 기존 stalled 게이트에 실행 예약과 턴 종료 시각을 더 본다. */
function ownerSilentTarget(facts: CardReminderFacts, now: number): boolean {
  return isRunningStatus(facts.cardStatus)
    && !facts.activeTree
    && !facts.pendingDeliveries
    && !facts.unregisteredCompletions
    && facts.rootEndedAfterStatus
    && !facts.pendingExecution
    && facts.lastRootTurnEndedAt !== null
    && now - facts.lastRootTurnEndedAt.getTime() >= OWNER_SILENT_CEILING_MS;
}

/**
 * 1단계는 담당을 한 번 깨우고, 그 깨움에 대한 응답 턴마저 30분 조용하면 2단계로 막힘을 남긴다.
 * 기존 stalled가 상태 세대마다 한 번뿐이라 그 뒤로 아무 깨움도 없던 자리를 메운다.
 */
export function buildOwnerSilentAction(facts: CardReminderFacts, now: number): CardOwnerSilentAction | null {
  if (!isTerminalRoot(facts)) return null;
  if (!ownerSilentTarget(facts, now)) return null;
  if (isOwnerSilentResponseTurn(facts)) return { kind: "block", blockedDetail: OWNER_SILENT_BLOCKED_DETAIL };
  const lastTurnEnd = formatSeoulWakeTime(facts.lastRootTurnEndedAt!, new Date(now));
  return { kind: "wake", reminder: { sessionId: facts.rootSessionId, actorKind: "system", actorSessionId: null,
    deliveryId: ownerSilentDeliveryId(facts),
    text: `[카드 상태 확인] 카드 #${facts.cardNumber} 「${facts.cardTitle}」(${facts.cardId})는 진행 중인데 담당 세션이 30분 넘게 턴을 마친 채이고, 돌고 있는 하위 세션도 예약된 깨움도 없습니다. 마지막 턴 종료: ${lastTurnEnd}. 기다리는 것이 있으면 무엇인지와 그것이 실제로 올 수 있는지 확인하세요. 끝난 하위 세션은 스스로 다시 보고하지 않습니다(완료 알림에 「이어서 다시 보고합니다」가 있던 경우만 예외). 올 수 없으면 결과를 직접 확인해 이어 가고, 정한 시각에 다시 볼 일이면 검증 대기(깨울 시각과 기다리는 것)로, 남이 풀어 줄 일이면 막힘으로 옮기세요. 이대로 30분이 더 지나면 카드를 막힘으로 옮깁니다.` } };
}

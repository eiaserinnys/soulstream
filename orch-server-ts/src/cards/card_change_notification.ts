import type { CardMutationChange } from "./card_control_plane_service.js";

export type CardChangeDelivery = { deliveryId:string; actorKind:string; actorSessionId:string | null };
export type CardCommentNotificationDetails = { itemTarget?:{id:number;title:string}; confirmedItemIds?:number[] };
export const cardStatusLabels:Record<string,string>={todo:"할 일",queued:"대기",running:"실행 중",blocked:"막힘",review:"검수",done:"완료",cancelled:"취소"};

/** Uses transaction-captured state, rather than a newer read or the comment's spoken author projection. */
export function buildCardChangeNotification(change:CardMutationChange,comment?:Record<string,unknown>,fallbackSessionId?:string | null,
  details?:CardCommentNotificationDetails) {
  if (change.result.operation.operation_type === "execute_card" || change.result.idempotent || !change.committedCard) return null;
  const {result,committedCard:card,previousStatus,previousAssigneeSessionId}=change;
  const op=result.operation;
  const kind=op.operation_type === "add_card_comment" ? "comment" : "state";
  const sessionId=previousAssigneeSessionId ?? (kind === "comment" ? fallbackSessionId : null);
  if (!sessionId || op.actor_session_id === sessionId || kind === "state" && card.status === "done") return null;
  const actor=op.actor_kind === "user" ? "사용자" : op.actor_session_id ? `세션 ${op.actor_session_id}` : op.actor_kind === "system" ? "시스템" : op.actor_kind;
  const target=`카드 「${card.title}」(${card.id})`;
  let text:string;
  if (kind === "comment") {
    if (!comment || comment.author_kind !== "user" || comment.delivered_at) return null;
    text=`${actor}가 ${target}에 커멘트를 남겼습니다: ${String(comment.body)}`;
    text+=`\n커멘트 ID: ${String(comment.id ?? op.payload_json.comment_id ?? "")}`;
    if (details?.itemTarget) text+=`\n대상 항목: ${details.itemTarget.id}번 ${details.itemTarget.title}`;
    if (details?.confirmedItemIds?.length) text+=`\n그동안 확인한 항목: ${details.confirmedItemIds.map(id=>`${id}번`).join(", ")}`;
  } else {
    if (!previousStatus || previousStatus === card.status) return null;
    text=`${actor}가 ${target}를 ${cardStatusLabels[previousStatus]}→${cardStatusLabels[card.status]}으로 변경했습니다`;
    if (op.reason) text+=`: ${op.reason}`;
  }
  return {sessionId,text,deliveryId:`card:${card.id}:${kind}:${op.id}:${sessionId}`,actorKind:op.actor_kind,actorSessionId:op.actor_session_id};
}

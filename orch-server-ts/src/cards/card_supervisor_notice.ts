import type { CardRow, CardStatus, FolderOperationActorKind } from "./control_plane/card_types.js";
import type { CardItemState } from "./card_item_rules.js";
import type { CardOwnerSession } from "./card_session_target.js";

type NoticeCard = Pick<CardRow, "id" | "number" | "title">;

export function selectCardSupervisorNotice({operationType, actorKind, previousStatus, committed}: {
  operationType: string; actorKind: FolderOperationActorKind; previousStatus?: CardStatus; committed: CardRow;
}): "blocked" | "question" | "review" | "done" | null {
  if (committed.archived) return null;
  if (operationType === "ask_card_question") return "question";
  if (operationType !== "set_card_status") return null;
  if (actorKind === "system" && previousStatus !== "blocked" && committed.status === "blocked"
      && (committed.blocked_kind === "limit" || committed.blocked_kind === "no_report")) return "blocked";
  if (previousStatus !== "review" && committed.status === "review") return "review";
  if (previousStatus !== "done" && committed.status === "done") return "done";
  return null;
}

export function buildCardBlockedNotice(
  card: Pick<CardRow, "id" | "number" | "title" | "blocked_detail" | "blocked_kind" | "assignee_session_id" | "node_id" | "assignee_agent_id" | "model_preset">,
  owner: Pick<CardOwnerSession, "node_id" | "agent_id" | "model_preset"> | null,
): string {
  const node = card.assignee_session_id ? owner?.node_id : card.node_id;
  const agent = card.assignee_session_id ? owner?.agent_id : card.assignee_agent_id;
  const model = card.assignee_session_id ? owner?.model_preset : card.model_preset;
  return `[카드 막힘] 맡긴 카드 #${card.number} 「${card.title}」(${card.id})가 막혔습니다. 사유: ${card.blocked_detail ?? "없음"}(${card.blocked_kind}). 담당 세션 ${card.assignee_session_id ?? "없음"}, 노드 ${node ?? "?"}, 에이전트 ${agent ?? "?"}, 모델 ${model ?? "?"}. 담당이 이어 가지 못하는 막힘입니다. 다른 모델이나 노드로 담당을 바꿔 이어 가려면 dispatch_work에 card_id와 replace_assignee=true를 보내세요.`;
}

export function buildCardQuestionNotice(card: NoticeCard, text: string, options: string[], questionId?: string): string {
  return `[카드 질문] 맡긴 카드 #${card.number} 「${card.title}」(${card.id})에 담당이 질문을 열었습니다. 질문${questionId ? ` ${questionId}` : ""}: ${text} 선택지: ${options.length ? options.join(" / ") : "없음"}. 디렉터 판에 질문 장이 올라 있습니다.`;
}

const itemStateLabels: Record<CardItemState, string> = {done:"결과 있음",doing:"하는 중",todo:"아직",dropped:"뺌"};
export function buildCardReviewNotice(card: NoticeCard & Pick<CardRow, "now" | "items">): string {
  const items = card.items;
  return `[카드 검수 대기] 맡긴 카드 #${card.number} 「${card.title}」(${card.id})가 검수 대기가 됐습니다. 볼 것: ${card.now?.ask || card.now?.text || "없음"}. 확인 항목: ${items.length ? items.map(item => `${item.id}. ${item.title}(${itemStateLabels[item.state]})`).join(", ") : "없음"}.`;
}

export function buildCardDoneNotice(card: NoticeCard & Pick<CardRow, "completed_kind">): string {
  return `[카드 완료] 맡긴 카드 #${card.number} 「${card.title}」(${card.id})가 완료됐습니다. 완료한 쪽: ${card.completed_kind === "user" ? "사람" : card.completed_kind === "agent" ? "담당 세션" : "시스템"}.`;
}

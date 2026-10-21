import type { ChatMessage } from "./flatten-tree";

/**
 * PAS 화면의 작업 세부(요약, 맥락) 줄을 표시 설정에 맞춰 투영한다.
 * true면 받은 메시지를 그대로 두고, false면 요약 위치에 붙지 못한 요약 메시지와
 * 요약·맥락 캡션만 지운다. 도구 활동 줄은 그룹핑 단계에서 걸러낸다.
 */
export function projectPersistentWorkDetails(
  messages: ChatMessage[],
  showWorkDetails: boolean,
): ChatMessage[] {
  if (showWorkDetails) return messages;
  return messages.flatMap((message) => {
    if (message.treeNodeType === "turn_summary") return [];
    const hidesSummaryCaption = message.turnSummaryCaption !== undefined;
    const hidesUserContext = (message.role === "user" || message.role === "intervention")
      && message.contextItems !== undefined;
    if (!hidesSummaryCaption && !hidesUserContext) return [message];
    const next = { ...message };
    if (hidesSummaryCaption) delete next.turnSummaryCaption;
    if (hidesUserContext) delete next.contextItems;
    return [next];
  });
}

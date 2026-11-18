/** Pure visibility policy shared by consumers of session events. */
export const SILENT = "[SILENT]";
export const CARD_NOTICE_TAGS = ["[카드 막힘]", "[카드 질문]", "[카드 검수 대기]", "[카드 완료]"] as const;
export const CARD_NOTICE_LEAD = " 맡긴 카드 #";
const LEGACY_CACHE_INPUT = "캐시 유지용 호출입니다. 도구를 쓰지 말고 '[SILENT]'만 답하십시오.";

export function isSilent(text: string, streaming = false): boolean {
  const value = text.trim();
  return value === SILENT || (streaming && value.length > 0 && SILENT.startsWith(value));
}
export function isHumanInput(type: string, payload: Record<string, unknown>): boolean {
  if (type !== "user_message" && type !== "intervention_sent") return false;
  const caller = record(payload.caller_info ?? payload.callerInfo);
  const agent = record(payload.agent_info ?? payload.agentInfo);
  const intent = payload.delivery_intent ?? payload.deliveryIntent;
  return caller?.source !== "agent" && caller?.source !== "external" && (caller !== undefined || agent?.source !== "agent")
    && intent !== "completion_notification" && intent !== "runtime_followup";
}
/** 접속 링크·웹훅 같은 외부 연동이 만든 입력. 사람 사용자와 분류는 다르지만 대화에는 보인다. */
export function isExternalInput(type: string, payload: Record<string, unknown>): boolean {
  if (type !== "user_message" && type !== "intervention_sent") return false;
  const caller = record(payload.caller_info ?? payload.callerInfo);
  const intent = payload.delivery_intent ?? payload.deliveryIntent;
  return caller?.source === "external"
    && intent !== "completion_notification" && intent !== "runtime_followup";
}
/** 대화 투영에 사용자 항목으로 보이는 입력인지. 사람이거나 외부 연동이다. */
export function isVisibleConversationInput(type: string, payload: Record<string, unknown>): boolean {
  return isHumanInput(type, payload) || isExternalInput(type, payload);
}
export function isKeepalive(payload: Record<string, unknown>): boolean {
  return payload.purpose === "cache_keepalive" || (typeof payload.text === "string" && payload.text.trim() === LEGACY_CACHE_INPUT);
}
export function isCardNoticeInput(type: string, payload: Record<string, unknown>): boolean {
  if (type !== "user_message" && type !== "intervention_sent") return false;
  const caller = record(payload.caller_info ?? payload.callerInfo);
  return caller?.source === "system" && typeof payload.text === "string"
    && CARD_NOTICE_TAGS.some(tag => (payload.text as string).startsWith(tag + CARD_NOTICE_LEAD));
}
export function isHiddenConversationInput(type: string, payload: Record<string, unknown>): boolean {
  return (type === "user_message" || type === "intervention_sent") && (isKeepalive(payload) || isCardNoticeInput(type, payload));
}
export function isInternalInput(type: string, payload: Record<string, unknown>): boolean {
  const caller = record(payload.caller_info ?? payload.callerInfo);
  const agent = record(payload.agent_info ?? payload.agentInfo);
  const intent = payload.delivery_intent ?? payload.deliveryIntent;
  return (type === "user_message" || type === "intervention_sent") && (caller?.source === "agent" || (caller === undefined && agent?.source === "agent"))
    || intent === "completion_notification" || intent === "runtime_followup";
}
export function isShortAcknowledgement(text: string): boolean {
  return text.trim() === "네" || text.trim() === "네.";
}
function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

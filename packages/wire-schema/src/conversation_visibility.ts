import { asRecord } from "./json_record.js";

export const SILENT = "[SILENT]";
export const CARD_NOTICE_TAGS = ["[카드 막힘]", "[카드 질문]", "[카드 검수 대기]", "[카드 완료]"] as const;
export const CARD_NOTICE_LEAD = " 맡긴 카드 #";
/** 영구 세션 첫 지시문의 앞머리. orch가 `${EXECUTE_INSTRUCTION_PROMPT}\n${지시}`로 붙인다. */
export const EXECUTE_INSTRUCTION_PROMPT = "업무 현황을 파악한 후, 사용자의 다음 지시를 이행해주세요.";
/** 영구 세션을 만들 때 서버가 비었을 때 채우는 기본 첫 지시. */
export const PERSISTENT_INITIAL_INSTRUCTION =
  "새 영구 에이전트 세션입니다. 도구를 쓰지 말고 짧게 인사한 뒤, 처음 쓰는 분이라면 다음 첫 요청을 그대로 보내 보시라고 권해 주십시오. 「작업실 폴더에 카드를 만들어 바로 시작해 줘. 샘플 프로젝트 소개 문서를 한 장(목표, 핵심 기능 세 가지, 첫 마일스톤) 쓰고, 세 부분을 확인 항목으로 나눠 각각 문서 링크를 단 뒤 검수를 요청해 줘.」 그다음 지시를 기다려 주십시오.";
/** 2026-10-06부터 2026-11-25 직전까지 쓰인 기본 첫 지시. 이미 저장된 세션이 있다. */
const LEGACY_PERSISTENT_INITIAL_INSTRUCTION =
  "새 영구 에이전트 세션입니다. 도구를 쓰지 말고 짧게 인사한 뒤 다음 지시를 기다려 주십시오.";
const PERSISTENT_INITIAL_INPUTS: ReadonlySet<string> = new Set(
  [PERSISTENT_INITIAL_INSTRUCTION, LEGACY_PERSISTENT_INITIAL_INSTRUCTION].map(value => `${EXECUTE_INSTRUCTION_PROMPT}\n${value}`),
);
const LEGACY_CACHE_INPUT = "캐시 유지용 호출입니다. 도구를 쓰지 말고 '[SILENT]'만 답하십시오.";

export function isSilent(text: string, streaming = false): boolean {
  const value = text.trim();
  return value === SILENT || (streaming && value.length > 0 && SILENT.startsWith(value));
}
export function isHumanInput(type: string, payload: Record<string, unknown>): boolean {
  if (type !== "user_message" && type !== "intervention_sent") return false;
  const caller = asRecord(payload.caller_info ?? payload.callerInfo);
  const agent = asRecord(payload.agent_info ?? payload.agentInfo);
  const intent = payload.delivery_intent ?? payload.deliveryIntent;
  return caller?.source !== "agent" && caller?.source !== "external" && (caller !== undefined || agent?.source !== "agent")
    && intent !== "completion_notification" && intent !== "runtime_followup";
}
export function isExternalInput(type: string, payload: Record<string, unknown>): boolean {
  if (type !== "user_message" && type !== "intervention_sent") return false;
  const caller = asRecord(payload.caller_info ?? payload.callerInfo);
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
  const caller = asRecord(payload.caller_info ?? payload.callerInfo);
  return caller?.source === "system" && typeof payload.text === "string"
    && CARD_NOTICE_TAGS.some(tag => (payload.text as string).startsWith(tag + CARD_NOTICE_LEAD));
}
export function isHiddenConversationInput(type: string, payload: Record<string, unknown>): boolean {
  return (type === "user_message" || type === "intervention_sent") && (isKeepalive(payload) || isCardNoticeInput(type, payload));
}
/** 글 하나만 있는 자리(저장된 미리보기, session.prompt)용 영구 세션 첫 지시문 판정. */
export function isPersistentInitialInstructionText(text: string): boolean {
  return PERSISTENT_INITIAL_INPUTS.has(text.trim());
}
/** 영구 세션 첫 지시문 입력인지. 사람이 쓴 글과 일반 세션 지시는 글자가 달라 거짓이다. */
export function isPersistentInitialInstructionInput(type: string, payload: Record<string, unknown>): boolean {
  return (type === "user_message" || type === "intervention_sent")
    && typeof payload.text === "string" && isPersistentInitialInstructionText(payload.text);
}
export function isInternalInput(type: string, payload: Record<string, unknown>): boolean {
  const caller = asRecord(payload.caller_info ?? payload.callerInfo);
  const agent = asRecord(payload.agent_info ?? payload.agentInfo);
  const intent = payload.delivery_intent ?? payload.deliveryIntent;
  return (type === "user_message" || type === "intervention_sent") && (caller?.source === "agent" || (caller === undefined && agent?.source === "agent"))
    || intent === "completion_notification" || intent === "runtime_followup";
}
export function isShortAcknowledgement(text: string): boolean {
  return text.trim() === "네" || text.trim() === "네.";
}

/** Pure visibility policy shared by consumers of session events. */
export const SILENT = "[SILENT]";
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
  return caller?.source !== "agent" && (caller !== undefined || agent?.source !== "agent")
    && intent !== "completion_notification" && intent !== "runtime_followup";
}
export function isKeepalive(payload: Record<string, unknown>): boolean {
  return payload.purpose === "cache_keepalive" || (typeof payload.text === "string" && payload.text.trim() === LEGACY_CACHE_INPUT);
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

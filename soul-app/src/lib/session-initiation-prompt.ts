const WAIT_FOR_USER_PROMPT = '업무 현황을 파악한 후, 사용자의 다음 지시를 대기해주세요.';
const EXECUTE_USER_PROMPT = '업무 현황을 파악한 후, 사용자의 다음 지시를 이행해주세요.';

/**
 * 웹 v3 정본과 동시 갱신한다:
 * unified-dashboard/client/v3/session-initiation-prompt.ts
 */
export function buildSessionInitiationPrompt(initialInstruction: string): string {
  const normalizedInstruction = initialInstruction.trim();
  return normalizedInstruction
    ? `${EXECUTE_USER_PROMPT}\n${normalizedInstruction}`
    : WAIT_FOR_USER_PROMPT;
}

/**
 * ChatInput 의 세션 상태별 UI 문구/색상을 한 곳에 모은 헬퍼.
 *
 * 입력: 세션이 완료된 상태(isFinished)인지, LLM 완료 세션(isLlmFinished)인지,
 *       전송 중(sending)인지, LLM 컨텍스트 메시지 개수(ctxCount).
 * 출력: 플레이스홀더, 버튼 라벨, 모드 아이콘/라벨, focus 테두리 색, 버튼 색.
 *
 * 순수 함수 — React 의존 없음.
 */

export interface ChatInputModeInput {
  isFinished: boolean;
  isLlmFinished: boolean;
  sending: boolean;
  ctxCount: number;
}

export interface ChatInputModeView {
  placeholder: string;
  buttonLabel: string;
  modeIcon: string;
  modeLabel: string;
  borderColor: string;
  buttonColor: string;
}

export function resolveChatInputMode(input: ChatInputModeInput): ChatInputModeView {
  const { isFinished, isLlmFinished, sending, ctxCount } = input;

  const placeholder = isLlmFinished
    ? `Send with ${ctxCount} messages context...`
    : isFinished
      ? "Continue the conversation..."
      : "Send a message to Claude...";

  const buttonLabel = sending
    ? "..."
    : isLlmFinished
      ? "Send"
      : isFinished
        ? "Send"
        : "Intervene";

  const modeIcon = isLlmFinished ? "\u{1F916}" : isFinished ? "\u{1F4AC}" : "\u270B";
  const modeLabel = isLlmFinished
    ? `LLM (${ctxCount} ctx)`
    : isFinished
      ? "New Chat"
      : "Intervention";

  // 색상: LLM 완료 → success(초록), resume → accent-blue, intervention → accent-orange
  const borderColor = isLlmFinished
    ? "focus:border-success/40"
    : isFinished
      ? "focus:border-accent-blue/40"
      : "focus:border-accent-orange/40";
  const buttonColor = isLlmFinished
    ? "border-success bg-success text-white hover:bg-success/90"
    : isFinished
      ? "border-accent-blue bg-accent-blue text-white hover:bg-accent-blue/90"
      : "border-accent-orange bg-accent-orange text-white hover:bg-accent-orange/90";

  return { placeholder, buttonLabel, modeIcon, modeLabel, borderColor, buttonColor };
}

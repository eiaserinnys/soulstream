/**
 * ChatInput 의 세션 상태별 UI 문구/색상을 한 곳에 모은 헬퍼.
 *
 * 입력: 세션이 완료된 상태(isFinished)인지, 전송 중(sending)인지.
 * 출력: 플레이스홀더, 버튼 라벨, 모드 아이콘/라벨, focus 테두리 색, 버튼 variant.
 *
 * 순수 함수 — React 의존 없음.
 */

import type { useTranslation } from "react-i18next";
import type { ButtonVariant } from "../ui/button";

export interface ChatInputModeInput {
  isFinished: boolean;
  sending: boolean;
}

export interface ChatInputModeView {
  placeholder: string;
  buttonLabel: string;
  modeIcon: string;
  modeLabel: string;
  borderColor: string;
  buttonVariant: Extract<ButtonVariant, "default" | "warning">;
}

export function resolveChatInputMode(input: ChatInputModeInput, t: ReturnType<typeof useTranslation>["t"]): ChatInputModeView {
  const { isFinished, sending } = input;

  const placeholder = isFinished ? t("ui.chat.continuePlaceholder") : t("ui.chat.messagePlaceholder");
  const buttonLabel = sending ? "..." : isFinished ? t("ui.chat.send") : t("ui.chat.intervention");
  const modeIcon = isFinished ? "\u{1F4AC}" : "\u270B";
  const modeLabel = isFinished ? t("ui.chat.continue") : t("ui.chat.intervention");

  // 색상 의미는 유지하되 Button variant 정본만 호출한다.
  const borderColor = isFinished ? "focus:border-accent-blue/40" : "chat-focus-warning";
  const buttonVariant = isFinished ? "default" : "warning";

  return { placeholder, buttonLabel, modeIcon, modeLabel, borderColor, buttonVariant };
}

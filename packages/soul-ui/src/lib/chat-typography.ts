export const CHAT_FONT_SIZE_STEPS = [14, 15, 16, 17, 18] as const;

export type ChatFontSize = (typeof CHAT_FONT_SIZE_STEPS)[number];

export const DEFAULT_CHAT_FONT_SIZE: ChatFontSize = 14;

const CHAT_FONT_SIZE_SET = new Set<number>(CHAT_FONT_SIZE_STEPS);

export function normalizeChatFontSize(value: unknown): ChatFontSize {
  return typeof value === "number" && Number.isInteger(value) && CHAT_FONT_SIZE_SET.has(value)
    ? value as ChatFontSize
    : DEFAULT_CHAT_FONT_SIZE;
}

export function resolveChatTypography(fontSize: ChatFontSize): {
  fontSize: ChatFontSize;
  lineHeight: number;
} {
  return {
    fontSize,
    lineHeight: fontSize + 8,
  };
}

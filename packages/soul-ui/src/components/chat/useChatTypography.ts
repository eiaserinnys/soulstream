import type { CSSProperties } from "react";
import { useDashboardStore } from "../../stores/dashboard-store";
import { resolveChatTypography } from "../../lib/chat-typography";

/** The user's chat font setting owns typography on every chat surface. */
export function useChatTypography() {
 const chatFontSize=useDashboardStore(state=>state.chatFontSize);
 const typography=resolveChatTypography(chatFontSize);
 const chatTypographyStyle={
  "--chat-font-size":`${typography.fontSize}px`,
  "--chat-line-height":`${typography.lineHeight}px`,
 } as CSSProperties;
 return {chatFontSize,chatTypographyStyle};
}

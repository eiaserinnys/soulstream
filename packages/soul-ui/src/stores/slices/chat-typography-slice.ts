import type { StateCreator } from "zustand";
import {
  DEFAULT_CHAT_FONT_SIZE,
  normalizeChatFontSize,
  type ChatFontSize,
} from "../../lib/chat-typography";
import type { DashboardActions, DashboardState } from "../dashboard-store-types";

export type ChatTypographySlice = Pick<DashboardState, "chatFontSize"> &
  Pick<DashboardActions, "setChatFontSize">;

export const createChatTypographySlice: StateCreator<
  DashboardState & DashboardActions,
  [],
  [],
  ChatTypographySlice
> = (set) => ({
  chatFontSize: DEFAULT_CHAT_FONT_SIZE,
  setChatFontSize: (fontSize: ChatFontSize | number) => {
    set({ chatFontSize: normalizeChatFontSize(fontSize) });
  },
});

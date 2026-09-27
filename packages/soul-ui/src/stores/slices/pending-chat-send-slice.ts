import type { StateCreator } from "zustand";
import type { DashboardActions, DashboardState, PendingChatSend } from "../dashboard-store-types";

export function getPendingChatSendInitialState(): Pick<DashboardState, "pendingChatSends"> {
  return { pendingChatSends: {} };
}

export type PendingChatSendSlice = Pick<DashboardState, "pendingChatSends"> &
  Pick<DashboardActions, "setPendingChatSend">;

export const createPendingChatSendSlice: StateCreator<
  DashboardState & DashboardActions,
  [],
  [],
  PendingChatSendSlice
> = (set) => ({
  ...getPendingChatSendInitialState(),

  setPendingChatSend: (sessionId, pending) =>
    set((state) => {
      const current = state.pendingChatSends[sessionId];
      if (pending === null) {
        if (!current) return state;
        const next = { ...state.pendingChatSends };
        delete next[sessionId];
        return { pendingChatSends: next };
      }
      if (current === pending) return state;
      return {
        pendingChatSends: { ...state.pendingChatSends, [sessionId]: pending },
      };
    }),
});

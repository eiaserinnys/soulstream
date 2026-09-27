import type { PendingChatSend } from "../../stores/dashboard-store-types";

export type PendingChatSendActions = {
  retry: (sessionId: string, pending: PendingChatSend) => void;
  restore: (sessionId: string, pending: PendingChatSend) => void;
};

export function mergePendingTextIntoComposer(
  pendingText: string,
  currentText: string,
): string {
  return currentText.length > 0 ? `${pendingText}\n\n${currentText}` : pendingText;
}

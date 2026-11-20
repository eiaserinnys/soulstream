import type { PendingChatSend } from "../../stores/dashboard-store-types";

export type PendingChatSendActions = {
  retry: (sessionId: string, pending: PendingChatSend) => void;
  restore: (sessionId: string, pending: PendingChatSend) => void;
  /** 전달 장부에서 실패로 닫힌 말풍선의 글을 같은 세션으로 다시 보낸다 (카드 #1524). */
  retryDelivery: (
    sessionId: string,
    message: { text: string; attachmentPaths: readonly string[] },
  ) => void;
  /** 그 말풍선의 글을 입력창으로 옮긴다. */
  restoreDelivery: (sessionId: string, text: string) => void;
};

export function mergePendingTextIntoComposer(
  pendingText: string,
  currentText: string,
): string {
  return currentText.length > 0 ? `${pendingText}\n\n${currentText}` : pendingText;
}

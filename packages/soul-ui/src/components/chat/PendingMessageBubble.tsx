import { memo } from "react";
import type { PendingChatSend } from "../../stores/dashboard-store-types";
import { Button } from "../ui/button";
import { MANUSCRIPT_USER_ROW_CLASS_NAME } from "./ChatManuscriptList";

export const PendingMessageBubble = memo(function PendingMessageBubble({
  sessionId,
  pending,
  presentation = "default",
  onRetry,
  onRestore,
}: {
  sessionId: string;
  pending: PendingChatSend;
  presentation?: "default" | "manuscript";
  onRetry: (sessionId: string, pending: PendingChatSend) => void;
  onRestore: (sessionId: string, pending: PendingChatSend) => void;
}) {
  const isSending = pending.status === "sending";
  const manuscript = presentation === "manuscript";

  return (
    <div
      className={manuscript ? MANUSCRIPT_USER_ROW_CLASS_NAME : "flex justify-end px-3 py-1.5"}
      data-chat-manuscript-user-row={manuscript ? "true" : undefined}
      data-slot="chat-pending-message"
      data-chat-presentation={manuscript ? "manuscript" : undefined}
      data-status={pending.status}
    >
      <div
        className={manuscript ? `w-full min-w-0 max-w-full text-right text-muted-foreground ${isSending ? "opacity-55" : ""}` : `max-w-[86%] rounded-[17px] rounded-br-[7px] bg-gradient-to-b from-[#2E96FF] to-[#0A84FF] px-3.5 py-2.5 text-white shadow-[0_8px_22px_-10px_rgb(10_132_255_/_55%)] ${isSending ? "opacity-55" : ""}`}
      >
          <div data-slot={manuscript ? "chat-body" : undefined} className={manuscript ? "whitespace-pre-wrap text-base text-muted-foreground [line-height:1.6] [word-break:keep-all] [overflow-wrap:anywhere]" : "whitespace-pre-wrap break-words text-base leading-snug"}>
          {pending.messageText}
        </div>
        {isSending ? (
          <div className={manuscript ? "mt-1 text-right text-xs text-muted-foreground" : "mt-1 text-right text-xs text-white/75"} aria-live="polite">
            보내는 중
          </div>
        ) : (
          <>
            <div className={manuscript ? "mt-1 text-right text-xs text-destructive" : "mt-1 text-right text-xs text-white/90"} role="status">
              {pending.reason}
            </div>
            <div className="mt-2 flex justify-end gap-2">
              <Button
                size="sm"
                variant="glass"
                className={manuscript ? "text-foreground" : "border-white/30 text-white hover:bg-white/15 hover:text-white"}
                onClick={() => onRetry(sessionId, pending)}
              >
                다시 보내기
              </Button>
              <Button
                size="sm"
                variant="glass"
                className={manuscript ? "text-foreground" : "border-white/30 text-white hover:bg-white/15 hover:text-white"}
                onClick={() => onRestore(sessionId, pending)}
              >
                입력창으로
              </Button>
            </div>
          </>
        )}
      </div>
    </div>
  );
});

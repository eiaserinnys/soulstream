import { memo } from "react";
import type { PendingChatSend } from "../../stores/dashboard-store-types";
import { Button } from "../ui/button";

export const PendingMessageBubble = memo(function PendingMessageBubble({
  sessionId,
  pending,
  onRetry,
  onRestore,
}: {
  sessionId: string;
  pending: PendingChatSend;
  onRetry: (sessionId: string, pending: PendingChatSend) => void;
  onRestore: (sessionId: string, pending: PendingChatSend) => void;
}) {
  const isSending = pending.status === "sending";

  return (
    <div
      className="flex justify-end px-3 py-1.5"
      data-slot="chat-pending-message"
      data-status={pending.status}
    >
      <div
        className={`max-w-[86%] rounded-[17px] rounded-br-[7px] bg-gradient-to-b from-[#2E96FF] to-[#0A84FF] px-3.5 py-2.5 text-white shadow-[0_8px_22px_-10px_rgb(10_132_255_/_55%)] ${isSending ? "opacity-55" : ""}`}
      >
        <div className="whitespace-pre-wrap break-words text-base leading-snug">
          {pending.messageText}
        </div>
        {isSending ? (
          <div className="mt-1 text-right text-xs text-white/75" aria-live="polite">
            보내는 중
          </div>
        ) : (
          <>
            <div className="mt-1 text-right text-xs text-white/90" role="status">
              {pending.reason}
            </div>
            <div className="mt-2 flex justify-end gap-2">
              <Button
                size="sm"
                variant="glass"
                className="border-white/30 text-white hover:bg-white/15 hover:text-white"
                onClick={() => onRetry(sessionId, pending)}
              >
                다시 보내기
              </Button>
              <Button
                size="sm"
                variant="glass"
                className="border-white/30 text-white hover:bg-white/15 hover:text-white"
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

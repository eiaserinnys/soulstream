import { useTranslation } from "react-i18next";
import { memo } from "react";
import type { PendingChatSend } from "../../stores/dashboard-store-types";
import { DeliveryFailureBlock } from "./DeliveryFailureBlock";
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
  const { t } = useTranslation();
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
        className={manuscript ? `w-full min-w-0 max-w-full text-right text-muted-foreground ${isSending ? "opacity-55" : ""}` : `max-w-[86%] rounded-floor bg-gradient-to-b from-[#2E96FF] to-[#0A84FF] px-3.5 py-2.5 text-white shadow-[0_8px_22px_-10px_rgb(10_132_255_/_55%)] ${isSending ? "opacity-55" : ""}`}
      >
          <div data-slot={manuscript ? "chat-body" : undefined} className={manuscript ? "whitespace-pre-wrap text-base text-muted-foreground [line-height:1.6] [word-break:keep-all] [overflow-wrap:anywhere]" : "whitespace-pre-wrap break-words text-base leading-snug"}>
          {pending.text || pending.attachments.map(attachment => attachment.file.name).join("\n")}
        </div>
        {isSending ? (
          <div className={manuscript ? "mt-1 text-right text-xs text-muted-foreground" : "mt-1 text-right text-xs text-white/75"} aria-live="polite">
            {t("ui.chat.sending")}
          </div>
        ) : (
          <DeliveryFailureBlock
            text={pending.reason}
            manuscript={manuscript}
            onRetry={() => onRetry(sessionId, pending)}
            onRestore={() => onRestore(sessionId, pending)}
          />
        )}
      </div>
    </div>
  );
});

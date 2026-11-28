import { useTranslation } from "react-i18next";
import { memo } from "react";
import { Button } from "../ui/button";

export type DeliveryFailureActions = {
  onRetry?: () => void;
  onRestore?: () => void;
};

/**
 * 전달 실패 표시 — 실패 줄과 두 단추.
 *
 * PendingMessageBubble의 기존 실패 표면(클래스·치수 그대로)을 말풍선들이 함께
 * 쓰도록 뺀 것이다(카드 #1524). 새 클래스·색·치수를 더하지 않는다.
 * 다시 보내기가 불가능한 경우(첨부 경로를 얻지 못함)에는 복원 단추만 남는다.
 */
export const DeliveryFailureBlock = memo(function DeliveryFailureBlock({
  text,
  manuscript = false,
  onRetry,
  onRestore,
}: {
  text?: string;
  manuscript?: boolean;
  onRetry?: () => void;
  onRestore?: () => void;
}) {
  const { t } = useTranslation();
  if (!onRetry && !onRestore) return null;
  const buttonClassName = manuscript
    ? "text-foreground"
    : "border-white/30 text-white hover:bg-white/15 hover:text-white";
  return (
    <>
      <div
        className={manuscript ? "mt-1 text-right text-xs text-destructive" : "mt-1 text-right text-xs text-white/90"}
        role="status"
      >
        {text ?? t("ui.chat.deliveryUnconfirmed")}
      </div>
      <div className="mt-2 flex justify-end gap-2">
        {onRetry && (
          <Button size="sm" variant="glass" className={buttonClassName} onClick={onRetry}>
            {t("ui.chat.resend")}
          </Button>
        )}
        {onRestore && (
          <Button size="sm" variant="glass" className={buttonClassName} onClick={onRestore}>
            {t("ui.chat.restoreInput")}
          </Button>
        )}
      </div>
    </>
  );
});

import { useTranslation } from "react-i18next";
import { Trash2 } from "lucide-react";
import { Dialog, DialogPopup, DialogHeader, DialogTitle, DialogPanel, DialogFooter } from "./ui/dialog";
import { Button } from "./ui/button";
export function SessionContinueErrorDialog({ error, onClose }: { error: string | null; onClose(): void }) {
  const { t } = useTranslation();
  const showDetails = Boolean(error?.trim() && error !== "세션을 이어서 시작하지 못했습니다."); // i18n-ignore: 서버 오류 원문과 비교해 중복 상세 표시를 막음
  return (
    <Dialog
      open={error !== null}
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <DialogPopup className="approved-dialog max-w-sm">
        <DialogHeader>
          <DialogTitle>{t("ui.session.continueErrorTitle")}</DialogTitle>
        </DialogHeader>
        <DialogPanel>
          <div className="dialog-error-notice" role="alert">
            <p data-slot="dialog-error-message">{t("ui.session.continueError")}</p>
            <p>{t("ui.session.continueErrorHelp")}</p>
            {showDetails ? <details><summary>{t("ui.common.technicalDetails")}</summary><pre data-slot="dialog-error-detail">{error}</pre></details> : null}
          </div>
        </DialogPanel>
        <DialogFooter variant="bare">
          <Button type="button" onClick={onClose}>
            {t("ui.common.confirm")}
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}
export function SessionDeleteDialog({
  open,
  count,
  onOpenChange,
  onConfirm,
}: {
  open: boolean;
  count: number;
  onOpenChange(open: boolean): void;
  onConfirm(): void;
}) {
  const { t } = useTranslation();
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogPopup className="approved-dialog max-w-sm">
        <DialogHeader>
          <div className="dialog-confirm-icon"><Trash2 className="size-5" aria-hidden="true"/></div>
          <DialogTitle>{t("ui.session.deleteTitle")}</DialogTitle>
        </DialogHeader>
        <DialogPanel>
          <div className="dialog-confirm-summary"><strong>{t("ui.session.selectedCount", { total: count })}</strong><span>{t("ui.session.deleteWarning")}</span></div>
        </DialogPanel>
        <DialogFooter variant="bare">
          <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
            {t("ui.common.cancel")}
          </Button>
          <Button type="button" variant="destructive" onClick={onConfirm}>
            {t("ui.session.delete")}
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}

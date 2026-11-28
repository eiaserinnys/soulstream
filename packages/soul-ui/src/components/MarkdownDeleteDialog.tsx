import { useTranslation } from "react-i18next";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "./ui/dialog";
import { Button } from "./ui/button";

export interface MarkdownDeleteDialogProps {
  open: boolean;
  title: string;
  pending?: boolean;
  error?: string | null;
  onOpenChange(open: boolean): void;
  onConfirm(): void;
}

export function MarkdownDeleteDialog({
  open,
  title,
  pending = false,
  error,
  onOpenChange,
  onConfirm,
}: MarkdownDeleteDialogProps) {
  const { t } = useTranslation();
  const visibleTitle = title.trim() || t("ui.markdown.untitled");
  return (
    <Dialog
      open={open}
      onOpenChange={(nextOpen) => {
        if (!pending) onOpenChange(nextOpen);
      }}
    >
      <DialogPopup className="max-w-sm">
        <DialogHeader>
          <DialogTitle>{t("ui.markdown.deleteTitle")}</DialogTitle>
          <DialogDescription>
            {t("ui.markdown.deleteDescription", { title: visibleTitle })}
          </DialogDescription>
        </DialogHeader>
        {error ? (
          <DialogPanel>
            <p className="text-sm text-destructive" role="alert" data-slot="dialog-error-message">{error}</p>
          </DialogPanel>
        ) : null}
        <DialogFooter variant="bare">
          <Button type="button" variant="outline" disabled={pending} onClick={() => onOpenChange(false)}>
            {t("ui.common.cancel")}
          </Button>
          <Button type="button" variant="destructive" disabled={pending} onClick={onConfirm}>
            {pending ? t("ui.markdown.deleting") : t("ui.common.delete")}
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}

import { useTranslation } from "react-i18next";
import {
  Button,
  Dialog,
  DialogPopup,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@seosoyoung/soul-ui";
export function FolderDetailArchiveDialog({
  open,
  onOpenChange,
  title,
  error,
  onArchive,
}: {
  open: boolean;
  onOpenChange(open: boolean): void;
  title: string;
  error: string | null;
  onArchive(): void;
}) {
  const { t } = useTranslation();
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogPopup className="approved-dialog max-w-sm">
        <DialogHeader>
          <DialogTitle>{t("folders.archive.title")}</DialogTitle>
          <DialogDescription>{t("folders.archive.description", { name: title })}</DialogDescription>
        </DialogHeader>
        {error ? <p role="alert" data-v3-selectable-content="true">{t("folders.archive.error", { detail: error })}</p> : null}
        <DialogFooter variant="bare">
          <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
            {t("folders.common.cancel")}
          </Button>
          <Button type="button" variant="default" onClick={onArchive}>
            {t("folders.archive.action")}
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}

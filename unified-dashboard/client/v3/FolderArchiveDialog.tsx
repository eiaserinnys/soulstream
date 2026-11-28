import { useTranslation } from "react-i18next";
import {
  Button, Dialog, DialogDescription, DialogFooter, DialogHeader, DialogPopup, DialogTitle,
  type CatalogFolder,
} from "@seosoyoung/soul-ui";

export function FolderArchiveDialog({ folder, onClose, onArchive }: {
  folder: CatalogFolder | null;
  onClose(): void;
  onArchive(folder: CatalogFolder): void;
}) {
  const { t } = useTranslation();
  return <Dialog open={folder !== null} onOpenChange={(open) => { if (!open) onClose(); }}>
    <DialogPopup className="approved-dialog max-w-sm">
      <DialogHeader>
        <DialogTitle>{t("folders.archive.title")}</DialogTitle>
        <DialogDescription>{t("folders.archive.description", { name: folder?.name ?? "" })}</DialogDescription>
      </DialogHeader>
      <DialogFooter variant="bare">
        <Button type="button" variant="outline" onClick={onClose}>{t("folders.common.cancel")}</Button>
        <Button type="button" variant="default" onClick={() => {
          if (folder) onArchive(folder);
        }}>{t("folders.archive.action")}</Button>
      </DialogFooter>
    </DialogPopup>
  </Dialog>;
}

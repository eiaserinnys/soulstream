import { folderErrorText } from "./folder-messages";
import { useTranslation } from "react-i18next";
import { useEffect, useMemo, useState } from "react";
import { Button, Dialog, DialogFooter, DialogHeader, DialogDescription, DialogPanel, DialogPopup, DialogTitle, FrameLoading, useDashboardStore } from "@seosoyoung/soul-ui";
import type { PageApiClient } from "@seosoyoung/soul-ui/page";
import type { FolderMoveTarget } from "./folder-move-targets";
import { FolderPicker } from "./FolderPicker";
import { useFolderPickerStars } from "./use-folder-picker-stars";

export function FolderMoveDialog({
  starredFolderIds, sampleFolders, api, currentFolderId, defaultTargets, open, onClose, onMove,
}: {
  sampleFolders?: readonly import("@seosoyoung/soul-ui").CatalogFolder[];
  starredFolderIds?: readonly string[];
  api: PageApiClient;
  currentFolderId: string;
  defaultTargets: readonly FolderMoveTarget[];
  open: boolean;
  onClose(): void;
  onMove(target: FolderMoveTarget): Promise<void>;
}) {
  const { t } = useTranslation();
  const [selectedFolderId, setSelectedFolderId] = useState<string | null>(null);
  const [movePending, setMovePending] = useState(false);
  const [moveError, setMoveError] = useState<string | null>(null);
  const folders = useDashboardStore((state) => state.catalog?.folders);
  const pickerFolders = useMemo(() => sampleFolders ?? folders ?? [], [folders, sampleFolders]);
  const stars = useFolderPickerStars(open, pickerFolders, starredFolderIds);
  const disabledFolderIds = useMemo(() => new Set(pickerFolders
    .filter((folder) => folder.id === currentFolderId || !folder.projectPageId)
    .map((folder) => folder.id)), [currentFolderId, pickerFolders]);
  useEffect(() => { setSelectedFolderId(null); setMoveError(null); }, [open]);

  const close = () => { if (!movePending) onClose(); };
  const move = async () => {
    if (movePending || !selectedFolderId || disabledFolderIds.has(selectedFolderId)) return;
    const folder = pickerFolders.find((folder) => folder.id === selectedFolderId);
    if (!folder?.projectPageId) return;
    setMovePending(true);
    setMoveError(null);
    try {
      const target = defaultTargets.find((target) => target.folderId === selectedFolderId)
        ?? { folderId: selectedFolderId, page: (await api.getPage(folder.projectPageId)).page };
      await onMove(target);
      onClose();
    } catch (error) {
      setMoveError(folderErrorText(t, error));
    } finally { setMovePending(false); }
  };

  return (
    <Dialog open={open} onOpenChange={(nextOpen) => { if (!nextOpen) close(); }}>
      <DialogPopup className="approved-dialog max-w-md">
        <DialogHeader><DialogTitle>{t("folders.move.toOther")}</DialogTitle><DialogDescription>{t("folders.move.instructions")}</DialogDescription></DialogHeader>
        <DialogPanel>
          <div className="dialog-selection-context">{t("folders.move.currentLocation")} <strong>{pickerFolders.find(folder => folder.id === currentFolderId)?.name ?? t("folders.move.currentFolder")}</strong></div>
          <div data-testid="v3-run-move-targets">
            {stars.loading ? <FrameLoading inline label={t("folders.move.loading")} /> : open ? <FolderPicker
              folders={pickerFolders} starredFolderIds={stars.folderIds} disabledFolderIds={disabledFolderIds}
              selectedFolderId={selectedFolderId} pending={movePending} onSelect={(folder) => setSelectedFolderId(folder.id)} /> : null}
          </div>
          {stars.error ? <p className="v3-load-error" role="alert" data-v3-selectable-content="true">{t("folders.move.starError", { detail: stars.error })}</p> : null}
          {moveError ? <p className="v3-load-error" role="alert" data-v3-selectable-content="true">{moveError}</p> : null}
        </DialogPanel>
        <DialogFooter>
          <p className="dialog-selection-destination">{selectedFolderId ? t("folders.move.destination", { name: pickerFolders.find(folder => folder.id === selectedFolderId)?.name }) : t("folders.move.selectFolder")}</p>
          <Button variant="ghost" disabled={movePending} onClick={close}>{t("folders.common.cancel")}</Button>
          <Button disabled={movePending || !selectedFolderId || disabledFolderIds.has(selectedFolderId)} onClick={() => { void move(); }}>{t("folders.common.move")}</Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}

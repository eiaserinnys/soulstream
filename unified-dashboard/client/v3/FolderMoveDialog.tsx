import { useEffect, useMemo, useState } from "react";
import { Button, Dialog, DialogFooter, DialogHeader, DialogPanel, DialogPopup, DialogTitle, useDashboardStore } from "@seosoyoung/soul-ui";
import type { PageApiClient } from "@seosoyoung/soul-ui/page";
import type { FolderMoveTarget } from "./folder-move-targets";
import { FolderPicker } from "./FolderPicker";
import { useFolderPickerStars } from "./use-folder-picker-stars";

export function FolderMoveDialog({
  api, currentFolderId, defaultTargets, open, onClose, onMove,
}: {
  api: PageApiClient;
  currentFolderId: string;
  defaultTargets: readonly FolderMoveTarget[];
  open: boolean;
  onClose(): void;
  onMove(target: FolderMoveTarget): Promise<void>;
}) {
  const [selectedFolderId, setSelectedFolderId] = useState<string | null>(null);
  const [movePending, setMovePending] = useState(false);
  const [moveError, setMoveError] = useState<string | null>(null);
  const folders = useDashboardStore((state) => state.catalog?.folders);
  const pickerFolders = useMemo(() => folders ?? [], [folders]);
  const stars = useFolderPickerStars(open, pickerFolders);
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
      setMoveError(error instanceof Error ? error.message : String(error));
    } finally { setMovePending(false); }
  };

  return (
    <Dialog open={open} onOpenChange={(nextOpen) => { if (!nextOpen) close(); }}>
      <DialogPopup className="max-w-md">
        <DialogHeader><DialogTitle>다른 폴더로 이동</DialogTitle></DialogHeader>
        <DialogPanel>
          <div data-testid="v3-run-move-targets">
            {stars.loading ? <p>폴더를 불러오는 중…</p> : open ? <FolderPicker
              folders={pickerFolders} starredFolderIds={stars.folderIds} disabledFolderIds={disabledFolderIds}
              selectedFolderId={selectedFolderId} pending={movePending} onSelect={(folder) => setSelectedFolderId(folder.id)} /> : null}
          </div>
          {stars.error ? <p className="v3-load-error" role="alert">별표 조회 실패 · {stars.error}</p> : null}
          {moveError ? <p className="v3-load-error" role="alert">{moveError}</p> : null}
        </DialogPanel>
        <DialogFooter>
          <Button variant="ghost" disabled={movePending} onClick={close}>취소</Button>
          <Button disabled={movePending || !selectedFolderId || disabledFolderIds.has(selectedFolderId)} onClick={() => { void move(); }}>이동</Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}

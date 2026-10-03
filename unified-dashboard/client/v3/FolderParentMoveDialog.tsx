import { useEffect, useMemo, useState } from "react";
import {
  Button, Dialog, DialogFooter, DialogHeader, DialogPanel, DialogPopup, DialogTitle, type CatalogFolder,
} from "@seosoyoung/soul-ui";
import type { PlannerFolder } from "./planner-data";
import { folderParentOptions } from "./folder-parent-targets";
import { FolderPicker } from "./FolderPicker";
import { useFolderPickerStars } from "./use-folder-picker-stars";

export interface FolderParentMoveDialogProps {
  starredFolderIds?: readonly string[];
  task: PlannerFolder | null;
  currentFolderId: string | null;
  folders: readonly CatalogFolder[];
  pending: boolean;
  error: string | null;
  onMove(target: { folderId: string }): void;
  onClose(): void;
}

export function FolderParentMoveDialog({ starredFolderIds, task, currentFolderId, folders, pending, error, onMove, onClose }: FolderParentMoveDialogProps) {
  const [selectedFolderId, setSelectedFolderId] = useState<string | null>(null);
  const stars = useFolderPickerStars(task !== null, folders, starredFolderIds);
  const disabledFolderIds = useMemo(() => {
    // Child-card callers can carry a page identity; the catalog owns hierarchy IDs.
    const currentParentId = task
      ? folders.find((folder) => folder.id === task.folderId)?.parentFolderId ?? null
      : currentFolderId;
    const allowed = new Set(folderParentOptions(folders, currentParentId).map(({ folder }) => folder.id));
    const descendants = new Set<string>();
    const append = (id: string) => {
      descendants.add(id);
      for (const folder of folders) {
        if (folder.parentFolderId === id && !descendants.has(folder.id)) append(folder.id);
      }
    };
    if (task) append(task.folderId);
    return new Set(folders.filter((folder) => !allowed.has(folder.id) || descendants.has(folder.id)).map((folder) => folder.id));
  }, [currentFolderId, folders, task]);
  useEffect(() => { setSelectedFolderId(null); }, [task?.folderId]);

  return (
    <Dialog open={task !== null} onOpenChange={(open) => { if (!open && !pending) onClose(); }}>
      <DialogPopup className="approved-dialog v3-surface max-w-md">
        <DialogHeader><DialogTitle>폴더 이동</DialogTitle></DialogHeader>
        <DialogPanel>
          <div className="v3-form-context"><span>이동할 폴더</span><strong>{task?.page.title}</strong></div>
          <div data-testid="v3-folder-parent-targets">
            {stars.loading ? <p>폴더를 불러오는 중…</p> : task ? <FolderPicker key={task.folderId}
              folders={folders} starredFolderIds={stars.folderIds} disabledFolderIds={disabledFolderIds}
              selectedFolderId={selectedFolderId} pending={pending} onSelect={(folder) => setSelectedFolderId(folder.id)} /> : null}
          </div>
          {stars.error ? <p className="v3-load-error" role="alert">별표 조회 실패 · {stars.error}</p> : null}
          {error ? <p className="v3-load-error" role="alert">{error}</p> : null}
        </DialogPanel>
        <DialogFooter className="v3-choice-footer">
          <p className="v3-form-submit-note">{selectedFolderId ? `${folders.find(folder => folder.id === selectedFolderId)?.name ?? "선택한 폴더"} 안으로 이동` : "목적지를 선택하세요"}</p>
          <Button variant="ghost" disabled={pending} onClick={onClose}>취소</Button>
          <Button disabled={pending || !selectedFolderId || disabledFolderIds.has(selectedFolderId)}
            onClick={() => { if (selectedFolderId && !pending && !disabledFolderIds.has(selectedFolderId)) onMove({ folderId: selectedFolderId }); }}>{pending ? "이동 중…" : "폴더 이동"}</Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}

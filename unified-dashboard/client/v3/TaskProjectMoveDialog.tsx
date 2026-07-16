import { useMemo } from "react";
import {
  Button,
  Dialog,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
  type CatalogFolder,
} from "@seosoyoung/soul-ui";

import type { PlannerTask } from "./planner-data";
import { taskProjectFolderOptions } from "./task-project-targets";

export interface TaskProjectMoveDialogProps {
  task: PlannerTask | null;
  currentFolderId: string | null;
  folders: readonly CatalogFolder[];
  pending: boolean;
  error: string | null;
  onMove(target: { folderId: string; projectPageId: string }): void;
  onClose(): void;
}

export function TaskProjectMoveDialog({
  task,
  currentFolderId,
  folders,
  pending,
  error,
  onMove,
  onClose,
}: TaskProjectMoveDialogProps) {
  const options = useMemo(
    () => taskProjectFolderOptions(folders, currentFolderId),
    [currentFolderId, folders],
  );

  return (
    <Dialog open={task !== null} onOpenChange={(open) => { if (!open && !pending) onClose(); }}>
      <DialogPopup className="max-w-md">
        <DialogHeader><DialogTitle>다른 프로젝트로 이동</DialogTitle></DialogHeader>
        <DialogPanel>
          <div className="v3-context-picker v3-run-move-picker">
            <div className="v3-context-panel">
              <p>{task?.page.title ?? "업무"}의 새 프로젝트를 선택하세요.</p>
              <div className="v3-context-options" data-testid="v3-task-project-targets">
                {options.map(({ folder, depth }) => (
                  <button
                    type="button"
                    className="v3-context-option"
                    key={folder.id}
                    disabled={pending}
                    style={{ paddingInlineStart: `${12 + depth * 16}px` }}
                    onClick={() => onMove({
                      folderId: folder.id,
                      projectPageId: folder.projectPageId!,
                    })}
                  >
                    <span className="v3-emoji" aria-hidden="true">↪</span>
                    <span><strong>{folder.name}</strong><small>프로젝트</small></span>
                  </button>
                ))}
                {options.length === 0 ? <p>이동할 다른 프로젝트가 없습니다.</p> : null}
              </div>
            </div>
          </div>
          {error ? <p className="v3-load-error" role="alert">{error}</p> : null}
        </DialogPanel>
        <DialogFooter>
          <Button variant="ghost" disabled={pending} onClick={onClose}>취소</Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}

/**
 * FolderSettingsDialog - 폴더 설정 다이얼로그
 *
 * 폴더별 설정을 편집하는 다이얼로그.
 * 현재 지원하는 설정: 피드에서 제외 (excludeFromFeed)
 */

import { useState, useEffect } from "react";
import {
  Dialog,
  DialogPopup,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogPanel,
  DialogFooter,
} from "./ui/dialog";
import { Button } from "./ui/button";
import type { CatalogFolder, FolderSettings } from "../shared/types";

export interface FolderSettingsDialogProps {
  folder: CatalogFolder | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onConfirm: (settings: FolderSettings) => void;
}

export function FolderSettingsDialog({
  folder,
  open,
  onOpenChange,
  onConfirm,
}: FolderSettingsDialogProps) {
  const [excludeFromFeed, setExcludeFromFeed] = useState(false);

  useEffect(() => {
    if (open && folder) {
      setExcludeFromFeed(folder.settings?.excludeFromFeed ?? false);
    }
  }, [open, folder]);

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    onConfirm({ excludeFromFeed });
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogPopup className="max-w-sm">
        <DialogHeader>
          <DialogTitle>폴더 설정</DialogTitle>
          <DialogDescription>{folder?.name}</DialogDescription>
        </DialogHeader>
        <form onSubmit={handleSubmit}>
          <DialogPanel>
            <label className="flex items-center gap-2 cursor-pointer text-sm">
              <input
                type="checkbox"
                checked={excludeFromFeed}
                onChange={(e) => setExcludeFromFeed(e.target.checked)}
                className="h-4 w-4"
              />
              피드에서 제외
            </label>
          </DialogPanel>
          <DialogFooter variant="bare">
            <Button
              type="button"
              variant="outline"
              onClick={() => onOpenChange(false)}
            >
              취소
            </Button>
            <Button type="submit">저장</Button>
          </DialogFooter>
        </form>
      </DialogPopup>
    </Dialog>
  );
}

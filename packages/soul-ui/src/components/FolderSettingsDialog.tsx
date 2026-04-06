/**
 * FolderSettingsDialog - 폴더 설정 다이얼로그
 *
 * 폴더별 설정을 편집하는 다이얼로그.
 * 지원하는 설정: 피드에서 제외 (excludeFromFeed), 폴더 프롬프트 (folderPrompt)
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
import { useServerStatus } from "../hooks/useServerStatus";
import type { AtomContextNodeSettings, CatalogFolder, FolderSettings } from "../shared/types";

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
  const [folderPrompt, setFolderPrompt] = useState("");

  const { atomEnabled } = useServerStatus();
  const [atomNodeId, setAtomNodeId] = useState("");
  const [atomDepth, setAtomDepth] = useState(3);
  const [atomTitlesOnly, setAtomTitlesOnly] = useState(false);

  useEffect(() => {
    if (open && folder) {
      setExcludeFromFeed(folder.settings?.excludeFromFeed ?? false);
      setFolderPrompt(folder.settings?.folderPrompt ?? "");
      setAtomNodeId(folder.settings?.atomContextNode?.nodeId ?? "");
      setAtomDepth(folder.settings?.atomContextNode?.depth ?? 3);
      setAtomTitlesOnly(folder.settings?.atomContextNode?.titlesOnly ?? false);
    }
  }, [open, folder]);

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    const atomContextNode: AtomContextNodeSettings | undefined =
      atomNodeId.trim()
        ? { nodeId: atomNodeId.trim(), depth: atomDepth, titlesOnly: atomTitlesOnly }
        : undefined;
    onConfirm({
      excludeFromFeed,
      folderPrompt: folderPrompt || undefined,
      atomContextNode,
    });
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogPopup className="max-w-md">
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
            <div className="mt-3 flex flex-col gap-1">
              <label className="text-sm text-[--color-text-secondary]">
                폴더 프롬프트
              </label>
              <textarea
                value={folderPrompt}
                onChange={(e) => setFolderPrompt(e.target.value)}
                placeholder="새 세션 시작 시 Claude에게 전달할 지시사항을 입력하세요"
                rows={4}
                className="w-full rounded border border-[--color-border] bg-[--color-surface-1] px-2 py-1 text-sm resize-none"
              />
            </div>
            {atomEnabled && (
              <div className="mt-4 flex flex-col gap-2 border-t border-[--color-border] pt-4">
                <p className="text-sm font-medium">atom 트리 주입</p>
                <p className="text-xs text-[--color-text-secondary]">
                  세션 시작 시 지정한 atom 노드의 서브트리가 컨텍스트로 주입됩니다.
                </p>
                <div className="flex flex-col gap-1">
                  <label className="text-xs text-[--color-text-secondary]">노드 ID</label>
                  <input
                    type="text"
                    value={atomNodeId}
                    onChange={(e) => setAtomNodeId(e.target.value)}
                    placeholder="예: d71af4b5-c53a-49a4-9e07-9b6ee531fb56"
                    className="w-full rounded border border-[--color-border] bg-[--color-surface-1] px-2 py-1 text-sm font-mono"
                  />
                </div>
                <div className="flex flex-col gap-1">
                  <label className="text-xs text-[--color-text-secondary]">
                    깊이: {atomDepth}
                  </label>
                  <input
                    type="range"
                    min={1}
                    max={5}
                    value={atomDepth}
                    onChange={(e) => setAtomDepth(parseInt(e.target.value))}
                    className="w-full"
                  />
                </div>
                <label className="flex items-center gap-2 cursor-pointer text-sm">
                  <input
                    type="checkbox"
                    checked={atomTitlesOnly}
                    onChange={(e) => setAtomTitlesOnly(e.target.checked)}
                    className="h-4 w-4"
                  />
                  제목만 가져오기
                </label>
              </div>
            )}
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

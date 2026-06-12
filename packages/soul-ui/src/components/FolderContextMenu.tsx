/**
 * FolderContextMenu — 폴더 우클릭 컨텍스트 메뉴
 *
 * 데스크탑: 마우스 위치에 fixed 팝업
 * 모바일: 중앙 다이얼로그(액션 시트 스타일)
 *
 * 메뉴 항목: 이름 변경 / 설정 / 삭제
 */

import { useIsMobile } from "../hooks/use-mobile";
import { isSystemFolderId } from "../shared/constants";
import { Dialog, DialogPopup } from "./ui/dialog";
import { createPortal } from "react-dom";

export interface FolderContextMenuTarget {
  x: number;
  y: number;
  folder: { id: string; name: string };
}

export interface FolderContextMenuProps {
  target: FolderContextMenuTarget | null;
  onClose: () => void;
  onRename: (folder: { id: string; name: string }) => void;
  onOpenSettings: (folder: { id: string; name: string }) => void;
  onDelete: (folder: { id: string; name: string }) => void;
}

export function FolderContextMenu({
  target,
  onClose,
  onRename,
  onOpenSettings,
  onDelete,
}: FolderContextMenuProps) {
  const isMobile = useIsMobile();
  if (!target) return null;

  const { folder } = target;
  const isSystemFolder = isSystemFolderId(folder.id);

  if (isMobile) {
    return (
      <Dialog open onOpenChange={(open) => { if (!open) onClose(); }}>
        <DialogPopup className="max-w-sm" showCloseButton={false}>
          <div className="py-2 px-2">
            {!isSystemFolder && (
              <>
                <button
                  className="w-full text-left px-3 py-2 text-sm hover:bg-accent rounded-md"
                  onClick={() => { onRename(folder); onClose(); }}
                >
                  이름 변경
                </button>
                <div className="border-t border-border my-1" />
              </>
            )}
            <button
              className="w-full text-left px-3 py-2 text-sm hover:bg-accent rounded-md"
              onClick={() => { onOpenSettings(folder); onClose(); }}
            >
              설정
            </button>
            {!isSystemFolder && (
              <>
                <div className="border-t border-border my-1" />
                <button
                  className="w-full text-left px-3 py-2 text-sm hover:bg-accent rounded-md text-destructive"
                  onClick={() => { onDelete(folder); onClose(); }}
                >
                  삭제
                </button>
              </>
            )}
          </div>
        </DialogPopup>
      </Dialog>
    );
  }

  if (typeof document === "undefined") return null;

  return createPortal(
    <div
      className="fixed z-50 min-w-[140px] rounded-md border border-glass-border glass-strong glass-shadow-md py-1"
      style={{ top: target.y, left: target.x }}
      onMouseLeave={onClose}
    >
      {!isSystemFolder && (
        <button
          className="w-full text-left px-3 py-1.5 text-sm hover:bg-accent/50"
          onClick={() => { onRename(folder); onClose(); }}
        >
          이름 변경
        </button>
      )}
      <button
        className="w-full text-left px-3 py-1.5 text-sm hover:bg-accent/50"
        onClick={() => { onOpenSettings(folder); onClose(); }}
      >
        설정
      </button>
      {!isSystemFolder && (
        <button
          className="w-full text-left px-3 py-1.5 text-sm hover:bg-accent/50 text-destructive"
          onClick={() => { onDelete(folder); onClose(); }}
        >
          삭제
        </button>
      )}
    </div>,
    document.body,
  );
}

/**
 * FolderStack - 모바일 폴더 탭의 2단계 네비게이션 (폴더 목록 ↔ 폴더 내용) 슬라이드 전환.
 *
 * 구조: 외곽 overflow-hidden + 트랙(width 200%) + 좌/우 패널(width 50%).
 * selectedFolderId가 truthy이면 트랙이 -50% translateX로 슬라이드하여 우측 패널이 노출된다.
 *
 * 뒤로가기 중 우측 패널이 빈 화면이 되지 않도록 `lastFolderIdRef`로 마지막 유효 folder id를 캐싱한다.
 * 전환 후에도 DOM은 유지되나 overflow-hidden + translateX(0)으로 화면 밖에 존재한다.
 *
 * prefers-reduced-motion: reduce 모드에서는 globals.css의 @media 블록이 transition을 제거하므로
 * 즉시 최종 상태로 전환된다.
 */

import { useRef, type ReactNode } from "react";
import { ChevronLeft, Plus } from "lucide-react";
import { cn } from "../../lib/cn";

export interface FolderStackProps {
  selectedFolderId: string | null;
  leftPanelContent: ReactNode;
  mobileFolderContents: ReactNode;
  folderName: string;
  onBack: () => void;
  onNewSession?: () => void;
}

export function FolderStack({
  selectedFolderId,
  leftPanelContent,
  mobileFolderContents,
  folderName,
  onBack,
  onNewSession,
}: FolderStackProps) {
  const lastFolderIdRef = useRef<string | null>(null);
  if (selectedFolderId) {
    lastFolderIdRef.current = selectedFolderId;
  }
  // 뒤로가기 애니메이션 중에도 직전 폴더 내용을 유지한다.
  const displayFolderId = selectedFolderId ?? lastFolderIdRef.current;

  return (
    <div className="relative overflow-hidden w-full h-full">
      <div
        className={cn("folder-stack", selectedFolderId && "show-content")}
      >
        {/* 좌측 패널 — 폴더 목록 */}
        <div className="folder-panel">
          {leftPanelContent}
        </div>
        {/* 우측 패널 — 선택된 폴더 내용. displayFolderId로 렌더하여 뒤로가기 슬라이드 중 빈 화면 방지. */}
        <div className="folder-panel">
          {displayFolderId ? (
            <div className="flex flex-col h-full">
              <div className="flex items-center gap-2 px-3 py-2 border-b shrink-0">
                <button
                  onClick={onBack}
                  className="p-1 rounded hover:bg-muted"
                  aria-label="폴더 목록으로 돌아가기"
                >
                  <ChevronLeft className="h-5 w-5" />
                </button>
                <span className="text-sm font-medium flex-1">
                  {folderName}
                </span>
                {onNewSession && (
                  <button
                    onClick={onNewSession}
                    className="p-1 rounded hover:bg-muted"
                    title="New session"
                    data-testid="mobile-new-session-btn"
                  >
                    <Plus className="h-4 w-4" />
                  </button>
                )}
              </div>
              <div className="flex-1 min-h-0 overflow-hidden">
                {mobileFolderContents}
              </div>
            </div>
          ) : null}
        </div>
      </div>
    </div>
  );
}

/**
 * SessionContextMenu - 세션 우클릭 컨텍스트 메뉴 공통 컴포넌트
 *
 * FeedView, FolderContents 등에서 세션 우클릭 시 동일한 메뉴와 모달을 제공한다.
 * 세션 ID 복사 · 이름 변경 · 폴더 이동 기능을 제공한다.
 *
 * 모바일: Dialog 하단 시트 (bottomStickOnMobile)
 * 데스크탑: base-ui Menu 프리미티브 (VirtualElement anchor + scale/opacity 진입·퇴장 전환)
 */

import { useState, useCallback, useMemo } from "react";
import { useDashboardStore } from "../stores/dashboard-store";
import { useIsMobile } from "../hooks/use-mobile";
import { Dialog, DialogPopup, DialogHeader, DialogTitle, DialogPanel, DialogFooter } from "./ui/dialog";
import { Menu, MenuPopup, MenuItem, MenuSeparator } from "./ui/menu";
import { Button } from "./ui/button";
import { Input } from "./ui/input";
import { cn } from "../lib/cn";

export interface SessionContextMenuState {
  x: number;
  y: number;
  sessionId: string;
}

export interface SessionContextMenuProps {
  /** 현재 열린 컨텍스트 메뉴 위치/대상. null이면 닫힘 */
  contextMenu: SessionContextMenuState | null;
  /** 메뉴 닫기 콜백 */
  onClose: () => void;
  /** 세션 이름 변경 콜백. 미지정 시 이름 변경 메뉴 비활성화 */
  onRenameSession?: (sessionId: string, displayName: string | null) => Promise<void>;
  /** 세션 폴더 이동 콜백. 미지정 시 폴더 이동 메뉴 비활성화 */
  onMoveSessions?: (sessionIds: string[], targetFolderId: string | null) => Promise<void>;
  /** 세션의 현재 표시 이름 조회 (이름 변경 모달 초기값용) */
  getSessionName: (sessionId: string) => string;
  /**
   * 이동할 세션 ID 목록 결정 (단일/다중 선택 지원)
   * - FeedView: (id) => [id]
   * - FolderContents: (id) => selectedIds.has(id) ? [...selectedIds] : [id]
   */
  resolveSessionIds: (sessionId: string) => string[];
}

/** 메뉴 항목 리스트 (모바일/데스크탑 공용) */
function MenuItems({
  onCopyId,
  onRename,
  onMove,
  hasRename,
  hasMove,
  className,
}: {
  onCopyId: () => void;
  onRename?: () => void;
  onMove?: () => void;
  hasRename: boolean;
  hasMove: boolean;
  className?: string;
}) {
  return (
    <div className={className}>
      <button
        className="w-full text-left px-3 py-2 text-sm hover:bg-accent rounded-md"
        onClick={onCopyId}
      >
        세션 ID 복사
      </button>
      {hasRename && onRename && (
        <>
          <div className="border-t border-border my-1" />
          <button
            className="w-full text-left px-3 py-2 text-sm hover:bg-accent rounded-md"
            onClick={onRename}
          >
            이름 변경
          </button>
        </>
      )}
      {hasMove && onMove && (
        <>
          <div className="border-t border-border my-1" />
          <button
            className="w-full text-left px-3 py-2 text-sm hover:bg-accent rounded-md"
            onClick={onMove}
          >
            다른 폴더로 이동
          </button>
        </>
      )}
    </div>
  );
}

export function SessionContextMenu({
  contextMenu,
  onClose,
  onRenameSession,
  onMoveSessions,
  getSessionName,
  resolveSessionIds,
}: SessionContextMenuProps) {
  const catalog = useDashboardStore((s) => s.catalog);
  const isMobile = useIsMobile();

  // 데스크톱 컨텍스트 메뉴: 마우스 좌표를 VirtualElement anchor로 변환
  const desktopAnchor = useMemo(() => {
    if (!contextMenu || isMobile) return null;
    const { x, y } = contextMenu;
    return {
      getBoundingClientRect: () => ({
        x, y, width: 0, height: 0,
        top: y, left: x, right: x, bottom: y,
        toJSON: () => ({}),
      }),
    };
  }, [contextMenu, isMobile]);

  // 이름 변경 모달
  const [renameDialog, setRenameDialog] = useState<{
    open: boolean;
    sessionId: string;
  }>({ open: false, sessionId: "" });
  const [renameInput, setRenameInput] = useState("");

  // 폴더 이동 모달
  const [moveFolderDialog, setMoveFolderDialog] = useState<{
    open: boolean;
    sessionIds: string[];
    selectedFolderId: string | null;
  }>({ open: false, sessionIds: [], selectedFolderId: null });

  const handleCopyId = useCallback(() => {
    if (!contextMenu) return;
    navigator.clipboard.writeText(contextMenu.sessionId);
    onClose();
  }, [contextMenu, onClose]);

  const handleRenameClick = useCallback(() => {
    if (!contextMenu || !onRenameSession) return;
    const { sessionId } = contextMenu;
    onClose();
    setRenameInput(getSessionName(sessionId));
    setRenameDialog({ open: true, sessionId });
  }, [contextMenu, onRenameSession, onClose, getSessionName]);

  const handleRenameSubmit = useCallback(async () => {
    if (!onRenameSession) return;
    const { sessionId } = renameDialog;
    setRenameDialog((d) => ({ ...d, open: false }));
    await onRenameSession(sessionId, renameInput.trim() || null);
  }, [onRenameSession, renameDialog, renameInput]);

  const handleMoveClick = useCallback(() => {
    if (!contextMenu || !onMoveSessions) return;
    const sessionIds = resolveSessionIds(contextMenu.sessionId);
    onClose();
    setMoveFolderDialog({ open: true, sessionIds, selectedFolderId: null });
  }, [contextMenu, onMoveSessions, onClose, resolveSessionIds]);

  const handleMoveFolderSubmit = useCallback(async () => {
    if (!onMoveSessions) return;
    const { sessionIds, selectedFolderId } = moveFolderDialog;
    setMoveFolderDialog((d) => ({ ...d, open: false }));
    await onMoveSessions(sessionIds, selectedFolderId);
  }, [onMoveSessions, moveFolderDialog]);

  return (
    <>
      {/* 컨텍스트 메뉴 — 모바일: Dialog 하단 시트, 데스크탑: base-ui Menu */}
      {isMobile ? (
        <Dialog open={contextMenu !== null} onOpenChange={(open) => { if (!open) onClose(); }}>
          <DialogPopup className="max-w-sm" showCloseButton={false}>
            <div className="py-2 px-2">
              <MenuItems
                onCopyId={handleCopyId}
                onRename={onRenameSession ? handleRenameClick : undefined}
                onMove={onMoveSessions ? handleMoveClick : undefined}
                hasRename={!!onRenameSession}
                hasMove={!!onMoveSessions}
              />
            </div>
          </DialogPopup>
        </Dialog>
      ) : (
        <Menu
          open={contextMenu !== null}
          onOpenChange={(open) => { if (!open) onClose(); }}
          modal={false}
        >
          <MenuPopup
            anchor={desktopAnchor}
            side="bottom"
            align="start"
            sideOffset={4}
            className={cn(
              "transition-[opacity,scale] duration-150 ease-out",
              "data-[starting-style]:scale-95 data-[starting-style]:opacity-0",
              "data-[ending-style]:scale-95 data-[ending-style]:opacity-0",
              "motion-reduce:transition-none",
              "motion-reduce:data-[starting-style]:scale-100 motion-reduce:data-[starting-style]:opacity-100",
              "motion-reduce:data-[ending-style]:scale-100 motion-reduce:data-[ending-style]:opacity-100",
            )}
          >
            <MenuItem onClick={handleCopyId}>세션 ID 복사</MenuItem>
            {!!onRenameSession && (
              <>
                <MenuSeparator />
                <MenuItem onClick={handleRenameClick}>이름 변경</MenuItem>
              </>
            )}
            {!!onMoveSessions && (
              <>
                <MenuSeparator />
                <MenuItem onClick={handleMoveClick}>다른 폴더로 이동</MenuItem>
              </>
            )}
          </MenuPopup>
        </Menu>
      )}

      {/* 이름 변경 모달 */}
      {onRenameSession && (
        <Dialog
          open={renameDialog.open}
          onOpenChange={(open) => setRenameDialog((d) => ({ ...d, open }))}
        >
          <DialogPopup className="max-w-sm">
            <DialogHeader>
              <DialogTitle>세션 이름 변경</DialogTitle>
            </DialogHeader>
            <form
              onSubmit={(e) => {
                e.preventDefault();
                handleRenameSubmit();
              }}
            >
              <DialogPanel>
                <Input
                  autoFocus
                  placeholder="세션 이름 (비워두면 기본 이름으로 초기화)"
                  value={renameInput}
                  onChange={(e) => setRenameInput(e.target.value)}
                />
              </DialogPanel>
              <DialogFooter variant="bare">
                <Button
                  type="button"
                  variant="outline"
                  onClick={() => setRenameDialog((d) => ({ ...d, open: false }))}
                >
                  취소
                </Button>
                <Button type="submit">변경</Button>
              </DialogFooter>
            </form>
          </DialogPopup>
        </Dialog>
      )}

      {/* 폴더 이동 모달 */}
      {onMoveSessions && (
        <Dialog
          open={moveFolderDialog.open}
          onOpenChange={(open) => setMoveFolderDialog((d) => ({ ...d, open }))}
        >
          <DialogPopup className="max-w-sm">
            <DialogHeader>
              <DialogTitle>폴더 이동</DialogTitle>
            </DialogHeader>
            <DialogPanel>
              <div className="flex flex-col gap-1">
                {catalog?.folders && catalog.folders.length > 0 ? (
                  catalog.folders.map((f) => (
                    <button
                      key={f.id}
                      type="button"
                      className={`w-full text-left px-3 py-2 text-sm rounded-md transition-colors ${
                        moveFolderDialog.selectedFolderId === f.id
                          ? "bg-primary text-primary-foreground"
                          : "hover:bg-accent"
                      }`}
                      onClick={() =>
                        setMoveFolderDialog((d) => ({ ...d, selectedFolderId: f.id }))
                      }
                    >
                      {f.name}
                    </button>
                  ))
                ) : (
                  <p className="text-sm text-muted-foreground py-2">
                    이동할 수 있는 폴더가 없습니다.
                  </p>
                )}
              </div>
            </DialogPanel>
            <DialogFooter variant="bare">
              <Button
                type="button"
                variant="outline"
                onClick={() => setMoveFolderDialog((d) => ({ ...d, open: false }))}
              >
                취소
              </Button>
              <Button
                type="button"
                disabled={moveFolderDialog.selectedFolderId === null}
                onClick={handleMoveFolderSubmit}
              >
                이동하기
              </Button>
            </DialogFooter>
          </DialogPopup>
        </Dialog>
      )}
    </>
  );
}

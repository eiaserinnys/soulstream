/**
 * SessionContextMenu - 세션 우클릭 컨텍스트 메뉴 공통 컴포넌트
 *
 * FeedView, FolderContents 등에서 세션 우클릭 시 동일한 메뉴와 모달을 제공한다.
 * 이름 변경 · 폴더 이동 기능을 Modal Dialog 방식으로 처리한다.
 */

import { useState, useCallback } from "react";
import { useDashboardStore } from "../stores/dashboard-store";
import { Dialog, DialogPopup, DialogHeader, DialogTitle, DialogPanel, DialogFooter } from "./ui/dialog";
import { Button } from "./ui/button";
import { Input } from "./ui/input";

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

export function SessionContextMenu({
  contextMenu,
  onClose,
  onRenameSession,
  onMoveSessions,
  getSessionName,
  resolveSessionIds,
}: SessionContextMenuProps) {
  const catalog = useDashboardStore((s) => s.catalog);

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

  if (!onRenameSession && !onMoveSessions) return null;

  return (
    <>
      {/* 컨텍스트 메뉴 닫기 오버레이 */}
      {contextMenu && (
        <div
          className="fixed inset-0 z-40"
          onClick={onClose}
          onContextMenu={(e) => { e.preventDefault(); onClose(); }}
        />
      )}

      {/* 컨텍스트 메뉴 */}
      {contextMenu && (
        <div
          className="fixed z-50 bg-popover border border-border rounded-md shadow-lg py-1 min-w-[160px]"
          style={{ left: contextMenu.x, top: contextMenu.y }}
          onClick={(e) => e.stopPropagation()}
        >
          {onRenameSession && (
            <button
              className="w-full text-left px-3 py-1.5 text-sm hover:bg-accent"
              onClick={handleRenameClick}
            >
              이름 변경
            </button>
          )}
          {onMoveSessions && (
            <>
              {onRenameSession && <div className="border-t border-border my-1" />}
              <button
                className="w-full text-left px-3 py-1.5 text-sm hover:bg-accent"
                onClick={handleMoveClick}
              >
                다른 폴더로 이동
              </button>
            </>
          )}
        </div>
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

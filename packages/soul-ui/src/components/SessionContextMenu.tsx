/**
 * SessionContextMenu - 세션 우클릭 컨텍스트 메뉴 공통 컴포넌트
 *
 * Session surfaces share the same context menu and dialogs.
 * 세션 ID 복사 · 이름 변경 · 폴더 이동 · 삭제 기능을 제공한다.
 *
 * 모바일: Dialog 하단 시트 (bottomStickOnMobile)
 * 데스크탑: base-ui Menu 프리미티브 (VirtualElement anchor + scale/opacity 진입·퇴장 전환)
 */
import { useState, useCallback, useEffect, useMemo } from "react";
import { useDashboardStore } from "../stores/dashboard-store";
import { useIsMobile } from "../hooks/use-mobile";
import { Dialog, DialogPopup, DialogHeader, DialogTitle, DialogPanel, DialogFooter } from "./ui/dialog";
import { Menu, MenuPopup, MenuItem, MenuSeparator } from "./ui/menu";
import { Button } from "./ui/button";
import { cn } from "../lib/cn";
import { RenameSessionDialog } from "./RenameSessionDialog";
import {
  deleteClaudeSchedule,
  getResumeAfterLimitEligibility,
  scheduleResumeAfterLimit,
  type ResumeAfterLimitEligibilityResponse,
} from "../lib/claude-runtime-actions";
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
  /** 세션 삭제 콜백. 미지정 시 삭제 메뉴 비활성화 */
  onDeleteSessions?: (sessionIds: string[]) => Promise<void>;
  /** 원본 세션의 맥락을 이어 받을 새 세션 생성 콜백 */
  onContinueSession?: (sessionId: string) => Promise<void>;
  /** 이어 시작 메뉴 비활성 사유. null이면 실행 가능 */
  getContinueSessionDisabledReason?: (sessionId: string) => string | null;
  /** 세션의 현재 표시 이름 조회 (이름 변경 모달 초기값용) */
  getSessionName: (sessionId: string) => string;
  /** 보드 전용 메뉴처럼 호출자가 추가하는 세션 액션 */
  extraActions?: SessionContextMenuExtraAction[];
  /**
   * 이동할 세션 ID 목록 결정 (단일/다중 선택 지원)
   * The caller decides whether the selected session expands to a multi-selection.
   */
  resolveSessionIds: (sessionId: string) => string[];
}
export interface SessionContextMenuExtraAction {
  label: string;
  onClick: () => void | Promise<void>;
  disabled?: boolean;
  className?: string;
  description?: string;
}

type ResumeAfterLimitActionState = {
  sessionId: string;
  loading: boolean;
  busy: boolean;
  eligibility: ResumeAfterLimitEligibilityResponse | null;
  message: string | null;
  error: string | null;
};
/** 메뉴 항목 리스트 (모바일/데스크탑 공용) */
function MenuItems({
  onCopyId,
  onContinue,
  onRename,
  onMove,
  onDelete,
  hasContinue,
  continueDisabledReason,
  hasRename,
  hasMove,
  hasDelete,
  extraActions,
  className,
}: {
  onCopyId: () => void;
  onContinue?: () => void;
  onRename?: () => void;
  onMove?: () => void;
  onDelete?: () => void;
  hasContinue: boolean;
  continueDisabledReason?: string | null;
  hasRename: boolean;
  hasMove: boolean;
  hasDelete: boolean;
  extraActions: SessionContextMenuExtraAction[];
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
      {hasContinue && onContinue && (
        <>
          <div className="border-t border-border my-1" />
          <button
            className="w-full text-left px-3 py-2 text-sm hover:bg-accent rounded-md disabled:pointer-events-none disabled:opacity-64"
            disabled={!!continueDisabledReason}
            title={continueDisabledReason ?? undefined}
            onClick={onContinue}
          >
            이 세션을 이어서 시작하기
          </button>
        </>
      )}
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
      {extraActions.length > 0 && (
        <>
          <div className="border-t border-border my-1" />
          {extraActions.map((action) => (
            <button
              key={action.label}
              className={cn(
                "w-full text-left px-3 py-2 text-sm hover:bg-accent rounded-md disabled:pointer-events-none disabled:opacity-64",
                action.description && "flex flex-col items-start",
                action.className,
              )}
              disabled={action.disabled}
              title={action.description}
              onClick={() => { void action.onClick(); }}
            >
              {action.description ? (
                <>
                  <span>{action.label}</span>
                  <span className="max-w-56 pt-1 text-xs text-muted-foreground whitespace-normal break-keep" role="status">
                    {action.description}
                  </span>
                </>
              ) : action.label}
            </button>
          ))}
        </>
      )}
      {hasDelete && onDelete && (
        <>
          <div className="border-t border-border my-1" />
          <button
            className="w-full text-left px-3 py-2 text-sm hover:bg-accent rounded-md text-destructive"
            onClick={onDelete}
          >
            삭제
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
  onDeleteSessions,
  onContinueSession,
  getContinueSessionDisabledReason,
  getSessionName,
  extraActions = [],
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
  const [deleteDialog, setDeleteDialog] = useState<{
    open: boolean;
    sessionIds: string[];
  }>({ open: false, sessionIds: [] });
  const [continueError, setContinueError] = useState<string | null>(null);
  const contextSessionId = contextMenu?.sessionId ?? null;
  const [resumeAfterLimit, setResumeAfterLimit] = useState<ResumeAfterLimitActionState | null>(null);

  useEffect(() => {
    if (!contextSessionId) {
      setResumeAfterLimit(null);
      return;
    }

    let current = true;
    setResumeAfterLimit({
      sessionId: contextSessionId,
      loading: true,
      busy: false,
      eligibility: null,
      message: null,
      error: null,
    });
    void getResumeAfterLimitEligibility(contextSessionId).then(
      (eligibility) => {
        if (!current) return;
        setResumeAfterLimit({
          sessionId: contextSessionId,
          loading: false,
          busy: false,
          eligibility,
          message: null,
          error: null,
        });
      },
      (error: unknown) => {
        if (!current) return;
        setResumeAfterLimit({
          sessionId: contextSessionId,
          loading: false,
          busy: false,
          eligibility: null,
          message: null,
          error: error instanceof Error ? error.message : String(error),
        });
      },
    );
    return () => { current = false; };
  }, [contextSessionId]);

  const activeResumeAfterLimit = resumeAfterLimit?.sessionId === contextSessionId
    ? resumeAfterLimit
    : null;
  const currentResumeSchedule = activeResumeAfterLimit?.eligibility?.schedule ?? null;

  const handleScheduleResumeAfterLimit = useCallback(async () => {
    if (
      !contextSessionId
      || !activeResumeAfterLimit
      || !activeResumeAfterLimit.eligibility?.eligible
      || activeResumeAfterLimit.eligibility.schedule
      || activeResumeAfterLimit.busy
      || activeResumeAfterLimit.loading
    ) return;

    setResumeAfterLimit({ ...activeResumeAfterLimit, busy: true, message: null, error: null });
    try {
      const schedule = await scheduleResumeAfterLimit(contextSessionId);
      setResumeAfterLimit((current) => current?.sessionId === contextSessionId
        ? {
            ...current,
            busy: false,
            eligibility: current.eligibility
              ? { ...current.eligibility, schedule: {
                  schedule_id: schedule.schedule_id,
                  run_at: schedule.run_at,
                  status: schedule.status,
                } }
              : current.eligibility,
            message: resumeScheduleMessage(schedule.run_at),
            error: null,
          }
        : current);
    } catch (error) {
      setResumeAfterLimit((current) => current?.sessionId === contextSessionId
        ? {
            ...current,
            busy: false,
            message: null,
            error: error instanceof Error ? error.message : String(error),
          }
        : current);
    }
  }, [activeResumeAfterLimit, contextSessionId]);

  const handleCancelResumeAfterLimit = useCallback(async () => {
    if (!contextSessionId || !currentResumeSchedule || !activeResumeAfterLimit || activeResumeAfterLimit.busy) return;
    setResumeAfterLimit({ ...activeResumeAfterLimit, busy: true, message: null, error: null });
    try {
      const response = await deleteClaudeSchedule(contextSessionId, currentResumeSchedule.schedule_id);
      setResumeAfterLimit((current) => current?.sessionId === contextSessionId
        ? {
            ...current,
            busy: false,
            eligibility: current.eligibility
              ? { ...current.eligibility, schedule: response.deleted ? null : current.eligibility.schedule }
              : current.eligibility,
            message: response.deleted ? "재개 예약을 취소했습니다." : null,
            error: response.deleted ? null : "이미 재개 처리가 시작되어 취소할 수 없습니다.",
          }
        : current);
    } catch (error) {
      setResumeAfterLimit((current) => current?.sessionId === contextSessionId
        ? {
            ...current,
            busy: false,
            message: null,
            error: error instanceof Error ? error.message : String(error),
          }
        : current);
    }
  }, [activeResumeAfterLimit, contextSessionId, currentResumeSchedule]);

  const resumeDescription = activeResumeAfterLimit === null
    ? "예약 가능 여부 확인 중…"
    : activeResumeAfterLimit.loading
      ? "예약 가능 여부 확인 중…"
      : activeResumeAfterLimit.error
        ?? activeResumeAfterLimit.message
        ?? (currentResumeSchedule
          ? resumeScheduleMessage(currentResumeSchedule.run_at)
          : activeResumeAfterLimit.eligibility?.eligible
            ? activeResumeAfterLimit.eligibility.resets_at
              ? `${resumeScheduleTime(activeResumeAfterLimit.eligibility.resets_at)} 해제 예정`
              : null
            : activeResumeAfterLimit.eligibility?.reason ?? null);
  const resumeExtraActions: SessionContextMenuExtraAction[] = [
    {
      label: "리밋이 풀릴 때 재개",
      onClick: handleScheduleResumeAfterLimit,
      disabled: !activeResumeAfterLimit
        || activeResumeAfterLimit.loading
        || activeResumeAfterLimit.busy
        || !activeResumeAfterLimit.eligibility?.eligible
        || currentResumeSchedule !== null,
      description: resumeDescription ?? undefined,
    },
    ...(currentResumeSchedule
      ? [{
          label: "재개 예약 취소",
          onClick: handleCancelResumeAfterLimit,
          disabled: activeResumeAfterLimit?.busy ?? true,
        }]
      : []),
  ];
  const menuExtraActions = [...extraActions, ...resumeExtraActions];

  const continueDisabledReason =
    contextMenu && onContinueSession
      ? getContinueSessionDisabledReason?.(contextMenu.sessionId) ?? null
      : null;

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
    try {
      await onRenameSession(sessionId, renameInput.trim() || null);
    } catch {
      // 호출 표면이 오류 UX를 소유한다. v1은 기존처럼 조용히 rollback하고,
      // v3는 planner action이 toast를 표시한다.
    }
  }, [onRenameSession, renameDialog, renameInput]);

  const handleMoveClick = useCallback(() => {
    if (!contextMenu || !onMoveSessions) return;
    const sessionIds = resolveSessionIds(contextMenu.sessionId);
    onClose();
    setMoveFolderDialog({ open: true, sessionIds, selectedFolderId: null });
  }, [contextMenu, onMoveSessions, onClose, resolveSessionIds]);

  const handleContinueClick = useCallback(async () => {
    if (!contextMenu || !onContinueSession) return;
    const { sessionId } = contextMenu;
    const disabledReason = getContinueSessionDisabledReason?.(sessionId) ?? null;
    if (disabledReason) return;
    onClose();
    try {
      setContinueError(null);
      await onContinueSession(sessionId);
    } catch (err) {
      setContinueError(err instanceof Error ? err.message : String(err));
    }
  }, [contextMenu, getContinueSessionDisabledReason, onClose, onContinueSession]);

  const handleMoveFolderSubmit = useCallback(async () => {
    if (!onMoveSessions) return;
    const { sessionIds, selectedFolderId } = moveFolderDialog;
    setMoveFolderDialog((d) => ({ ...d, open: false }));
    await onMoveSessions(sessionIds, selectedFolderId);
  }, [onMoveSessions, moveFolderDialog]);

  const handleDeleteClick = useCallback(() => {
    if (!contextMenu || !onDeleteSessions) return;
    const sessionIds = resolveSessionIds(contextMenu.sessionId);
    onClose();
    setDeleteDialog({ open: true, sessionIds });
  }, [contextMenu, onDeleteSessions, onClose, resolveSessionIds]);

  const handleDeleteSubmit = useCallback(async () => {
    if (!onDeleteSessions) return;
    const { sessionIds } = deleteDialog;
    setDeleteDialog((d) => ({ ...d, open: false }));
    await onDeleteSessions(sessionIds);
  }, [deleteDialog, onDeleteSessions]);

  return (
    <>
      {/* 컨텍스트 메뉴 — 모바일: Dialog 하단 시트, 데스크탑: base-ui Menu */}
      {isMobile ? (
        <Dialog open={contextMenu !== null} onOpenChange={(open) => { if (!open) onClose(); }}>
          <DialogPopup bottomStickOnMobile className="max-w-sm" showCloseButton={false}>
            <div className="py-2 px-2">
              <MenuItems
                onCopyId={handleCopyId}
                onContinue={onContinueSession ? handleContinueClick : undefined}
                onRename={onRenameSession ? handleRenameClick : undefined}
                onMove={onMoveSessions ? handleMoveClick : undefined}
                onDelete={onDeleteSessions ? handleDeleteClick : undefined}
                hasContinue={!!onContinueSession}
                continueDisabledReason={continueDisabledReason}
                hasRename={!!onRenameSession}
                hasMove={!!onMoveSessions}
                hasDelete={!!onDeleteSessions}
                extraActions={menuExtraActions}
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
            {!!onContinueSession && (
              <>
                <MenuSeparator />
                <MenuItem
                  disabled={!!continueDisabledReason}
                  title={continueDisabledReason ?? undefined}
                  onClick={handleContinueClick}
                >
                  이 세션을 이어서 시작하기
                </MenuItem>
              </>
            )}
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
            {menuExtraActions.length > 0 && (
              <>
                <MenuSeparator />
                {menuExtraActions.map((action) => (
                  <MenuItem
                    key={action.label}
                    disabled={action.disabled}
                    title={action.description}
                    onClick={() => { void action.onClick(); }}
                    className={cn(
                      action.className,
                      action.description && "flex-col items-start gap-0 py-2",
                    )}
                  >
                    {action.description ? (
                      <>
                        <span>{action.label}</span>
                        <span className="max-w-56 whitespace-normal break-keep text-xs text-muted-foreground" role="status">
                          {action.description}
                        </span>
                      </>
                    ) : action.label}
                  </MenuItem>
                ))}
              </>
            )}
            {!!onDeleteSessions && (
              <>
                <MenuSeparator />
                <MenuItem onClick={handleDeleteClick} className="text-destructive">
                  삭제
                </MenuItem>
              </>
            )}
          </MenuPopup>
        </Menu>
      )}

      {onRenameSession ? (
        <RenameSessionDialog
          open={renameDialog.open}
          input={renameInput}
          onOpenChange={(open) => setRenameDialog((dialog) => ({ ...dialog, open }))}
          onInputChange={setRenameInput}
          onSubmit={() => { void handleRenameSubmit(); }}
        />
      ) : null}

      {/* 이어 시작 실패 모달 */}
      {onContinueSession && (
        <Dialog
          open={continueError !== null}
          onOpenChange={(open) => { if (!open) setContinueError(null); }}
        >
          <DialogPopup className="max-w-sm">
            <DialogHeader>
              <DialogTitle>세션 이어서 시작 실패</DialogTitle>
            </DialogHeader>
            <DialogPanel>
              <p className="text-sm text-muted-foreground">
                {continueError}
              </p>
            </DialogPanel>
            <DialogFooter variant="bare">
              <Button
                type="button"
                onClick={() => setContinueError(null)}
              >
                확인
              </Button>
            </DialogFooter>
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

      {/* 삭제 확인 모달 */}
      {onDeleteSessions && (
        <Dialog
          open={deleteDialog.open}
          onOpenChange={(open) => setDeleteDialog((d) => ({ ...d, open }))}
        >
          <DialogPopup className="max-w-sm">
            <DialogHeader>
              <DialogTitle>세션 삭제</DialogTitle>
            </DialogHeader>
            <DialogPanel>
              <p className="text-sm text-muted-foreground">
                선택한 세션 {deleteDialog.sessionIds.length}개를 삭제합니다.
              </p>
            </DialogPanel>
            <DialogFooter variant="bare">
              <Button
                type="button"
                variant="outline"
                onClick={() => setDeleteDialog((d) => ({ ...d, open: false }))}
              >
                취소
              </Button>
              <Button type="button" variant="destructive" onClick={handleDeleteSubmit}>
                삭제
              </Button>
            </DialogFooter>
          </DialogPopup>
        </Dialog>
      )}
    </>
  );
}

function resumeScheduleMessage(runAt: string): string {
  return `${resumeScheduleTime(runAt)} 재개 예약`;
}

function resumeScheduleTime(value: string): string {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return "재개 예약";
  const hour = String(date.getHours()).padStart(2, "0");
  const minute = String(date.getMinutes()).padStart(2, "0");
  return `${date.getMonth() + 1}월 ${date.getDate()}일 ${hour}:${minute}`;
}

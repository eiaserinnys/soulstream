import { intlLocale, resolveLanguage, type Language } from "@soulstream/i18n";
import { useTranslation } from "react-i18next";
import {SessionContinueErrorDialog,SessionDeleteDialog} from "./SessionDialogViews";
import { useState, useCallback, useEffect, useMemo } from "react";
import { useIsMobile } from "../hooks/use-mobile";
import { Dialog, DialogPopup } from "./ui/dialog";
import { Menu, MenuPopup } from "./ui/menu";
import { cn } from "../lib/cn";
import { SessionMenuItems } from "./SessionMenuItems";
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
  /** Keep a menu invoked inside an existing dialog within that dialog surface. */
  portalContainer?: HTMLElement;
}

export const sessionRuntimeActions = {getResumeAfterLimitEligibility, scheduleResumeAfterLimit, deleteClaudeSchedule};
export interface SessionContextMenuProps {
  actions?: typeof sessionRuntimeActions;
  /** 현재 열린 컨텍스트 메뉴 위치/대상. null이면 닫힘 */
  contextMenu: SessionContextMenuState | null;
  /** 메뉴 닫기 콜백 */
  onClose: () => void;
  /** 세션 이름 변경 콜백. 미지정 시 이름 변경 메뉴 비활성화 */
  onRenameSession?: (sessionId: string, displayName: string | null) => Promise<void>;
  /** 세션 폴더 이동 콜백. 미지정 시 폴더 이동 메뉴 비활성화 */
  onRequestMoveSession?: (sessionId: string) => void;
  getMoveSessionDisabledReason?: (sessionId: string) => string | null;
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
  closeOnClick?: boolean;
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
export function SessionContextMenu({
  actions: runtimeActions = sessionRuntimeActions,
  contextMenu,
  onClose,
  onRenameSession,
  onRequestMoveSession,
  getMoveSessionDisabledReason,
  onDeleteSessions,
  onContinueSession,
  getContinueSessionDisabledReason,
  getSessionName,
  extraActions = [],
  resolveSessionIds,
}: SessionContextMenuProps) {
  const { t, i18n } = useTranslation();
  const language = resolveLanguage(i18n.resolvedLanguage, []);
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
    void runtimeActions.getResumeAfterLimitEligibility(contextSessionId).then(
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
      const schedule = await runtimeActions.scheduleResumeAfterLimit(contextSessionId);
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
            message: resumeScheduleMessage(schedule.run_at, language, t),
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
  }, [activeResumeAfterLimit, contextSessionId, language, t]);

  const handleCancelResumeAfterLimit = useCallback(async () => {
    if (!contextSessionId || !currentResumeSchedule || !activeResumeAfterLimit || activeResumeAfterLimit.busy) return;
    setResumeAfterLimit({ ...activeResumeAfterLimit, busy: true, message: null, error: null });
    try {
      const response = await runtimeActions.deleteClaudeSchedule(contextSessionId, currentResumeSchedule.schedule_id);
      setResumeAfterLimit((current) => current?.sessionId === contextSessionId
        ? {
            ...current,
            busy: false,
            eligibility: current.eligibility
              ? { ...current.eligibility, schedule: response.deleted ? null : current.eligibility.schedule }
              : current.eligibility,
            message: response.deleted ? t("ui.session.resumeCanceled") : null,
            error: response.deleted ? null : t("ui.session.resumeAlreadyStarted"),
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
  }, [activeResumeAfterLimit, contextSessionId, currentResumeSchedule, t]);

  const resetsAt = activeResumeAfterLimit?.eligibility?.resets_at;
  const resetTime = resetsAt
    ? resumeScheduleTime(resetsAt, language)
    : undefined;
  const resumeDescription = !activeResumeAfterLimit || activeResumeAfterLimit.loading
    ? t("ui.session.checkingSchedule")
    : activeResumeAfterLimit.error
      ?? activeResumeAfterLimit.message
      ?? (currentResumeSchedule
        ? resumeScheduleMessage(currentResumeSchedule.run_at, language, t)
        : activeResumeAfterLimit.eligibility?.eligible
          ? resetTime ? t("ui.session.limitResetsAt", { time: resetTime }) : null
          : activeResumeAfterLimit.eligibility?.reason ?? null);
  const resumeExtraActions: SessionContextMenuExtraAction[] = [
    {
      label: t("ui.session.resumeAfterLimit"),
      closeOnClick: false,
      onClick: handleScheduleResumeAfterLimit,
      disabled: !activeResumeAfterLimit
        || activeResumeAfterLimit.loading
        || activeResumeAfterLimit.busy
        || !activeResumeAfterLimit.eligibility?.eligible
        || currentResumeSchedule !== null,
      description: resumeDescription ?? undefined,
    },
    ...[{
          label: t("ui.session.cancelResume"),
          closeOnClick: false,
          onClick: handleCancelResumeAfterLimit,
          disabled: !currentResumeSchedule || (activeResumeAfterLimit?.busy ?? true),
          description: currentResumeSchedule ? undefined : t("ui.session.noScheduledResume"),
        }],
  ];
  const menuExtraActions = [...extraActions, ...resumeExtraActions];

  const continueDisabledReason =
    contextMenu && onContinueSession
      ? getContinueSessionDisabledReason?.(contextMenu.sessionId) ?? null
      : t("ui.session.continueUnsupported");

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
    if (!contextMenu || !onRequestMoveSession) return;
    if (getMoveSessionDisabledReason?.(contextMenu.sessionId)) return;
    onClose();
    onRequestMoveSession(contextMenu.sessionId);
  }, [contextMenu, onRequestMoveSession, getMoveSessionDisabledReason, onClose]);

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

  const moveReason = !onRequestMoveSession ? t("ui.session.moveUnsupported")
    : contextMenu ? getMoveSessionDisabledReason?.(contextMenu.sessionId) : null;
  const actions = [
    {label:t("ui.session.copyId"),onClick:handleCopyId},
    {label:t("ui.session.continue"),onClick:handleContinueClick,
      disabled:!!continueDisabledReason,description:continueDisabledReason ?? undefined},
    ...menuExtraActions,
    {label:t("ui.session.rename"),onClick:handleRenameClick,disabled:!onRenameSession,
      description:!onRenameSession ? t("ui.session.renameUnsupported") : undefined},
    {label:t("ui.session.move"),onClick:handleMoveClick,disabled:!!moveReason,
      description:moveReason ?? undefined},
    {label:t("ui.common.delete"),onClick:handleDeleteClick,disabled:!onDeleteSessions,className:"text-destructive",
      description:!onDeleteSessions ? t("ui.session.deleteUnsupported") : undefined},
  ];
  return (
    <>
      {/* 컨텍스트 메뉴 — 모바일: Dialog 하단 시트, 데스크탑: base-ui Menu */}
      {isMobile ? (
        <Dialog open={contextMenu !== null} onOpenChange={(open) => { if (!open) onClose(); }}>
          <DialogPopup bottomStickOnMobile className="max-w-sm" showCloseButton={false}>
            <div className="py-2 px-2">
              <SessionMenuItems actions={actions} mobile />
            </div>
          </DialogPopup>
        </Dialog>
      ) : (
        <Menu
          open={contextMenu !== null}
          onOpenChange={(open, details) => {
            if (!open && details.reason === "trigger-hover") {
              details.cancel();
              return;
            }
            if (!open) onClose();
          }}
          modal={false}
        >
          <MenuPopup
            anchor={desktopAnchor}
            portalContainer={contextMenu?.portalContainer}
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
            <SessionMenuItems actions={actions} />
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

      {onContinueSession ? <SessionContinueErrorDialog error={continueError} onClose={() => setContinueError(null)}/> : null}
      {onDeleteSessions ? <SessionDeleteDialog open={deleteDialog.open} count={deleteDialog.sessionIds.length} onOpenChange={open=>setDeleteDialog(d=>({...d,open}))} onConfirm={handleDeleteSubmit}/> : null}

    </>
  );
}

function resumeScheduleMessage(
  runAt: string,
  language: Language,
  t: ReturnType<typeof useTranslation>["t"],
): string {
  const time = resumeScheduleTime(runAt, language);
  return time ? t("ui.session.resumeScheduled", { time }) : t("ui.session.scheduledResume");
}

function resumeScheduleTime(value: string, language: Language): string | undefined {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return undefined;
  const locale = intlLocale(language);
  const day = date.toLocaleDateString(locale, { month: "short", day: "numeric" });
  const time = date.toLocaleTimeString(locale, language !== "en"
    ? { hour: "2-digit", minute: "2-digit", hourCycle: "h23" }
    : { hour: "numeric", minute: "2-digit" });
  return `${day} ${time}`;
}

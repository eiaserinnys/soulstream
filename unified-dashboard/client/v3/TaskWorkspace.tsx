import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import {
  ChatView,
  DashboardIconCap,
  MarkdownDocumentPanel,
  useDashboardStore,
  useGlassSurface,
  type CatalogFolder,
  type SessionReviewAcknowledgeResult,
  type SessionSummary,
} from "@seosoyoung/soul-ui";
import { X } from "lucide-react";

import type { PlannerTask } from "./planner-data";
import { sessionPanelTitle } from "./v3-session-panel-model";
import type { TaskMoveTarget } from "./task-move-targets";
import type { PageSessionDefaults } from "./task-workspace-api";
import {
  DEFAULT_WORKSPACE_SPLIT,
  clampWorkspaceSplit,
  type RunSessionLoadState,
  workspaceInspectorKind,
  workspaceSplitForKey,
} from "./task-workspace-model";
import { TaskDetailPane } from "./TaskDetailPane";
import type { TaskSectionFocusRequest } from "./TaskSectionNavigation";
import { TaskBoardWorkspace } from "./TaskBoardWorkspace";
import { V3SessionReviewBanner } from "./V3SessionReviewBanner";
import type { MobilePlannerTab } from "./mobile-planner-state";

export function TaskWorkspace({
  task,
  taskResolutionError,
  projectTitle,
  projectFolderId,
  folders,
  contextInvalidationKey,
  sessions,
  runSessionLoadStates,
  runHistoryTotal,
  runHistoryHasMore,
  runHistoryLoading,
  onLoadMoreRuns,
  activeSession,
  focusRequest,
  onFocusRequestHandled,
  chatOpen,
  chatInputDisabled,
  fileUploadUrl,
  sessionDefaults,
  mobileMode,
  mobileTab,
  taskMoveTargets,
  taskInToday,
  onReturnToToday,
  onToggleTaskToday,
  onCloseWorkspace,
  onCloseChat,
  onOpenSession,
  onRenameTaskTitle,
  onSaveDescription,
  onRenameSession,
  onDeleteSessions,
  onMoveSession,
  onTaskBlocksChanged,
  onAcknowledgedReview,
}: {
  task: PlannerTask | null;
  taskResolutionError: string | null;
  projectTitle: string;
  projectFolderId: string | null;
  folders: readonly CatalogFolder[];
  contextInvalidationKey: number;
  sessions: readonly SessionSummary[];
  runSessionLoadStates: ReadonlyMap<string, RunSessionLoadState>;
  runHistoryTotal: number;
  runHistoryHasMore: boolean;
  runHistoryLoading: boolean;
  onLoadMoreRuns(): Promise<void>;
  activeSession: SessionSummary | undefined;
  focusRequest: TaskSectionFocusRequest | null;
  onFocusRequestHandled(requestId: number): void;
  chatOpen: boolean;
  chatInputDisabled: boolean;
  fileUploadUrl: string | undefined;
  sessionDefaults: PageSessionDefaults | null;
  mobileMode: boolean;
  mobileTab: MobilePlannerTab;
  taskMoveTargets: readonly PlannerTask[];
  taskInToday: boolean;
  onReturnToToday(): void;
  onToggleTaskToday(): Promise<void>;
  onCloseWorkspace(): void;
  onCloseChat(): void;
  onOpenSession(session: SessionSummary): void;
  onRenameTaskTitle(title: string): Promise<string>;
  onSaveDescription(markdown: string): Promise<void>;
  onRenameSession(sessionId: string, displayName: string | null): Promise<void>;
  onDeleteSessions(sessionIds: string[]): Promise<void>;
  onMoveSession(sessionId: string, targetTask: TaskMoveTarget): Promise<void>;
  onTaskBlocksChanged(blocks: PlannerTask["blocks"]): void;
  onAcknowledgedReview(result: SessionReviewAcknowledgeResult): void;
}) {
  const workspaceRef = useRef<HTMLDivElement>(null);
  const chatSurfaceRef = useRef<HTMLElement>(null);
  const draggingPointer = useRef<number | null>(null);
  const [splitPercent, setSplitPercent] = useState(DEFAULT_WORKSPACE_SPLIT);
  const [boardOpen, setBoardOpen] = useState(false);
  const [visibleTitle, setVisibleTitle] = useState(task?.page.title ?? "");
  const chatWebglActive = useGlassSurface(chatSurfaceRef, { enabled: chatOpen && !boardOpen });
  const activeSessionKey = useDashboardStore((state) => state.activeSessionKey);
  const activeBoardDocumentId = useDashboardStore((state) => state.activeBoardDocumentId);
  const inspectorKind = workspaceInspectorKind(activeBoardDocumentId, activeSessionKey);

  useEffect(() => {
    setBoardOpen(false);
    setVisibleTitle(task?.page.title ?? "");
  }, [task?.page.id, task?.page.title]);

  useEffect(() => {
    if (!chatOpen) draggingPointer.current = null;
  }, [chatOpen]);

  const updateFromPointer = (event: ReactPointerEvent<HTMLDivElement>) => {
    const workspace = workspaceRef.current;
    if (!workspace) return;
    const bounds = workspace.getBoundingClientRect();
    setSplitPercent(clampWorkspaceSplit(((event.clientX - bounds.left) / bounds.width) * 100));
  };
  const beginDrag = (event: ReactPointerEvent<HTMLDivElement>) => {
    event.preventDefault();
    draggingPointer.current = event.pointerId;
    event.currentTarget.setPointerCapture(event.pointerId);
    updateFromPointer(event);
  };
  const moveDrag = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (draggingPointer.current === event.pointerId) updateFromPointer(event);
  };
  const finishDrag = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (draggingPointer.current !== event.pointerId) return;
    draggingPointer.current = null;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
  };

  const closeWorkspaceInspector = () => {
    if (inspectorKind === "document") useDashboardStore.getState().setActiveBoardDocument(null);
    onCloseChat();
  };

  const divider = (label: string) => (
    <div
      className="v3-workspace-divider"
      role="separator"
      tabIndex={0}
      aria-label={label}
      aria-orientation="vertical"
      aria-valuemin={25}
      aria-valuemax={75}
      aria-valuenow={Math.round(splitPercent)}
      onPointerDown={beginDrag}
      onPointerMove={moveDrag}
      onPointerUp={finishDrag}
      onPointerCancel={finishDrag}
      onDoubleClick={() => setSplitPercent(DEFAULT_WORKSPACE_SPLIT)}
      onKeyDown={(event) => {
        const next = workspaceSplitForKey(splitPercent, event.key);
        if (next === null) return;
        event.preventDefault();
        setSplitPercent(next);
      }}
    ><span /></div>
  );

  if (!task) {
    return (
      <div className="v3-workspace-scrim is-chat-open" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) onCloseWorkspace(); }}>
        <div
          ref={workspaceRef}
          className="v3-workspace is-chat-open"
          data-mobile-view={mobileMode ? mobileTab : undefined}
          style={!mobileMode ? { gridTemplateColumns: `minmax(0, calc(${splitPercent}% - 8px)) 16px minmax(0, 1fr)` } : undefined}
        >
          <section className="v3-detail-pane border border-glass-border glass-strong glass-chrome lg-rim" data-testid="v3-standalone-task-empty" aria-label="빈 업무 창">
            <header className="v3-workspace-toolbar">
              <strong>업무</strong>
              <span className="v3-spacer" />
              <DashboardIconCap label="업무 창 닫기" onClick={onCloseWorkspace}>
                <X className="h-4 w-4" aria-hidden="true" />
              </DashboardIconCap>
            </header>
            <div className="v3-chat-empty">
              <strong>{taskResolutionError ?? "연결된 업무가 없습니다."}</strong>
              <p>{taskResolutionError
                ? "업무 귀속을 다시 확인해 주세요. 이 세션의 채팅은 그대로 확인할 수 있습니다."
                : "이 세션의 채팅은 그대로 확인할 수 있습니다."}</p>
            </div>
          </section>
          {divider("업무와 채팅 너비 조절")}
          <section
            ref={chatSurfaceRef}
            className="v3-chat-pane border border-glass-border glass-strong glass-chrome lg-rim"
            data-liquid-glass-webgl={chatWebglActive ? "true" : undefined}
            data-testid="v3-standalone-session-chat"
            aria-label="세션 채팅"
          >
            <header className="v3-chat-header">
              <div className="v3-chat-session-title"><strong>{activeSession ? sessionPanelTitle(activeSession) : "세션"}</strong></div>
              <span className={`v3-chat-status v3-chat-status--${activeSession?.status ?? "unknown"}`}>{activeSession?.status === "running" ? "실행 중" : "완료"}</span>
              <DashboardIconCap label="채팅 닫기" onClick={onCloseWorkspace}>
                <X className="h-4 w-4" aria-hidden="true" />
              </DashboardIconCap>
            </header>
            {activeSession ? <V3SessionReviewBanner session={activeSession} onAcknowledged={onAcknowledgedReview} /> : null}
            <div className="v3-chat-content">
              {activeSession ? <ChatView chatInputDisabled={chatInputDisabled} fileUploadUrl={fileUploadUrl} showHeader={false} /> : <div className="v3-chat-empty"><strong>세션을 찾을 수 없습니다.</strong></div>}
            </div>
          </section>
        </div>
      </div>
    );
  }

  if (boardOpen) {
    return (
      <TaskBoardWorkspace
        task={visibleTitle === task.page.title ? task : { ...task, page: { ...task.page, title: visibleTitle } }}
        projectFolderId={projectFolderId}
        projectTitle={projectTitle}
        sessions={sessions}
        runSessionLoadStates={runSessionLoadStates}
        activeSession={activeSession}
        chatInputDisabled={chatInputDisabled}
        fileUploadUrl={fileUploadUrl}
        mobileMode={mobileMode}
        mobileTab={mobileTab}
        taskMoveTargets={taskMoveTargets}
        onClose={() => setBoardOpen(false)}
        onOpenSession={onOpenSession}
        onAcknowledgedReview={onAcknowledgedReview}
      />
    );
  }

  return (
    <div className={`v3-workspace-scrim${chatOpen ? " is-chat-open" : ""}`} role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) onCloseWorkspace(); }}>
      <div
        ref={workspaceRef}
        className={`v3-workspace${chatOpen ? " is-chat-open" : ""}`}
        data-mobile-view={mobileMode ? mobileTab : undefined}
        style={chatOpen && !mobileMode ? { gridTemplateColumns: `minmax(0, calc(${splitPercent}% - 8px)) 16px minmax(0, 1fr)` } : undefined}
      >
        <TaskDetailPane
          task={visibleTitle === task.page.title ? task : { ...task, page: { ...task.page, title: visibleTitle } }}
          projectFolderId={projectFolderId}
          folders={folders}
          contextInvalidationKey={contextInvalidationKey}
          sessions={sessions}
          runSessionLoadStates={runSessionLoadStates}
          runHistoryTotal={runHistoryTotal}
          runHistoryHasMore={runHistoryHasMore}
          runHistoryLoading={runHistoryLoading}
          activeSessionId={activeSessionKey}
          focusRequest={focusRequest}
          onFocusRequestHandled={onFocusRequestHandled}
          onLoadMoreRuns={onLoadMoreRuns}
          sessionDefaults={sessionDefaults}
          taskMoveTargets={taskMoveTargets}
          taskInToday={taskInToday}
          onReturnToToday={onReturnToToday}
          onToggleTaskToday={onToggleTaskToday}
          onOpenBoard={() => {
            const state = useDashboardStore.getState();
            state.setActiveBoardDocument(null);
            state.setActiveCustomView(null);
            setBoardOpen(true);
          }}
          onOpenSession={onOpenSession}
          onRenameTaskTitle={async (title) => {
            const renamedTitle = await onRenameTaskTitle(title);
            setVisibleTitle(renamedTitle);
          }}
          onSaveDescription={onSaveDescription}
          onRenameSession={onRenameSession}
          onDeleteSessions={onDeleteSessions}
          onMoveSession={onMoveSession}
          onTaskBlocksChanged={onTaskBlocksChanged}
        />
        {chatOpen ? (
          <>
            {divider("상세와 채팅 너비 조절")}
            <section
              ref={chatSurfaceRef}
              className="v3-chat-pane border border-glass-border glass-strong glass-chrome lg-rim"
              data-liquid-glass-webgl={chatWebglActive ? "true" : undefined}
              aria-label={inspectorKind === "document" ? "마크다운 문서" : "세션 채팅"}
            >
              <header className="v3-chat-header">
                {inspectorKind === "document" ? (
                  <div><small>{projectTitle} › {visibleTitle}</small><strong>마크다운 문서</strong></div>
                ) : (
                  <div className="v3-chat-session-title"><strong>{activeSession ? sessionPanelTitle(activeSession) : "선택된 세션 없음"}</strong></div>
                )}
                {inspectorKind !== "document" ? <span className={`v3-chat-status v3-chat-status--${activeSession?.status ?? "unknown"}`}>{activeSession ? activeSession.status === "running" ? "실행 중" : "완료" : "대기"}</span> : null}
              </header>
              {inspectorKind === "chat" && activeSession ? <V3SessionReviewBanner session={activeSession} onAcknowledged={onAcknowledgedReview} /> : null}
              {inspectorKind === "document" ? (
                <div className="v3-board-document-content"><MarkdownDocumentPanel /></div>
              ) : <div className="v3-chat-content">
                {inspectorKind === "chat" && activeSession ? (
                  <ChatView chatInputDisabled={chatInputDisabled} fileUploadUrl={fileUploadUrl} showHeader={false} />
                ) : (
                  <div className="v3-chat-empty" data-testid="v3-chat-empty">
                    <span className="v3-emoji" aria-hidden="true">💬</span>
                    <strong>선택된 세션이 없습니다.</strong>
                    <p>업무 탭에서 세션을 선택하거나 새 세션을 시작하세요.</p>
                    <button type="button" className="v3-button v3-button--soft" onClick={closeWorkspaceInspector}>업무 탭으로</button>
                  </div>
                )}
              </div>}
            </section>
          </>
        ) : null}
      </div>
    </div>
  );
}

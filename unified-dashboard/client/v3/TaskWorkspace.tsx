import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import {
  ChatView,
  MarkdownDocumentPanel,
  useDashboardStore,
  useGlassSurface,
  type SessionReviewAcknowledgeResult,
  type SessionSummary,
} from "@seosoyoung/soul-ui";

import type { PlannerTask } from "./planner-data";
import type { PageSessionDefaults } from "./task-workspace-api";
import {
  DEFAULT_WORKSPACE_SPLIT,
  buildRunTree,
  clampWorkspaceSplit,
  type RunSessionLoadState,
  workspaceSplitForKey,
} from "./task-workspace-model";
import { TaskDetailPane } from "./TaskDetailPane";
import { TaskBoardPane } from "./TaskBoardPane";
import { V3SessionReviewBanner } from "./V3SessionReviewBanner";
import type { MobilePlannerTab } from "./mobile-planner-state";

export function TaskWorkspace({
  task,
  projectTitle,
  projectFolderId,
  sessions,
  runSessionLoadStates,
  runHistoryTotal,
  runHistoryHasMore,
  runHistoryLoading,
  onLoadMoreRuns,
  activeSession,
  chatOpen,
  chatInputDisabled,
  fileUploadUrl,
  sessionDefaults,
  mobileMode,
  mobileTab,
  taskMoveTargets,
  onReturnToToday,
  onCloseWorkspace,
  onCloseChat,
  onOpenSession,
  onSaveDescription,
  onPromoteDocument,
  onUnmountDocument,
  onRenameSession,
  onDeleteSessions,
  onMoveSession,
  onTaskBlocksChanged,
  onAcknowledgedReview,
}: {
  task: PlannerTask;
  projectTitle: string;
  projectFolderId: string | null;
  sessions: readonly SessionSummary[];
  runSessionLoadStates: ReadonlyMap<string, RunSessionLoadState>;
  runHistoryTotal: number;
  runHistoryHasMore: boolean;
  runHistoryLoading: boolean;
  onLoadMoreRuns(): void;
  activeSession: SessionSummary | undefined;
  chatOpen: boolean;
  chatInputDisabled: boolean;
  fileUploadUrl: string | undefined;
  sessionDefaults: PageSessionDefaults | null;
  mobileMode: boolean;
  mobileTab: MobilePlannerTab;
  taskMoveTargets: readonly PlannerTask[];
  onReturnToToday(): void;
  onCloseWorkspace(): void;
  onCloseChat(): void;
  onOpenSession(session: SessionSummary): void;
  onSaveDescription(markdown: string): Promise<void>;
  onPromoteDocument(blockId: string): Promise<void>;
  onUnmountDocument(blockId: string): Promise<void>;
  onRenameSession(sessionId: string, displayName: string | null): Promise<void>;
  onDeleteSessions(sessionIds: string[]): Promise<void>;
  onMoveSession(sessionId: string, targetTask: PlannerTask): Promise<void>;
  onTaskBlocksChanged(): void;
  onAcknowledgedReview(result: SessionReviewAcknowledgeResult): void;
}) {
  const workspaceRef = useRef<HTMLDivElement>(null);
  const chatSurfaceRef = useRef<HTMLElement>(null);
  const draggingPointer = useRef<number | null>(null);
  const [splitPercent, setSplitPercent] = useState(DEFAULT_WORKSPACE_SPLIT);
  const [boardOpen, setBoardOpen] = useState(false);
  const chatWebglActive = useGlassSurface(chatSurfaceRef, { enabled: chatOpen && !boardOpen });
  const activeSessionKey = useDashboardStore((state) => state.activeSessionKey);
  const activeBoardDocumentId = useDashboardStore((state) => state.activeBoardDocumentId);

  useEffect(() => { setBoardOpen(false); }, [task.page.id]);

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

  const closeBoardInspector = () => {
    const state = useDashboardStore.getState();
    state.clearActiveSession();
    state.setActiveBoardDocument(null);
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

  const boardInspector = activeBoardDocumentId ? (
    <section
      ref={chatSurfaceRef}
      className="v3-chat-pane v3-board-inspector border border-glass-border glass-strong glass-chrome lg-rim"
      data-liquid-glass-webgl={chatWebglActive ? "true" : undefined}
      data-testid="v3-board-document-panel"
      aria-label="업무 보드 문서"
    >
      <header className="v3-chat-header">
        <div><small>{projectTitle} › {task.page.title}</small><strong>마크다운 문서</strong></div>
        <button type="button" aria-label="보드로 돌아가기" onClick={closeBoardInspector}>×</button>
      </header>
      <div className="v3-board-document-content"><MarkdownDocumentPanel /></div>
    </section>
  ) : activeSessionKey && activeSession ? (
    <section
      ref={chatSurfaceRef}
      className="v3-chat-pane v3-board-inspector border border-glass-border glass-strong glass-chrome lg-rim"
      data-liquid-glass-webgl={chatWebglActive ? "true" : undefined}
      data-testid="v3-board-chat-panel"
      aria-label="업무 보드 세션 채팅"
    >
      <header className="v3-chat-header">
        <div><small>{projectTitle} › {task.page.title}</small><strong>{activeSession.displayName ?? activeSession.agentName ?? "세션"}</strong></div>
        <span className={`v3-chat-status v3-chat-status--${activeSession.status}`}>{activeSession.status === "running" ? "실행 중" : "완료"}</span>
        <button type="button" aria-label="보드로 돌아가기" onClick={closeBoardInspector}>×</button>
      </header>
      <V3SessionReviewBanner session={activeSession} onAcknowledged={onAcknowledgedReview} />
      <div className="v3-chat-content">
        <ChatView chatInputDisabled={chatInputDisabled} fileUploadUrl={fileUploadUrl} showHeader={false} />
      </div>
    </section>
  ) : (
    <section
      ref={chatSurfaceRef}
      className="v3-chat-pane v3-board-inspector border border-glass-border glass-strong glass-chrome lg-rim"
      data-liquid-glass-webgl={chatWebglActive ? "true" : undefined}
      data-testid="v3-board-inspector-empty"
      aria-label="업무 보드 선택 항목"
    >
      <div className="v3-chat-empty">
        <span className="v3-emoji" aria-hidden="true">🧭</span>
        <strong>보드에서 항목을 선택하세요.</strong>
        <p>세션은 채팅으로, 마크다운은 문서 패널로 열립니다.</p>
      </div>
    </section>
  );

  return (
    <div className={`v3-workspace-scrim${chatOpen || boardOpen ? " is-chat-open" : ""}`} role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) onCloseWorkspace(); }}>
      <div
        ref={workspaceRef}
        className={`v3-workspace${boardOpen ? " is-board-open" : chatOpen ? " is-chat-open" : ""}${boardOpen && (activeBoardDocumentId || activeSessionKey) ? " has-board-selection" : ""}`}
        data-mobile-view={mobileMode ? mobileTab : undefined}
        style={(chatOpen || boardOpen) && !mobileMode ? { gridTemplateColumns: `minmax(0, calc(${splitPercent}% - 4px)) 8px minmax(0, 1fr)` } : undefined}
      >
        {boardOpen ? (
          <TaskBoardPane
            runbookId={task.runbookId}
            projectFolderId={projectFolderId}
            projectTitle={projectTitle}
            sessions={sessions}
            onClose={() => setBoardOpen(false)}
          />
        ) : (
          <TaskDetailPane
            task={task}
            sessions={sessions}
            runSessionLoadStates={runSessionLoadStates}
            runHistoryTotal={runHistoryTotal}
            runHistoryHasMore={runHistoryHasMore}
            runHistoryLoading={runHistoryLoading}
            onLoadMoreRuns={onLoadMoreRuns}
            sessionDefaults={sessionDefaults}
            taskMoveTargets={taskMoveTargets}
            onReturnToToday={onReturnToToday}
            onOpenBoard={() => {
              setSplitPercent(64);
              setBoardOpen(true);
            }}
            onCloseWorkspace={onCloseWorkspace}
            onOpenSession={onOpenSession}
            onSaveDescription={onSaveDescription}
            onPromoteDocument={onPromoteDocument}
            onUnmountDocument={onUnmountDocument}
            onRenameSession={onRenameSession}
            onDeleteSessions={onDeleteSessions}
            onMoveSession={onMoveSession}
            onTaskBlocksChanged={onTaskBlocksChanged}
          />
        )}
        {boardOpen ? (
          <>
            {divider("보드와 선택 항목 너비 조절")}
            {boardInspector}
          </>
        ) : chatOpen ? (
          <>
            {divider("상세와 채팅 너비 조절")}
            <section
              ref={chatSurfaceRef}
              className="v3-chat-pane border border-glass-border glass-strong glass-chrome lg-rim"
              data-liquid-glass-webgl={chatWebglActive ? "true" : undefined}
              aria-label="Run 채팅"
            >
              <header className="v3-chat-header">
                <div><small>{projectTitle} › {task.page.title}</small><strong>{activeSession ? runLabel(task, activeSession, sessions) : "선택된 run 없음"}</strong></div>
                <span className={`v3-chat-status v3-chat-status--${activeSession?.status ?? "unknown"}`}>{activeSession ? activeSession.status === "running" ? "실행 중" : "완료" : "대기"}</span>
                <button type="button" aria-label="채팅 닫기" onClick={onCloseChat}>×</button>
              </header>
              {activeSession ? <V3SessionReviewBanner session={activeSession} onAcknowledged={onAcknowledgedReview} /> : null}
              <div className="v3-chat-content">
                {activeSession ? (
                  <ChatView chatInputDisabled={chatInputDisabled} fileUploadUrl={fileUploadUrl} showHeader={false} />
                ) : (
                  <div className="v3-chat-empty" data-testid="v3-chat-empty">
                    <span className="v3-emoji" aria-hidden="true">💬</span>
                    <strong>선택된 run이 없습니다.</strong>
                    <p>업무 탭에서 run을 선택하거나 새 세션을 시작하세요.</p>
                    <button type="button" className="v3-button v3-button--soft" onClick={onCloseChat}>업무 탭으로</button>
                  </div>
                )}
              </div>
            </section>
          </>
        ) : null}
      </div>
    </div>
  );
}

function runLabel(
  task: PlannerTask,
  session: SessionSummary | undefined,
  sessions: readonly SessionSummary[],
): string {
  if (!session) return "Run";
  const roots = buildRunTree(task.sessionIds, sessions);
  const root = roots.find((node) => node.session.agentSessionId === session.agentSessionId);
  if (root?.runNumber) return `run #${root.runNumber}`;
  return session.displayName ?? session.agentName ?? "위임 세션";
}
